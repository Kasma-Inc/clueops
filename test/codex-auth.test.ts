import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, readdir, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { compileContract } from '../src/plugin-api/index.js';
import type {
  InvestigationRequest,
  PluginContext,
  JsonObject,
  JsonValue,
  AgentSession,
} from '../src/plugin-api/index.js';
import codexPlugin from '../src/plugins/codex/index.js';
import { authenticationFromFile, authFilePath } from '../src/plugins/codex/auth.js';
import { InvestigationCoordinator } from '../src/core/coordinator.js';
import { InvestigationStore } from '../src/core/store.js';
import { Redactor } from '../src/core/redaction.js';
import { fixture, principal } from './helpers.js';

function authDocument(
  account = 'SYNTHETIC_ACCOUNT_A',
  token = 'ORIGINAL',
  user = 'synthetic-user',
) {
  const jwt = Buffer.from(
    JSON.stringify({
      email: 'synthetic@example.invalid',
      exp: Math.floor(Date.now() / 1000) + 3600,
      'https://api.openai.com/auth': {
        chatgpt_account_id: account,
        chatgpt_plan_type: 'plus',
        chatgpt_user_id: user,
      },
    }),
  ).toString('base64url');
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: 'e30.' + jwt + '.SYNTHETIC',
      access_token: token,
      refresh_token: 'SYNTHETIC_REFRESH_' + token,
      account_id: account,
    },
    last_refresh: new Date().toISOString(),
  };
}

test('retention uses native thread deletion, removes workspaces and preserves shared authentication', async (t) => {
  const f = await setup(t);
  const auth = await f.native();
  t.after(() => auth.release());
  const home = await auth.home();
  const sessionRoot = path.join(home, 'sessions');
  await mkdir(sessionRoot, { recursive: true });
  const threadId = randomUUID(),
    otherId = randomUUID(),
    directoryId = randomUUID();
  await writeFile(path.join(sessionRoot, 'rollout-' + threadId + '.jsonl'), 'expired transcript');
  await writeFile(path.join(sessionRoot, 'rollout-' + otherId + '.jsonl'), 'retained transcript');
  const workspace = path.join(f.context.stateDirectory!, directoryId);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'evidence.txt'), 'expired workspace');
  const launcher = path.join(f.root, 'delete-launcher.mjs');
  const commands = path.join(f.root, 'deleted-threads.log');
  await writeFile(
    launcher,
    `#!${process.execPath}
import { appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
const [operation, force, id] = process.argv.slice(2);
if (operation !== 'delete' || force !== '--force') process.exit(2);
await appendFile(${JSON.stringify(commands)}, id + '\\n');
await rm(path.join(process.env.CODEX_HOME, 'sessions', 'rollout-' + id + '.jsonl'));
`,
    { mode: 0o700 },
  );
  const instance = await codexPlugin.create(
    { model: 'synthetic', authFile: f.file, launcher },
    f.context,
  );
  t.after(() => instance.dispose());
  const before = await readFile(path.join(home, 'auth.json'), 'utf8');
  const original = await readFile(f.file, 'utf8');
  const handle = {
    version: 1,
    instanceId: 'engine',
    targetId: 'a',
    revision: '0'.repeat(64),
    directoryId,
    threadId,
  };
  const cleanup = [{ investigationId: 'expired', sessionHandles: [handle, handle] }];
  await instance.pruneInvestigations!(cleanup);
  await instance.pruneInvestigations!(cleanup);
  assert.equal(
    await readFile(commands, 'utf8'),
    threadId + '\n',
    'native deletion is deduplicated and retryable',
  );
  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(sessionRoot, 'rollout-' + threadId + '.jsonl')), {
    code: 'ENOENT',
  });
  assert.equal(
    await readFile(path.join(sessionRoot, 'rollout-' + otherId + '.jsonl'), 'utf8'),
    'retained transcript',
  );
  assert.equal(await readFile(path.join(home, 'auth.json'), 'utf8'), before);
  assert.equal(await readFile(f.file, 'utf8'), original);
  await assert.rejects(
    instance.pruneInvestigations!([
      { investigationId: 'other', sessionHandles: [{ ...handle, instanceId: 'other-engine' }] },
    ]),
    { code: 'SESSION_SCOPE_MISMATCH' },
  );
});
async function setup(t: TestContext) {
  const f = await fixture(t);
  const file = path.join(f.root, 'auth.json');
  await writeFile(file, JSON.stringify(authDocument()), { mode: 0o600 });
  const secrets: string[] = [];
  const context: PluginContext = {
    instanceId: 'engine',
    configFile: f.configFile,
    stateDirectory: path.join(f.root, 'state', 'plugins', 'engine'),
    resolvePath: (name) => path.resolve(f.root, name),
    registerSecrets: (values) => secrets.push(...values),
  };
  async function native() {
    const value = await authenticationFromFile('./auth.json', context);
    assert.equal(value.kind, 'chatgpt');
    if (value.kind !== 'chatgpt') throw new Error();
    return value;
  }
  return { ...f, file, context, secrets, native };
}
async function collect(session: AgentSession, request: InvestigationRequest) {
  const events = [];
  for await (const event of session.runTurn(request, new AbortController().signal))
    events.push(event);
  return events;
}
function request(scope: InvestigationRequest['scope']): InvestigationRequest {
  return {
    investigationId: 'native-event-' + scope.target.targetId,
    turnId: 'native-turn',
    scope,
    message: {
      address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
      senderId: 'user',
      messageId: 'one',
      targetId: scope.target.targetId,
      text: 'Return a report without running tools.',
    },
  };
}

test('Codex selects exactly one credential source and resolves auth paths without loading user configuration', async (t) => {
  const f = await setup(t);
  const parser = compileContract(codexPlugin.manifest.configSchema, 'codex config');
  for (const source of [{ apiKey: 'key' }, { apiKeyFile: './key' }, { authFile: './auth.json' }])
    parser.parse({ model: 'gpt-6', ...source });
  for (const sandboxMode of ['restricted', 'danger-full-access'])
    parser.parse({ model: 'gpt-6', apiKey: 'key', sandboxMode });
  for (const config of [
    { sandboxMode: 'invalid' },
    { sandboxMode: 'danger-full-access', filesystem: { read: ['./data'] } },
  ])
    assert.throws(() => parser.parse({ model: 'gpt-6', apiKey: 'key', ...config }));
  for (const source of [
    {},
    { apiKey: 'key', authFile: './auth.json' },
    { apiKeyFile: './key', authFile: './auth.json' },
  ])
    assert.throws(() => parser.parse({ model: 'gpt-6', ...source }));
  assert.equal(authFilePath('~/auth.json', f.context), path.join(homedir(), 'auth.json'));
  assert.equal(authFilePath('./auth.json', f.context), f.file);
  await assert.rejects(
    codexPlugin.create(
      { model: 'gpt-6', authFile: './auth.json', baseUrl: 'https://api.openai.com/v1' },
      f.context,
    ),
    { code: 'CODEX_CHATGPT_BASE_URL_UNSUPPORTED' },
  );
  const auth = await f.native();
  auth.release();
  await assert.rejects(
    stat(path.join(f.root, 'state')),
    { code: 'ENOENT' },
    'configuration inspection must not install or refresh credentials',
  );
  await writeFile(f.file, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'SYNTHETIC_KEY' }));
  const plugin = await codexPlugin.create({ model: 'gpt-6', authFile: './auth.json' }, f.context);
  assert.equal(plugin.scope.authentication, 'apiKey');
  assert.equal(plugin.scope.tokenCounting, 'responses/input_tokens');
  assert.ok(!JSON.stringify(plugin.scope).includes('SYNTHETIC_KEY'));
  await plugin.dispose();
});

test('invalid or oversized auth caches fail with safe errors and never fall back to personal credentials', async (t) => {
  const f = await setup(t);
  for (const value of [
    'SYNTHETIC_SECRET_INVALID_JSON',
    JSON.stringify({ auth_mode: 'unknown', secret: 'SYNTHETIC_SECRET' }),
    JSON.stringify({ tokens: { access_token: 'SYNTHETIC_SECRET' } }),
  ]) {
    await writeFile(f.file, value);
    await assert.rejects(f.native(), (error) => {
      assert.equal((error as { code: string }).code, 'CODEX_AUTH_FILE_INVALID');
      assert.ok(!String(error).includes('SYNTHETIC_SECRET'));
      return true;
    });
  }
  await truncate(f.file, 1024 * 1024 + 1);
  await assert.rejects(f.native(), { code: 'CODEX_AUTH_FILE_INVALID' });
  await assert.rejects(authenticationFromFile('./missing.json', f.context), {
    code: 'CODEX_AUTH_FILE_INVALID',
  });
});

test('native credentials share one service cache, preserve refreshed state, reseed on restart and never overwrite the source', async (t) => {
  const f = await setup(t);
  await writeFile(path.join(f.root, 'config.toml'), 'model="UNSELECTED_SECRET_CONFIG"');
  const a = await f.native();
  await symlink(f.file, path.join(f.root, 'auth-alias.json'));
  const b = await authenticationFromFile('./auth-alias.json', {
    ...f.context,
    instanceId: 'other',
    stateDirectory: path.join(f.root, 'state', 'plugins', 'other'),
  });
  assert.equal(b.kind, 'chatgpt');
  if (b.kind !== 'chatgpt') throw new Error();
  const [homeA, homeB] = await Promise.all([a.home(), b.home()]);
  assert.equal(homeA, homeB);
  assert.deepEqual((await readdir(homeA)).sort(), ['auth.json', 'import.json']);
  assert.equal((await stat(path.join(homeA, 'auth.json'))).mode & 0o777, 0o600);
  const refreshed = authDocument('SYNTHETIC_ACCOUNT_A', 'REFRESHED');
  await writeFile(path.join(homeA, 'auth.json'), JSON.stringify(refreshed));
  await a.registerCurrent();
  assert.ok(f.secrets.includes('REFRESHED'));
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).tokens.access_token, 'ORIGINAL');
  a.release();
  b.release();
  const restarted = await f.native();
  assert.equal(await restarted.home(), homeA);
  assert.equal(
    JSON.parse(await readFile(path.join(homeA, 'auth.json'), 'utf8')).tokens.access_token,
    'REFRESHED',
  );
  restarted.release();
  await writeFile(f.file, JSON.stringify(authDocument('SYNTHETIC_ACCOUNT_A', 'RELOGIN')));
  const reseeded = await f.native();
  await reseeded.home();
  assert.equal(
    JSON.parse(await readFile(path.join(homeA, 'auth.json'), 'utf8')).tokens.access_token,
    'RELOGIN',
  );
  await writeFile(
    path.join(homeA, 'auth.json'),
    JSON.stringify(authDocument('SYNTHETIC_OTHER_ACCOUNT', 'OTHER')),
  );
  await assert.rejects(reseeded.registerCurrent(), { code: 'CODEX_AUTH_ACCOUNT_CHANGED' });
  reseeded.release();
});

test('credential rotation keeps scope stable while switching the ChatGPT account changes the restore scope', async (t) => {
  const f = await setup(t);
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      engine: {
        module: new URL('../src/plugins/codex/index.js', import.meta.url).href,
        config: { model: 'gpt-6', authFile: f.file },
      },
    },
  });
  let host = await f.loadHost();
  const target = host.authorize(principal, 'a').target;
  await host.close();
  await writeFile(f.file, JSON.stringify(authDocument('SYNTHETIC_ACCOUNT_A', 'ROTATED')));
  host = await f.loadHost();
  assert.equal(host.restore(principal, target).target.revision, target.revision);
  await host.close();
  await writeFile(
    f.file,
    JSON.stringify(authDocument('SYNTHETIC_ACCOUNT_A', 'ROTATED', 'other-user')),
  );
  host = await f.loadHost();
  assert.throws(() => host.restore(principal, target), { code: 'TARGET_SCOPE_CHANGED' });
  await host.close();
  await writeFile(f.file, JSON.stringify(authDocument('SYNTHETIC_ACCOUNT_B', 'ROTATED')));
  host = await f.loadHost();
  assert.throws(() => host.restore(principal, target), { code: 'TARGET_SCOPE_CHANGED' });
});

async function skill(root: string, name: string) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Investigate using ${name}.\n---\nDEFERRED_BODY_${name}`,
  );
  return directory;
}

test(
  'real native ChatGPT CLI authenticates without the API proxy and meters cumulative usage across repairs and resumed turns',
  { timeout: 60000 },
  async (t) => {
    const f = await setup(t);
    const captures: string[] = [];
    const auth = authDocument();
    auth.tokens.access_token = auth.tokens.id_token;
    await writeFile(f.file, JSON.stringify(auth));
    const api = createServer(async (req, res) => {
      if (!req.url?.endsWith('/responses')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}');
        return;
      }
      assert.equal(req.headers.authorization, 'Bearer ' + auth.tokens.access_token);
      assert.equal(req.headers['chatgpt-account-id'], auth.tokens.account_id);
      let body = '';
      for await (const part of req) body += String(part);
      captures.push(body);
      const input = JSON.parse(body);
      const prompt = JSON.stringify(input.input);
      const encoded = /报告标识: (\{[^\n]+\})/.exec(
        (input.input as { content?: { text?: string }[] }[])
          .flatMap((item) => item.content ?? [])
          .map((part) => part.text ?? '')
          .join('\n'),
      )?.[1];
      assert.ok(encoded, prompt.slice(-200));
      const ids = JSON.parse(encoded);
      const report = {
        ...ids,
        facts: [],
        hypotheses: [],
        recommendations: [],
        missingEvidence: ['SYNTHETIC_NATIVE_MODEL'],
      };
      const id = 'resp_' + captures.length;
      const item = {
        id: 'msg_' + captures.length,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', annotations: [], text: JSON.stringify(report) }],
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type: string, extra: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
      emit('response.created', {
        response: { id, object: 'response', status: 'in_progress', output: [] },
      });
      const progress = {
        id: 'progress_' + captures.length,
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            annotations: [],
            text: 'I will check the evidence before returning the report.',
          },
        ],
      };
      emit('response.output_item.added', { output_index: 0, item: progress });
      emit('response.output_item.done', { output_index: 0, item: progress });
      emit('response.output_item.added', { output_index: 1, item });
      emit('response.output_item.done', { output_index: 1, item });
      emit('response.completed', {
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: [progress, item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      });
      res.end();
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    });
    f.context.registerSecrets?.([auth.tokens.access_token]);
    const launcher = path.join(f.root, 'native-launcher.mjs');
    const trace = path.join(f.root, 'native-trace.log');
    const catalog = path.join(f.root, 'models.json');
    const bundled = JSON.parse(
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js', import.meta.url)),
          'debug',
          'models',
          '--bundled',
        ],
        {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.root, CODEX_HOME: f.root },
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          timeout: 15000,
        },
      ),
    ) as { models: JsonObject[] };
    await writeFile(
      catalog,
      JSON.stringify({ ...bundled, models: [{ ...bundled.models[0], slug: 'gpt-6' }] }),
    );
    await writeFile(
      launcher,
      `#!/usr/bin/env node
import cp from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawn;
cp.spawn=(command,args,options)=>{
  const child=spawn(command,args,{...options,stdio:['inherit','pipe','pipe']});
  for(const [stream,destination] of [[child.stdout,process.stdout],[child.stderr,process.stderr]])
    stream.on('data',chunk=>{appendFileSync(${JSON.stringify(trace)},chunk,{mode:0o600});destination.write(chunk);});
  return child;
};
syncBuiltinESMExports();
// A local provider uses the real native OpenAI auth store without contacting account routing.
const overrides=${JSON.stringify([
        'model_provider="native-fixture"',
        'model_catalog_json=' + JSON.stringify(catalog),
        'model_providers.native-fixture.name="Native auth fixture"',
        'model_providers.native-fixture.base_url=' +
          JSON.stringify('http://127.0.0.1:' + (api.address() as { port: number }).port + '/v1'),
        'model_providers.native-fixture.wire_api="responses"',
        'model_providers.native-fixture.requires_openai_auth=true',
        'model_providers.native-fixture.supports_websockets=false',
      ])};
const resume=process.argv.indexOf('resume',3);
process.argv.splice(resume<0?process.argv.length:resume,0,...overrides.flatMap(value=>['--config',value]));
await import(${JSON.stringify(new URL('../tools/codex-launcher.mjs', import.meta.url).href)});
`,
      { mode: 0o755 },
    );
    const skillsA = await skill(f.root, 'native-alpha');
    const skillsB = await skill(f.root, 'native-beta');
    await f.writeConfig({
      ...f.config,
      runtime: { stateDirectory: path.join(f.root, 'state') },
      plugins: {
        ...f.config.plugins,
        engine: {
          module: new URL('../src/plugins/codex/index.js', import.meta.url).href,
          config: { model: 'gpt-6', authFile: f.file, launcher, localCommands: false },
        },
      },
      targets: {
        a: { ...f.config.targets.a!, skills: [skillsA] },
        b: { ...f.config.targets.b!, skills: [skillsB] },
      },
    });
    const host = await f.loadHost();
    const engine = host.engineFor(host.authorize(principal, 'a').target);
    const a = request(host.authorize(principal, 'a'));
    const b = request(host.authorize(principal, 'b'));
    const sessions: AgentSession[] = [];
    try {
      const initial = await engine.createSession(
        { scope: a.scope, tools: [], budget: { maxModelTokens: 300 } },
        new AbortController().signal,
      );
      sessions.push(initial);
      const native = await f.native();
      const authHome = await native.home();
      await writeFile(
        path.join(authHome, 'config.toml'),
        'unrecognized_config_field="POISON_SHOULD_BE_IGNORED"',
      );
      native.release();
      await collect(initial, a);
      await collect(initial, { ...a, turnId: 'repair' });
      const checkpoint = initial.handle as JsonObject;
      assert.deepEqual(checkpoint.usage, { input_tokens: 200, output_tokens: 20 });
      await initial.close();
      const resumed = await engine.resumeSession(
        checkpoint,
        { scope: a.scope, tools: [], budget: { maxModelTokens: 150 } },
        new AbortController().signal,
      );
      sessions.push(resumed);
      await collect(resumed, { ...a, turnId: 'next-core-turn' });
      assert.deepEqual((resumed.handle as JsonObject).usage, {
        input_tokens: 300,
        output_tokens: 30,
      });
      await assert.rejects(collect(resumed, { ...a, turnId: 'repair-exceeded' }), {
        code: 'MODEL_TOKEN_BUDGET_EXHAUSTED',
      });
      const before = captures.length;
      await assert.rejects(collect(resumed, a), { code: 'MODEL_TOKEN_BUDGET_EXHAUSTED' });
      assert.equal(captures.length, before);
      const noCheckpoint = { ...checkpoint };
      delete noCheckpoint.usage;
      await assert.rejects(
        engine.resumeSession(
          noCheckpoint,
          { scope: a.scope, tools: [], budget: { maxModelTokens: 150 } },
          new AbortController().signal,
        ),
        { code: 'MODEL_USAGE_CHECKPOINT_REQUIRED' },
      );
      const other = await engine.createSession(
        { scope: b.scope, tools: [], budget: { maxModelTokens: 150 } },
        new AbortController().signal,
      );
      sessions.push(other);
      await collect(other, b);
      assert.ok(
        captures
          .slice(0, 4)
          .every(
            (body) =>
              body.includes('native-alpha/SKILL.md') && !body.includes('native-beta/SKILL.md'),
          ),
      );
      assert.ok(
        captures[4]!.includes('native-beta/SKILL.md') &&
          !captures[4]!.includes('native-alpha/SKILL.md'),
      );
      assert.ok(
        captures.every(
          (body) =>
            !body.includes('POISON_SHOULD_BE_IGNORED') &&
            !body.includes('SYNTHETIC_REFRESH_') &&
            !body.includes('DEFERRED_BODY_'),
        ),
      );
    } catch (error) {
      console.error(
        'Synthetic native CLI trace:',
        await readFile(trace, 'utf8').catch(() => 'unavailable'),
      );
      throw error;
    } finally {
      for (const session of sessions) await session.close();
    }
  },
);

async function scriptedLauncher(
  root: string,
  usage: readonly (JsonObject | null)[],
  rotated?: string,
  invalidFirstReport?: 'json' | 'schema',
) {
  const sequence = path.join(root, 'usage-sequence.json');
  await writeFile(sequence, JSON.stringify(usage));
  const file = path.join(root, 'usage-launcher.mjs');
  await writeFile(
    file,
    `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
let prompt='';for await(const part of process.stdin)prompt+=part;
writeFileSync(${JSON.stringify(path.join(root, 'prompt-capture.txt'))},prompt);
const ids=JSON.parse(/报告标识: (\\{[^\\n]+\\})/.exec(prompt)[1]);
const sequence=JSON.parse(readFileSync(${JSON.stringify(sequence)},'utf8'));
const usage=sequence.shift();writeFileSync(${JSON.stringify(sequence)},JSON.stringify(sequence));
console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000001'}));
const rotated=${JSON.stringify(rotated ?? null)};
if(rotated){
 const file=path.join(process.env.CODEX_HOME,'auth.json');
 const auth=JSON.parse(readFileSync(file,'utf8'));auth.tokens.access_token=rotated;auth.tokens.refresh_token='refresh_'+rotated;
 writeFileSync(file,JSON.stringify(auth));
 console.log(JSON.stringify({type:'item.completed',item:{id:'command',type:'command_execution',command:'printf '+rotated,aggregated_output:rotated+' refresh_token=UNKNOWN_REFRESH id_token=UNKNOWN_ID',exit_code:0,status:'completed'}}));
}
const invalid=${JSON.stringify(invalidFirstReport ?? null)};
const first=sequence.length===${usage.length}-1;
const report={...ids,facts:first&&invalid==='schema'?'invalid facts':[],hypotheses:[],recommendations:[],missingEvidence:['SYNTHETIC_USAGE_REPORT']};
console.log(JSON.stringify({type:'item.completed',item:{id:'report',type:'agent_message',text:first&&invalid==='json'?'not final JSON':JSON.stringify(report)}}));
if(usage!==null)console.log(JSON.stringify({type:'turn.completed',usage}));
`,
    { mode: 0o755 },
  );
  return file;
}
for (const [name, values, failure] of [
  ['missing terminal usage', [null], 'MODEL_USAGE_UNKNOWN'],
  [
    'regressing cumulative usage',
    [
      { input_tokens: 100, output_tokens: 10 },
      { input_tokens: 90, output_tokens: 10 },
    ],
    'MODEL_USAGE_INVALID',
  ],
] as const) {
  test('explicit native budgets fail closed on ' + name, async (t) => {
    const f = await setup(t);
    const host = await f.loadHost();
    const scope = host.authorize(principal, 'a');
    const launcher = await scriptedLauncher(f.root, values);
    const plugin = await codexPlugin.create(
      { model: 'gpt-6', authFile: f.file, launcher },
      f.context,
    );
    try {
      const session = await plugin.engine!.createSession(
        { scope, tools: [], budget: { maxModelTokens: 1000 } },
        new AbortController().signal,
      );
      if (values.length > 1) await collect(session, request(scope));
      const reports: unknown[] = [];
      await assert.rejects(
        async () => {
          for await (const event of session.runTurn(request(scope), new AbortController().signal))
            if (event.type === 'report') reports.push(event.report);
        },
        { code: failure },
      );
      assert.equal(reports.length, 0, 'unverified usage must not emit a completed report');
      const sequence = await readFile(path.join(f.root, 'usage-sequence.json'), 'utf8');
      await assert.rejects(collect(session, request(scope)), { code: failure });
      assert.equal(
        await readFile(path.join(f.root, 'usage-sequence.json'), 'utf8'),
        sequence,
        'unsafe retry must retain the actual usage failure without another launch',
      );
      await session.close();
    } finally {
      await plugin.dispose();
    }
  });
}

test('native usage exceeding the limit fails the Core turn without delivering a candidate report', async (t) => {
  const f = await setup(t);
  const launcher = await scriptedLauncher(f.root, [{ input_tokens: 100, output_tokens: 10 }]);
  await f.writeConfig({
    ...f.config,
    runtime: { stateDirectory: path.join(f.root, 'state'), maxModelTokens: 50 },
    plugins: {
      ...f.config.plugins,
      engine: {
        module: new URL('../src/plugins/codex/index.js', import.meta.url).href,
        config: { model: 'gpt-6', authFile: f.file, launcher },
      },
    },
  });
  const host = await f.loadHost();
  const store = await InvestigationStore.open(host.runtime.stateDirectory);
  const coordinator = new InvestigationCoordinator(host, store);
  try {
    await coordinator.start();
    const accepted = await coordinator.handle(request(host.authorize(principal, 'a')).message);
    assert.equal(accepted.status, 'accepted');
    if (accepted.status !== 'accepted') throw new Error();
    await coordinator.idle();
    assert.equal(store.turn(accepted.turnId).status, 'failed');
    assert.equal(store.turn(accepted.turnId).failure, 'MODEL_TOKEN_BUDGET_EXHAUSTED');
    assert.ok(
      store
        .deliveries()
        .every((delivery) => !delivery.message.text.includes('SYNTHETIC_USAGE_REPORT')),
    );
  } finally {
    await coordinator.close();
  }
});

test('refreshed native tokens are redacted before evidence is persisted, including credentials named in log text', async (t) => {
  const f = await setup(t);
  const rotated = 'SYNTHETIC_ROTATED_' + Math.random().toString(36).slice(2);
  const launcher = await scriptedLauncher(
    f.root,
    [{ input_tokens: 100, output_tokens: 10 }],
    rotated,
  );
  await f.writeConfig({
    ...f.config,
    runtime: { stateDirectory: path.join(f.root, 'state') },
    plugins: {
      ...f.config.plugins,
      engine: {
        module: new URL('../src/plugins/codex/index.js', import.meta.url).href,
        config: { model: 'gpt-6', authFile: f.file, launcher },
      },
    },
  });
  const host = await f.loadHost();
  const store = await InvestigationStore.open(host.runtime.stateDirectory);
  const coordinator = new InvestigationCoordinator(host, store);
  try {
    await coordinator.start();
    const accepted = await coordinator.handle(request(host.authorize(principal, 'a')).message);
    assert.equal(accepted.status, 'accepted');
    if (accepted.status !== 'accepted') throw new Error();
    await coordinator.idle();
    assert.equal(store.turn(accepted.turnId).status, 'completed');
    const evidence = JSON.stringify(await store.evidence(accepted.turnId));
    assert.ok(evidence.includes('command_execution'));
    for (const secret of [rotated, 'UNKNOWN_REFRESH', 'UNKNOWN_ID'])
      assert.ok(!evidence.includes(secret));
    const persisted = await Promise.all(
      (await readdir(path.join(store.directory, 'evidence')))
        .filter((name) => name.endsWith('.json'))
        .map((name) => readFile(path.join(store.directory, 'evidence', name), 'utf8')),
    );
    assert.ok(persisted.every((record) => !record.includes(rotated)));
    assert.ok(
      !new Redactor()
        .text('refresh_token=UNKNOWN_REFRESH id_token=UNKNOWN_ID')
        .includes('UNKNOWN_'),
    );
  } finally {
    await coordinator.close();
  }
});

for (const invalid of ['json', 'schema'] as const)
  test('native report repair retains confirmed usage after invalid final ' + invalid, async (t) => {
    const f = await setup(t);
    const launcher = await scriptedLauncher(
      f.root,
      [
        { input_tokens: 100, output_tokens: 10 },
        { input_tokens: 200, output_tokens: 20 },
      ],
      undefined,
      invalid,
    );
    await f.writeConfig({
      ...f.config,
      runtime: { stateDirectory: path.join(f.root, 'state'), maxModelTokens: 300 },
      plugins: {
        ...f.config.plugins,
        engine: {
          module: new URL('../src/plugins/codex/index.js', import.meta.url).href,
          config: { model: 'gpt-6', authFile: f.file, launcher },
        },
      },
    });
    const host = await f.loadHost();
    const store = await InvestigationStore.open(host.runtime.stateDirectory);
    const coordinator = new InvestigationCoordinator(host, store);
    try {
      await coordinator.start();
      const accepted = await coordinator.handle(request(host.authorize(principal, 'a')).message);
      assert.equal(accepted.status, 'accepted');
      if (accepted.status !== 'accepted') throw Error();
      await coordinator.idle();
      assert.equal(
        store.turn(accepted.turnId).status,
        'completed',
        store.turn(accepted.turnId).failure,
      );
      assert.deepEqual((store.turn(accepted.turnId).sessionHandle as JsonObject).usage, {
        input_tokens: 200,
        output_tokens: 20,
      });
    } finally {
      await coordinator.close();
    }
  });

for (const [name, measured, expected] of [
  [
    'large confirmed usage',
    { input_tokens: 250000, output_tokens: 100 },
    { inputTokens: 250000, outputTokens: 100, complete: true },
  ],
  ['missing usage', null, { inputTokens: 0, outputTokens: 0, complete: false }],
] as const)
  test(
    'default native accounting accepts valid reports with ' +
      name +
      ' and persists usage across restart',
    async (t) => {
      const f = await setup(t);
      const launcher = await scriptedLauncher(f.root, [measured]);
      await f.writeConfig({
        ...f.config,
        runtime: { stateDirectory: path.join(f.root, 'state') },
        plugins: {
          ...f.config.plugins,
          engine: {
            module: new URL('../src/plugins/codex/index.js', import.meta.url).href,
            config: { model: 'gpt-6', authFile: f.file, launcher },
          },
        },
      });
      const host = await f.loadHost();
      assert.equal(host.runtime.maxModelTokens, undefined);
      const store = await InvestigationStore.open(host.runtime.stateDirectory);
      const coordinator = new InvestigationCoordinator(host, store);
      let turnId = '';
      try {
        await coordinator.start();
        const original = request(host.authorize(principal, 'a')).message;
        const result = await coordinator.handle({
          ...original,
          text: 'Keep literal {{targetContext}} and {{reportIdentity}} in this log',
        });
        if (result.status !== 'accepted') throw Error(result.reason);
        turnId = result.turnId;
        await coordinator.idle();
        assert.equal(store.turn(turnId).status, 'completed', store.turn(turnId).failure);
        assert.deepEqual(store.turn(turnId).usage, expected);
        const output = store
          .deliveries()
          .map((d) => d.message.text)
          .join('\n');
        assert.match(output, /Token 用量/);
        if (!expected.complete) assert.match(output, /用量未完整确认/);
        const prompt = await readFile(path.join(f.root, 'prompt-capture.txt'), 'utf8');
        assert.ok(
          prompt.includes(
            '<user_log>Keep literal {{targetContext}} and {{reportIdentity}} in this log</user_log>',
          ),
        );
        assert.ok(!prompt.includes('报告标识: {{reportIdentity}}'));
      } finally {
        await coordinator.close();
      }
      const restored = await InvestigationStore.open(host.runtime.stateDirectory);
      try {
        assert.deepEqual(restored.turn(turnId).usage, expected);
      } finally {
        await restored.close();
      }
    },
  );

test('uncapped native resume marks an uncertain baseline without attributing earlier usage to the next turn', async (t) => {
  const f = await setup(t);
  const host = await f.loadHost();
  const scope = host.authorize(principal, 'a');
  const launcher = await scriptedLauncher(f.root, [
    null,
    { input_tokens: 100, output_tokens: 10 },
    { input_tokens: 160, output_tokens: 16 },
  ]);
  const plugin = await codexPlugin.create(
    { model: 'gpt-6', authFile: f.file, launcher },
    f.context,
  );
  try {
    let handle: JsonValue | undefined;
    const expected = [
      { inputTokens: 0, outputTokens: 0, complete: false },
      { inputTokens: 0, outputTokens: 0, complete: false },
      { inputTokens: 60, outputTokens: 6, complete: true },
    ];
    for (const usage of expected) {
      const options = { scope, tools: [] };
      const session =
        handle === undefined
          ? await plugin.engine!.createSession(options, new AbortController().signal)
          : await plugin.engine!.resumeSession(handle, options, new AbortController().signal);
      try {
        const observed = [];
        for await (const event of session.runTurn(request(scope), new AbortController().signal))
          if (event.type === 'usage') observed.push(event.usage);
        assert.deepEqual(observed, [usage]);
        handle = session.handle;
      } finally {
        await session.close();
      }
    }
  } finally {
    await plugin.dispose();
  }
});
