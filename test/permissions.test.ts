import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as httpServer } from 'node:http';
import { createServer as socketServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import { permissionProfile, resolveFilesystem } from '../src/plugins/codex/permissions.js';
import codexPlugin from '../src/plugins/codex/index.js';
import { fixture, principal } from './helpers.js';
import type { InvestigationRequest } from '../src/plugin-api/index.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../node_modules/@openai/codex/bin/codex.js', import.meta.url));
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
async function workspace(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ia-permission-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const work = path.join(directory, 'work');
  const temporary = path.join(directory, 'tmp');
  const codexHome = path.join(home, '.codex');
  const skills = path.join(home, '.agents', 'skills');
  for (const dir of [home, work, temporary, codexHome, skills])
    await mkdir(dir, { recursive: true });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: temporary,
  };
  return { directory, home, work, temporary, codexHome, skills, env };
}
async function sandbox(
  w: Awaited<ReturnType<typeof workspace>>,
  command: string,
  extraRead: string[] = [],
) {
  const profile = await permissionProfile({
    ...w,
    access: { read: extraRead, write: [] },
  });
  return exec(
    process.execPath,
    [
      cli,
      '-c',
      'features.network_proxy=true',
      '-c',
      'features.use_legacy_landlock=false',
      '-c',
      'default_permissions="investigation"',
      ...profile.configOverrides.flatMap((value) => ['-c', value]),
      'sandbox',
      '-P',
      'investigation',
      '-C',
      w.work,
      '--',
      '/bin/sh',
      '-c',
      command,
    ],
    { env: w.env, timeout: 15000, maxBuffer: 65536 },
  );
}

test('filesystem grants resolve canonically, change scope and reject credentials, state and runtime writes', async (t) => {
  const w = await workspace(t);
  const privateRoot = path.join(w.directory, 'private');
  const data = path.join(w.directory, 'data');
  await mkdir(privateRoot);
  await mkdir(data);
  await symlink(data, path.join(w.directory, 'data-link'));
  const context = {
    instanceId: 'engine',
    configFile: path.join(privateRoot, 'config.yaml'),
    resolvePath: (p: string) => path.resolve(w.directory, p),
  };
  const access = await resolveFilesystem(
    { read: ['./data-link', './data'], write: ['./data'] },
    context,
    [privateRoot],
  );
  assert.deepEqual(access, { read: [data], write: [data] });
  for (const value of ['.', './private', './private/config.yaml'])
    await assert.rejects(
      resolveFilesystem({ read: [value] }, context, [privateRoot]),
      /FILESYSTEM_PATH_(PRIVATE|INVALID)/,
    );
  await assert.rejects(
    resolveFilesystem(
      { write: [fileURLToPath(new URL('../node_modules', import.meta.url))] },
      context,
      [],
    ),
    /FILESYSTEM_PATH_PRIVATE/,
  );
  await assert.rejects(
    resolveFilesystem({ write: [path.dirname(process.execPath)] }, context, []),
    /FILESYSTEM_PATH_PRIVATE/,
  );
  await assert.rejects(
    resolveFilesystem({ read: ['./missing'] }, context, []),
    /FILESYSTEM_PATH_INVALID/,
  );
  await assert.rejects(
    resolveFilesystem(undefined, context, ['/etc/incident-secret']),
    /FILESYSTEM_PRIVATE_RUNTIME/,
  );
  const base = { apiKey: 'SYNTHETIC_KEY', model: 'gpt-6', stateDirectory: './state' };
  const a = await codexPlugin.create(base, context);
  const b = await codexPlugin.create({ ...base, filesystem: { read: ['./data'] } }, context);
  const explicit = await codexPlugin.create({ ...base, sandboxMode: 'restricted' }, context);
  const unrestricted = await codexPlugin.create(
    { ...base, sandboxMode: 'danger-full-access' },
    context,
  );
  try {
    assert.notDeepEqual(a.scope, b.scope);
    assert.deepEqual(a.scope, explicit.scope);
    assert.notDeepEqual(a.scope, unrestricted.scope);
    assert.deepEqual(unrestricted.scope.filesystem, { policy: 'danger-full-access' });
  } finally {
    await a.dispose();
    await b.dispose();
    await explicit.dispose();
    await unrestricted.dispose();
  }
});

test(
  'real native sandbox permits work and read-only skills while denying external files, links and foreign sockets',
  { timeout: 30000 },
  async (t) => {
    const w = await workspace(t);
    // Cover global /tmp outside the investigation's own directory.
    const outside = await realpath(await mkdtemp('/tmp/ia-foreign-'));
    t.after(() => rm(outside, { recursive: true, force: true }));
    const otherTmp = await realpath(await mkdtemp('/var/tmp/ia-foreign-'));
    t.after(() => rm(otherTmp, { recursive: true, force: true }));
    await writeFile(path.join(otherTmp, 'secret'), 'SYNTHETIC_VAR_TMP');
    const secret = path.join(outside, 'secret');
    await writeFile(secret, 'SYNTHETIC_OUTSIDE_SECRET');
    await writeFile(path.join(w.skills, 'resource'), 'SKILL_RESOURCE');
    await symlink(secret, path.join(w.work, 'link'));
    const sock = path.join(outside, 's');
    const server = socketServer((client) => client.end('SYNTHETIC_SOCKET_SECRET'));
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const command = `set -eu
printf WORK_OK > allowed
cat allowed
cat ${quote(path.join(w.skills, 'resource'))}
if cat ${quote(secret)} 2>/dev/null; then exit 31; fi
if cat ${quote(path.join(otherTmp, 'secret'))} 2>/dev/null; then exit 37; fi
if cat link 2>/dev/null; then exit 32; fi
if ln ${quote(secret)} hardlink 2>/dev/null; then exit 33; fi
if printf bad > ${quote(path.join(outside, 'written'))} 2>/dev/null; then exit 34; fi
if printf bad > ${quote(path.join(w.skills, 'resource'))} 2>/dev/null; then exit 35; fi
if /usr/bin/nc -w 1 -U ${quote(sock)} 2>/dev/null; then exit 36; fi
printf BOUNDARIES_OK`;
    const output = await sandbox(w, command);
    assert.match(output.stdout, /WORK_OK.*SKILL_RESOURCE.*BOUNDARIES_OK/s);
    assert.ok(!output.stdout.includes('SYNTHETIC_'));
    assert.equal(await readFile(secret, 'utf8'), 'SYNTHETIC_OUTSIDE_SECRET');
    assert.equal(await readFile(path.join(w.skills, 'resource'), 'utf8'), 'SKILL_RESOURCE');
  },
);

// Scripted Responses drives the actual pinned CLI; it does not replace the CLI or its native tools.
async function scriptedApi(
  t: test.TestContext,
  next: (body: Record<string, unknown>, n: number) => object,
) {
  let n = 0;
  const server = httpServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += String(part);
    if (req.url?.endsWith('/input_tokens')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    const item = next(JSON.parse(raw), n++);
    const id = 'resp-' + n;
    const emit = (type: string, extra: object) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    emit('response.created', {
      response: { id, object: 'response', status: 'in_progress', output: [] },
    });
    emit('response.output_item.added', { output_index: 0, item });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', {
      response: {
        id,
        object: 'response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      },
    });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}
const message = (text: string) => ({
  id: 'message',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
});

test(
  'actual adapter strips model/bridge tokens from commands and enforces configured read/write grants',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const host = await f.loadHost();
    const read = path.join(f.root, 'read');
    const write = path.join(f.root, 'write');
    await mkdir(read);
    await mkdir(write);
    await writeFile(path.join(read, 'data'), 'READ_OK');
    await writeFile(path.join(f.root, 'private', 'b-secret'), 'SYNTHETIC_CLUSTER_B');
    const request: InvestigationRequest = {
      investigationId: 'permissions',
      turnId: 'permissions-turn',
      scope: host.authorize(principal, 'a'),
      message: {
        address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
        senderId: 'user',
        messageId: 'permissions-message',
        text: 'Check permissions',
      },
    };
    const command = `set -eu
[ -z "\${INCIDENT_MODEL_TOKEN:-}" ] && [ -z "\${INCIDENT_TOOL_TOKEN:-}" ]
cat ${quote(path.join(read, 'data'))}
printf WRITE_OK > ${quote(path.join(write, 'result'))}
if cat ${quote(path.join(f.root, 'private', 'b-secret'))} 2>/dev/null; then exit 31; fi
if printf bad > ${quote(path.join(read, 'data'))} 2>/dev/null; then exit 32; fi
# Parent CLI has synthetic tokens; the tool must not read that process's environment.
/bin/ps eww -p "$PPID" -o command= 2>/dev/null || true
if [ -e /proc/$PPID/environ ]; then cat /proc/$PPID/environ 2>/dev/null || true; fi
printf ENV_BOUNDARIES_OK`;
    const captures: string[] = [];
    const baseUrl = await scriptedApi(t, (body, n) => {
      captures.push(JSON.stringify(body.input));
      return n === 0
        ? {
            id: 'command',
            call_id: 'command',
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: command, max_output_tokens: 1000 }),
          }
        : message(
            JSON.stringify({
              investigationId: request.investigationId,
              turnId: request.turnId,
              targetId: 'a',
              facts: [],
              hypotheses: [],
              recommendations: [],
              missingEvidence: [],
            }),
          );
    });
    const plugin = await codexPlugin.create(
      {
        apiKey: 'SYNTHETIC_PARENT_MODEL_KEY',
        model: 'gpt-6',
        baseUrl,
        stateDirectory: './state',
        filesystem: { read: ['./read'], write: ['./write'] },
      },
      {
        instanceId: 'engine',
        configFile: path.join(f.root, 'config.yaml'),
        resolvePath: (p) => path.resolve(f.root, p),
      },
    );
    t.after(() => plugin.dispose());
    const session = await plugin.engine!.createSession(
      { scope: request.scope, tools: [] },
      AbortSignal.timeout(20000),
    );
    try {
      for await (const event of session.runTurn(request, AbortSignal.timeout(20000))) void event;
    } finally {
      await session.close();
    }
    const output = captures.at(-1)!;
    assert.match(output, /ENV_BOUNDARIES_OK/);
    assert.match(output, /READ_OK/);
    assert.ok(!output.includes('SYNTHETIC_CLUSTER_B'));
    assert.ok(!output.includes('SYNTHETIC_PARENT_MODEL_KEY'));
    assert.ok(!output.includes('INCIDENT_TOOL_TOKEN='));
    assert.ok(!output.includes('INCIDENT_MODEL_TOKEN='));
    assert.equal(await readFile(path.join(write, 'result'), 'utf8'), 'WRITE_OK');
    assert.equal(await readFile(path.join(read, 'data'), 'utf8'), 'READ_OK');
  },
);

test(
  'native apply_patch obeys the same profile for allowed writes, denied writes and links',
  { timeout: 45000 },
  async (t) => {
    const w = await workspace(t);
    const secret = path.join(w.directory, 'outside');
    await writeFile(secret, 'ORIGINAL\n');
    await symlink(secret, path.join(w.work, 'link'));
    const catalog = JSON.parse(
      (await exec(process.execPath, [cli, 'debug', 'models', '--bundled'], { env: w.env })).stdout,
    );
    const model = { ...catalog.models[0], slug: 'gpt-review' };
    const catalogFile = path.join(w.directory, 'models.json');
    await writeFile(catalogFile, JSON.stringify({ models: [model] }));
    const captures: string[] = [];
    const patches = [
      `*** Begin Patch\n*** Add File: ${w.work}/allowed\n+ALLOWED\n*** End Patch`,
      `*** Begin Patch\n*** Add File: ${w.directory}/denied\n+DENIED\n*** End Patch`,
      `*** Begin Patch\n*** Update File: ${w.work}/link\n@@\n-ORIGINAL\n+MODIFIED\n*** End Patch`,
    ];
    const baseUrl = await scriptedApi(t, (body, n) => {
      captures.push(JSON.stringify(body.input));
      return n < patches.length
        ? {
            id: 'patch-' + n,
            call_id: 'patch-' + n,
            type: 'custom_tool_call',
            name: 'apply_patch',
            input: patches[n],
          }
        : message('OK');
    });
    const profile = await permissionProfile({
      ...w,
      access: { read: [], write: [] },
    });
    const codex = new Codex({
      ...profile,
      env: { ...w.env, SYNTHETIC_KEY: 'SYNTHETIC' },
      config: {
        ...profile.config,
        model_catalog_json: catalogFile,
        model_provider: 'fixture',
        model_providers: {
          fixture: {
            name: 'fixture',
            base_url: baseUrl,
            wire_api: 'responses',
            env_key: 'SYNTHETIC_KEY',
            supports_websockets: false,
          },
        },
        features: { network_proxy: true, use_legacy_landlock: false },
        shell_environment_policy: { inherit: 'none', set: w.env },
      },
    });
    await codex
      .startThread({
        model: 'gpt-review',
        workingDirectory: w.work,
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
      })
      .run('Apply these patches');
    assert.equal(await readFile(path.join(w.work, 'allowed'), 'utf8'), 'ALLOWED\n');
    await assert.rejects(readFile(path.join(w.directory, 'denied')), { code: 'ENOENT' });
    assert.equal(await readFile(secret, 'utf8'), 'ORIGINAL\n');
    assert.match(captures.at(-1)!, /custom_tool_call_output/);
  },
);

test(
  'launcher retains termination uncertainty when a CLI ignores graceful cancellation',
  { timeout: 12000 },
  async (t) => {
    const w = await workspace(t);
    const modules = path.join(w.directory, 'node_modules', '@openai');
    const triple = `${process.arch === 'x64' ? 'x86_64' : 'aarch64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
    const binary = path.join(
      modules,
      `codex-${process.platform}-${process.arch}`,
      'vendor',
      triple,
      'bin',
      'codex',
    );
    await mkdir(path.dirname(binary), { recursive: true });
    for (const [name, config] of Object.entries({
      'codex-sdk': { type: 'module', exports: './index.js' },
      codex: {},
      [`codex-${process.platform}-${process.arch}`]: {},
    })) {
      await mkdir(path.join(modules, name), { recursive: true });
      await writeFile(path.join(modules, name, 'package.json'), JSON.stringify(config));
    }
    await writeFile(path.join(modules, 'codex-sdk', 'index.js'), 'export {};');
    const ready = path.join(w.directory, 'ready');
    await writeFile(
      binary,
      `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGINT',()=>{});setInterval(()=>{},1000);
`,
      { mode: 0o700 },
    );
    const launcher = path.join(w.directory, 'launcher.mjs');
    await writeFile(
      launcher,
      await readFile(new URL('../tools/codex-launcher.mjs', import.meta.url)),
    );
    const pidFile = path.join(w.directory, 'run.pid');
    const child = spawn(process.execPath, [launcher, 'exec'], {
      env: { ...w.env, INCIDENT_CODEX_PID_FILE: pidFile },
      stdio: 'ignore',
    });
    t.after(() => {
      child.kill('SIGKILL');
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    const deadline = Date.now() + 3000;
    while (
      await readFile(ready).then(
        () => false,
        () => true,
      )
    ) {
      assert.ok(Date.now() < deadline, 'synthetic CLI must start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    child.kill('SIGTERM');
    assert.equal(await exited, 1);
    assert.ok(
      (JSON.parse(await readFile(pidFile, 'utf8')) as { child: number }).child > 0,
      'unconfirmed termination retains the PID file for adapter failure',
    );
  },
);
