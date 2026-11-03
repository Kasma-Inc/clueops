import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import type { Connection } from 'ssh2';
import sshPlugin from '../src/plugins/ssh/index.js';
import codexPlugin from '../src/plugins/codex/index.js';
import { compileContract } from '../src/plugin-api/index.js';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { Socket } from 'node:net';
import { fixture, principal } from './helpers.js';
import { ToolRound } from '../src/core/tool-round.js';
import { InvestigationStore } from '../src/core/store.js';
import { fingerprint, messageKey } from '../src/core/identity.js';
import { validateReport } from '../src/core/reports.js';
import type {
  InvestigationRequest,
  JsonValue,
  ToolBinding,
  ToolBindingContext,
} from '../src/plugin-api/index.js';

const password = 'SYNTHETIC_ACCOUNT_PASSWORD';
const passphrase = 'SYNTHETIC_KEY_PASSPHRASE';
const context = (signal = new AbortController().signal): ToolBindingContext => ({
  investigationId: 'incident',
  turnId: 'turn',
  targetId: 'a',
  scopeRevision: 'a'.repeat(64),
  signal,
});
async function serverFixture(
  t: test.TestContext,
  mode: 'password' | 'private-key' | 'combined' = 'private-key',
  credentials = { password, passphrase },
) {
  const { password, passphrase } = credentials;
  const root = await mkdtemp(path.join(tmpdir(), 'incident-ssh-test-'));
  const generate = async (name: string, phrase = '') => {
    const file = path.join(root, name);
    await promisify(execFile)('/usr/bin/ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-a',
      '1',
      '-C',
      'SYNTHETIC_TEST',
      '-N',
      phrase,
      '-f',
      file,
    ]);
    return { private: await readFile(file, 'utf8'), public: await readFile(file + '.pub', 'utf8') };
  };
  const [host, key, encrypted] = await Promise.all([
    generate('host-source'),
    generate('key-source'),
    generate('encrypted-source', passphrase),
  ]);
  const parsed = utils.parseKey(key.private);
  const encryptedParsed = utils.parseKey(encrypted.private, passphrase);
  if (parsed instanceof Error || encryptedParsed instanceof Error)
    throw Error('generated key invalid');
  const clients = new Set<Connection>();
  const commands: string[] = [],
    methods: string[] = [];
  let connections = 0;
  const server = new Server({ hostKeys: [host.private] }, (client) => {
    connections++;
    clients.add(client);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    let keyAccepted = false;
    client.on('authentication', (auth) => {
      methods.push(auth.method);
      if (auth.username !== 'reader') return auth.reject();
      if (auth.method === 'publickey' && mode !== 'password') {
        const trusted = [parsed, encryptedParsed].find((key) =>
          key.getPublicSSH().equals(auth.key.data),
        );
        if (
          !trusted ||
          (auth.signature && trusted.verify(auth.blob!, auth.signature, auth.hashAlgo) !== true)
        )
          return auth.reject();
        if (mode === 'combined' && auth.signature) {
          keyAccepted = true;
          auth.reject(['password'], true);
        } else auth.accept();
      } else if (
        auth.method === 'password' &&
        auth.password === password &&
        (mode === 'password' || (mode === 'combined' && keyAccepted))
      )
        auth.accept();
      else
        auth.reject(
          mode === 'combined' && keyAccepted
            ? ['password']
            : mode === 'password'
              ? ['password']
              : ['publickey'],
        );
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (accept, _reject, info) => {
          commands.push(info.command);
          const stream = accept();
          stream.on('error', () => {});
          if (info.command === 'hold') return;
          if (info.command === 'overflow') {
            stream.write(Buffer.alloc(4096, 120));
            return;
          }
          if (info.command === 'no-status') {
            stream.end('UNKNOWN');
            return;
          }
          if (info.command === 'secrets') {
            stream.write(password + '\n' + passphrase);
            stream.stderr.write(password);
          } else stream.write('SSH_OK:' + info.command);
          stream.exit(info.command === 'bad' ? 7 : 0);
          stream.end();
        });
      }),
    );
  });
  server.on('error', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await Promise.all([
    writeFile(path.join(root, 'key'), key.private),
    writeFile(path.join(root, 'encrypted'), encrypted.private),
    writeFile(path.join(root, 'known_hosts'), `[127.0.0.1]:${port} ${host.public}\n`),
    writeFile(path.join(root, 'password'), password + '\n'),
    writeFile(path.join(root, 'passphrase'), passphrase + '\n'),
  ]);
  t.after(async () => {
    for (const client of clients) client.end();
    for (const client of clients)
      (client as unknown as { _sock: { destroy(): void } })._sock.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const base = { host: '127.0.0.1', port, user: 'reader', knownHostsFile: './known_hosts' };
  const secrets: string[] = [];
  const pluginContext = {
    instanceId: 'ssh-a',
    configFile: path.join(root, 'config.yaml'),
    resolvePath: (p: string) => path.resolve(root, p),
    registerSecrets: (values: readonly string[]) => secrets.push(...values),
  };
  return {
    root,
    base,
    pluginContext,
    commands,
    methods,
    secrets,
    server,
    host,
    connections: () => connections,
  };
}
async function bound(
  t: test.TestContext,
  plugin: Awaited<ReturnType<typeof sshPlugin.create>>,
  bindingContext = context(),
) {
  t.after(() => plugin.dispose());
  const result = await plugin.tools!.bind(bindingContext);
  assert.equal(result.status, 'ready', JSON.stringify(result));
  if (result.status !== 'ready') throw Error('not ready');
  t.after(() => result.binding.close());
  return result.binding;
}
const call = (binding: ToolBinding, command: string, signal = new AbortController().signal) =>
  binding.call('execute', { command }, signal);

test('SSH schemas reject ambiguous secrets, undeclared connection overrides and old Codex SSH configuration', () => {
  const schema = compileContract(sshPlugin.manifest.configSchema, 'ssh');
  const base = { host: 'example.test', user: 'reader', knownHostsFile: 'known' };
  for (const auth of [
    { type: 'password', password },
    { type: 'password', passwordFile: 'password' },
    { type: 'private-key', privateKeyFile: 'key' },
    { type: 'private-key', privateKeyFile: 'key', passphraseFile: 'passphrase' },
    { type: 'private-key+password', privateKeyFile: 'key', passphrase, passwordFile: 'password' },
  ])
    assert.equal(schema.accepts({ ...base, auth }), true);
  for (const auth of [
    { type: 'password' },
    { type: 'password', password, passwordFile: 'password' },
    { type: 'private-key', privateKeyFile: 'key', passphrase, passphraseFile: 'passphrase' },
    { type: 'private-key+password', privateKeyFile: 'key' },
    { type: 'private-key', privateKeyFile: 'key', password },
  ])
    assert.equal(schema.accepts({ ...base, auth }), false);
  assert.equal(
    compileContract(codexPlugin.manifest.configSchema, 'codex').accepts({
      model: 'gpt-6',
      apiKey: 'key',
      ssh: base,
    }),
    false,
  );
});

for (const mode of ['password', 'private-key', 'encrypted-key', 'combined'] as const)
  test(`real SSH protocol authenticates with ${mode} and returns confirmed stdout/stderr/exit status`, async (t) => {
    const f = await serverFixture(
      t,
      mode === 'password' ? 'password' : mode === 'combined' ? 'combined' : 'private-key',
    );
    const auth =
      mode === 'password'
        ? { type: 'password' as const, passwordFile: './password' }
        : mode === 'combined'
          ? { type: 'private-key+password' as const, privateKeyFile: './key', password }
          : {
              type: 'private-key' as const,
              privateKeyFile: mode === 'encrypted-key' ? './encrypted' : './key',
              ...(mode === 'encrypted-key' ? { passphraseFile: './passphrase' } : {}),
            };
    const plugin = await sshPlugin.create({ ...f.base, auth }, f.pluginContext);
    const b = await bound(t, plugin);
    assert.equal(plugin.tools!.definitions[0]!.readOnly, false);
    const result = await call(b, 'uptime');
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.content, {
      stdout: 'SSH_OK:uptime',
      stderr: '',
      exitCode: 0,
      signal: null,
    });
    assert.deepEqual(result.resources, [
      { host: f.base.host, user: 'reader', port: f.base.port, transport: 'ssh' },
    ]);
    assert.equal((await call(b, 'bad')).status, 'error');
    const unknown = await call(b, 'no-status');
    assert.equal(unknown.status, 'error');
    assert.equal(unknown.failure?.remoteStatus, 'unknown');
    await assert.rejects(b.call('execute', { command: 'echo', host: 'B' }, context().signal));
    assert.ok(!JSON.stringify(plugin.scope).includes(password));
    if (mode === 'combined') assert.deepEqual(f.methods, ['publickey', 'publickey', 'password']);
  });

test('passwords and private-key passphrases are redacted before SSH results reach the engine', async (t) => {
  const f = await serverFixture(t, 'combined');
  const plugin = await sshPlugin.create(
    {
      ...f.base,
      auth: { type: 'private-key+password', privateKeyFile: './encrypted', password, passphrase },
    },
    f.pluginContext,
  );
  const b = await bound(t, plugin);
  const result = await call(b, 'secrets');
  assert.equal(result.status, 'ok');
  assert.ok(!JSON.stringify(result).includes(password));
  assert.ok(!JSON.stringify(result).includes(passphrase));
  assert.ok(f.secrets.includes(password));
  assert.ok(f.secrets.includes(passphrase));
});

test('bad private-key unlocks fail before connecting; bad credentials and host keys produce safe unavailability', async (t) => {
  const f = await serverFixture(t, 'password');
  await assert.rejects(
    sshPlugin.create(
      {
        ...f.base,
        auth: { type: 'private-key', privateKeyFile: './encrypted', passphrase: 'WRONG_UNLOCK' },
      },
      f.pluginContext,
    ),
    /SSH_PRIVATE_KEY_INVALID/,
  );
  assert.equal(f.connections(), 0);
  const invalid = await sshPlugin.create(
    { ...f.base, auth: { type: 'password', password: 'WRONG_PASSWORD' } },
    f.pluginContext,
  );
  t.after(() => invalid.dispose());
  assert.equal((await invalid.tools!.bind(context())).status, 'unavailable');
  const other = utils.generateKeyPairSync('ed25519');
  await writeFile(path.join(f.root, 'wrong-host'), `[127.0.0.1]:${f.base.port} ${other.public}`);
  const mismatch = await sshPlugin.create(
    { ...f.base, knownHostsFile: './wrong-host', auth: { type: 'password', password } },
    f.pluginContext,
  );
  t.after(() => mismatch.dispose());
  const rejected = await mismatch.tools!.bind(context());
  assert.equal(rejected.status, 'unavailable');
  if (rejected.status === 'unavailable')
    assert.equal(rejected.failure.code, 'SSH_HOST_KEY_MISMATCH');
  assert.equal(f.commands.length, 0);
  await writeFile(
    path.join(f.root, 'revoked'),
    `[127.0.0.1]:${f.base.port} ${f.host.public}\n@revoked [127.0.0.1]:${f.base.port} ${f.host.public}`,
  );
  await assert.rejects(
    sshPlugin.create(
      { ...f.base, knownHostsFile: './revoked', auth: { type: 'password', password } },
      f.pluginContext,
    ),
    /SSH_HOST_KEYS_INVALID/,
  );
});

test('combined authentication cannot silently downgrade to a single accepted method', async (t) => {
  for (const mode of ['private-key', 'password'] as const) {
    const f = await serverFixture(t, mode);
    const plugin = await sshPlugin.create(
      { ...f.base, auth: { type: 'private-key+password', privateKeyFile: './key', password } },
      f.pluginContext,
    );
    t.after(() => plugin.dispose());
    assert.equal((await plugin.tools!.bind(context())).status, 'unavailable');
    assert.equal(f.commands.length, 0);
    if (mode === 'password')
      assert.ok(
        !f.methods.includes('password'),
        'never send password when the required public key was not accepted',
      );
  }
});

test('SSH scope is independent of secret rotation, and changes for server, authentication or trusted host keys', async (t) => {
  const f = await serverFixture(t, 'password');
  const plugins = [];
  for (const config of [
    { ...f.base, auth: { type: 'password' as const, password } },
    { ...f.base, auth: { type: 'password' as const, password: 'ROTATED_PASSWORD' } },
    { ...f.base, user: 'other', auth: { type: 'password' as const, password } },
    { ...f.base, auth: { type: 'private-key' as const, privateKeyFile: './key' } },
  ]) {
    const p = await sshPlugin.create(config, f.pluginContext);
    plugins.push(p);
    t.after(() => p.dispose());
  }
  const other = await serverFixture(t);
  await writeFile(
    path.join(f.root, 'new-trust'),
    `[127.0.0.1]:${f.base.port} ${other.host.public}`,
  );
  const changedTrust = await sshPlugin.create(
    { ...f.base, knownHostsFile: './new-trust', auth: { type: 'password', password } },
    f.pluginContext,
  );
  t.after(() => changedTrust.dispose());
  assert.notDeepEqual(plugins[0]!.scope, changedTrust.scope);
  assert.deepEqual(plugins[0]!.scope, plugins[1]!.scope);
  assert.notDeepEqual(plugins[0]!.scope, plugins[2]!.scope);
  assert.notDeepEqual(plugins[0]!.scope, plugins[3]!.scope);
});

test('independent SSH rounds keep cancellation local and reject late results', async (t) => {
  const f = await serverFixture(t);
  const plugin = await sshPlugin.create(
    { ...f.base, auth: { type: 'private-key', privateKeyFile: './key' } },
    f.pluginContext,
  );
  const abort = new AbortController(),
    a = await bound(t, plugin, context(abort.signal)),
    b = await bound(t, plugin);
  const pending = call(a, 'hold');
  while (!f.commands.includes('hold')) await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort();
  await assert.rejects(pending);
  await a.close();
  assert.equal((await call(b, 'still-running')).status, 'ok');
});

test('SSH query timeout and result overflow close the transport and retain remote uncertainty', async (t) => {
  for (const command of ['hold', 'overflow']) {
    const f = await serverFixture(t);
    const plugin = await sshPlugin.create(
      {
        ...f.base,
        queryTimeoutMs: command === 'hold' ? 100 : 10000,
        maxResultBytes: 1024,
        auth: { type: 'private-key', privateKeyFile: './key' },
      },
      f.pluginContext,
    );
    const b = await bound(t, plugin);
    const result = await call(b, command);
    assert.equal(result.status, 'error');
    assert.equal(result.failure?.remoteStatus, 'unknown');
    assert.equal(result.content, null);
    assert.equal(result.truncated, command === 'overflow');
    await b.close();
    assert.equal((await call(b, 'late')).status, 'error');
  }
});

test('credential files preserve password and private-key passphrase spaces, removing only one trailing newline', async (t) => {
  const f = await serverFixture(t, 'combined', {
    password: '  SYNTHETIC_PASSWORD_WITH_SPACES  ',
    passphrase: '  SYNTHETIC_KEY_WITH_SPACES  ',
  });
  const plugin = await sshPlugin.create(
    {
      ...f.base,
      auth: {
        type: 'private-key+password',
        privateKeyFile: './encrypted',
        passwordFile: './password',
        passphraseFile: './passphrase',
      },
    },
    f.pluginContext,
  );
  const b = await bound(t, plugin);
  assert.equal((await call(b, 'spaces-preserved')).status, 'ok');
});

test(
  'actual Codex calls two target SSH tools through metered MCP, resumes and cannot invoke another target server',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t);
    const a = await serverFixture(t),
      c = await serverFixture(t, 'password'),
      b = await serverFixture(t, 'password');
    const declaration = (server: typeof a, passwordOnly = false) => ({
      module: new URL('../src/plugins/ssh/index.js', import.meta.url).href,
      config: {
        ...server.base,
        knownHostsFile: path.join(server.root, 'known_hosts'),
        auth: passwordOnly
          ? { type: 'password', passwordFile: path.join(server.root, 'password') }
          : { type: 'private-key', privateKeyFile: path.join(server.root, 'key') },
      },
    });
    await f.writeConfig({
      ...f.config,
      plugins: {
        ...f.config.plugins,
        'a-tools': declaration(a),
        'b-tools': declaration(b, true),
        'c-tools': declaration(c, true),
      },
      targets: { ...f.config.targets, a: { engine: 'engine', tools: ['a-tools', 'c-tools'] } },
    });
    const host = await f.loadHost(),
      scope = host.authorize(principal, 'a');
    const deniedInstance = host.authorize(principal, 'b').target.tools[0]!.instanceId;
    const deniedAlias = 't_' + fingerprint([deniedInstance, 'execute']).slice(0, 24);
    const store = await InvestigationStore.open(path.join(f.root, 'integration-state'));
    t.after(() => store.close());
    let request: InvestigationRequest = {
      investigationId: 'ssh-incident',
      turnId: 'ssh-turn-1',
      scope,
      message: {
        address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
        senderId: 'user',
        messageId: 'ssh-message-1',
        text: 'Read both servers',
      },
    };
    let aliases: string[] = [],
      requests = 0;
    const captures: string[] = [];
    const api = createServer(async (req, res) => {
      let raw = '';
      for await (const part of req) raw += String(part);
      if (req.url?.endsWith('/input_tokens')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ input_tokens: 20 }));
        return;
      }
      const body = JSON.parse(raw);
      captures.push(raw);
      const n = requests++;
      const evidence = (await store.evidence(request.turnId)).filter((e) => e.status === 'ok');
      const item =
        n < 3
          ? {
              id: 'ssh-call-' + n,
              call_id: 'ssh-call-' + n,
              type: 'function_call',
              name: n === 2 ? deniedAlias : aliases[n],
              namespace: 'mcp__investigation',
              arguments: JSON.stringify({ command: 'probe-' + request.turnId + '-' + n }),
            }
          : {
              id: 'ssh-report',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  annotations: [],
                  text: JSON.stringify({
                    investigationId: request.investigationId,
                    turnId: request.turnId,
                    targetId: 'a',
                    facts: evidence.map((e) => ({ text: 'SSH observed', evidenceIds: [e.id] })),
                    hypotheses: [],
                    recommendations: [],
                    missingEvidence: [],
                  }),
                },
              ],
            };
      assert.ok(!JSON.stringify(body.tools).includes(deniedAlias));
      const id = 'ssh-response-' + n;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type: string, extra: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
      emit('response.created', {
        response: { id, object: 'response', status: 'in_progress', output: [] },
      });
      const progress = {
        id: 'ssh-progress-' + n,
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        status: 'completed',
        content: [
          { type: 'output_text', annotations: [], text: 'I will query the selected SSH server.' },
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
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        },
      });
      res.end();
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      api.closeAllConnections();
      api.close();
    });
    const plugin = await codexPlugin.create(
      {
        apiKey: 'SYNTHETIC_CODEX_SSH_KEY',
        model: 'gpt-6',
        baseUrl: `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`,
        stateDirectory: './codex-state',
      },
      {
        instanceId: 'engine',
        configFile: path.join(f.root, 'codex.yaml'),
        resolvePath: (p) => path.resolve(f.root, p),
      },
    );
    t.after(() => plugin.dispose());
    let handle: JsonValue | undefined;
    for (const turn of [1, 2]) {
      requests = 0;
      request = {
        ...request,
        turnId: 'ssh-turn-' + turn,
        message: { ...request.message, messageId: 'ssh-message-' + turn },
      };
      await store.accept({
        version: 1,
        key: messageKey(request.message),
        acceptedAt: new Date().toISOString(),
        sequence: turn,
        request,
      });
      await store.setTurn(request.turnId, 'running');
      const round = new ToolRound(
        request,
        store,
        host.redactor,
        host.runtime,
        AbortSignal.timeout(20000),
      );
      await round.open(host.toolsFor(scope.target));
      aliases = round.tools.map((tool) => tool.definition.name);
      assert.equal(aliases.length, 2);
      const options = { scope, tools: round.tools };
      const session = handle
        ? await plugin.engine!.resumeSession(handle, options, AbortSignal.timeout(20000))
        : await plugin.engine!.createSession(options, AbortSignal.timeout(20000));
      try {
        let reports = 0;
        for await (const event of session.runTurn(request, AbortSignal.timeout(20000))) {
          if (event.type === 'report') {
            validateReport(event.report, request, await store.evidence(request.turnId));
            reports++;
          }
        }
        assert.equal(reports, 1);
        handle = session.handle;
        assert.equal(
          round.metrics.calls,
          2,
          JSON.stringify(
            captures.flatMap((raw) =>
              JSON.parse(raw).input.filter(
                (item: { type: string }) => item.type === 'function_call_output',
              ),
            ),
          ),
        );
        assert.equal(
          (await store.evidence(request.turnId)).filter((e) => e.status === 'ok').length,
          2,
        );
      } finally {
        await session.close();
        await round.close();
      }
    }
    assert.equal(a.commands.length, 2);
    assert.equal(c.commands.length, 2);
    assert.equal(b.connections(), 0);
    assert.equal(b.commands.length, 0);
    assert.ok(!captures.join('').includes(password));
    assert.ok(!captures.join('').includes('BEGIN OPENSSH PRIVATE KEY'));
  },
);

test('a stalled SSH handshake obeys connection timeout and closes locally on startup cancellation', async (t) => {
  const f = await serverFixture(t);
  const sockets = new Set<Socket>();
  const tcp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  });
  const port = (tcp.address() as { port: number }).port;
  await writeFile(path.join(f.root, 'stalled-known'), `[127.0.0.1]:${port} ${f.host.public}`);
  const plugin = await sshPlugin.create(
    {
      ...f.base,
      port,
      knownHostsFile: './stalled-known',
      connectTimeoutMs: 100,
      auth: { type: 'private-key', privateKeyFile: './key' },
    },
    f.pluginContext,
  );
  t.after(() => plugin.dispose());
  assert.equal((await plugin.tools!.bind(context())).status, 'unavailable');
  const abort = new AbortController();
  const pending = plugin.tools!.bind(context(abort.signal));
  abort.abort();
  await assert.rejects(pending);
  await plugin.dispose();
});
