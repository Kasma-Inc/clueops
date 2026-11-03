import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import redis from '../../src/plugins/redis/index.js';
import type { JsonObject, ToolBindingContext } from '../../src/plugin-api/index.js';

const exec = promisify(execFile);
const image =
  process.env.REDIS_TEST_IMAGE ??
  'redis@sha256:a7efd4ed5037dcfe1543c0e50b9f06293d3e88827005544bf37f381eea5f01cf';
const context = (root: string) => ({
  instanceId: 'redis',
  configFile: path.join(root, 'config.yaml'),
  resolvePath: (s: string) => path.resolve(root, s),
});
const bindingContext = (): ToolBindingContext => ({
  investigationId: 'event',
  turnId: 'turn',
  targetId: 'a',
  scopeRevision: 'a'.repeat(64),
  signal: new AbortController().signal,
});

test(
  'official Redis MCP verifies TLS trust and client certificate pairs',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'incident-redis-tls-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cert = path.join(root, 'cert.pem');
    const key = path.join(root, 'key.pem');
    await exec('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);
    const id = (
      await exec('docker', [
        'run',
        '--rm',
        '-d',
        '--user',
        '0',
        // The image's default entrypoint drops root and cannot read a mode-0600 host key on Linux.
        '--entrypoint',
        'redis-server',
        '-p',
        '127.0.0.1::6379',
        '-v',
        `${cert}:/test/cert.pem:ro`,
        '-v',
        `${key}:/test/key.pem:ro`,
        image,
        '--port',
        '0',
        '--tls-port',
        '6379',
        '--tls-cert-file',
        '/test/cert.pem',
        '--tls-key-file',
        '/test/key.pem',
        '--tls-ca-cert-file',
        '/test/cert.pem',
        '--tls-auth-clients',
        'yes',
        '--save',
        '',
        '--appendonly',
        'no',
      ])
    ).stdout.trim();
    t.after(() => exec('docker', ['rm', '-f', id]));
    const port = Number(
      (await exec('docker', ['port', id, '6379/tcp'])).stdout.trim().split(':').at(-1),
    );
    const admin = [
      'exec',
      id,
      'redis-cli',
      '--tls',
      '--cacert',
      '/test/cert.pem',
      '--cert',
      '/test/cert.pem',
      '--key',
      '/test/key.pem',
    ];
    for (let i = 0; ; i++) {
      try {
        if ((await exec('docker', [...admin, 'PING'])).stdout.trim() === 'PONG') break;
      } catch {
        /* startup */
      }
      if (i > 50) throw new Error('REDIS_TLS_START_TIMEOUT');
      await new Promise((r) => setTimeout(r, 50));
    }
    await exec('docker', [...admin, 'SET', 'same', 'TLS_ONLY']);
    async function query(tls: { caFile?: string; certFile?: string; keyFile?: string }) {
      const plugin = await redis.create(
        { host: '127.0.0.1', port, tls, queryTimeoutMs: 1000 },
        context(root),
      );
      const bound = await plugin.tools!.bind(bindingContext());
      assert.equal(bound.status, 'ready');
      if (bound.status !== 'ready') throw new Error('REDIS_TLS_BIND_FAILED');
      try {
        return await bound.binding.call('get', { key: 'same' }, new AbortController().signal);
      } finally {
        await bound.binding.close();
      }
    }
    const valid = await query({
      caFile: './cert.pem',
      certFile: './cert.pem',
      keyFile: './key.pem',
    });
    assert.equal(valid.status, 'ok');
    assert.equal(valid.content, 'TLS_ONLY');
    assert.equal(
      (await query({ certFile: './cert.pem', keyFile: './key.pem' })).status,
      'error',
      'untrusted self-signed server must fail',
    );
    assert.equal(
      (await query({ caFile: './cert.pem' })).status,
      'error',
      'mTLS server must reject missing client identity',
    );
  },
);

test(
  'official Redis MCP with ephemeral Redis: ACL, target/DB binding, reads, pagination, failures and cancellation',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'incident-redis-integration-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const password = ' synthetic redis reader ';
    await writeFile(path.join(root, 'password'), password + '\r\n');
    const servers: { id: string; port: number }[] = [];
    t.after(async () => {
      await Promise.all(servers.map((s) => exec('docker', ['rm', '-f', s.id])));
    });
    async function cli(server: { id: string }, ...args: string[]) {
      return (
        await exec('docker', ['exec', server.id, 'redis-cli', '--raw', ...args], { timeout: 10000 })
      ).stdout.trim();
    }
    for (const marker of ['A_ONLY', 'B_PRIVATE']) {
      const id = (
        await exec('docker', [
          'run',
          '--rm',
          '-d',
          '-p',
          '127.0.0.1::6379',
          image,
          'redis-server',
          '--save',
          '',
          '--appendonly',
          'no',
        ])
      ).stdout.trim();
      const server = { id, port: 0 };
      servers.push(server);
      server.port = Number(
        (await exec('docker', ['port', id, '6379/tcp'])).stdout.trim().split(':').at(-1),
      );
      for (let i = 0; ; i++) {
        try {
          if ((await cli(server, 'PING')) === 'PONG') break;
        } catch {
          /* container startup */
        }
        if (i > 50) throw new Error('REDIS_START_TIMEOUT');
        await new Promise((r) => setTimeout(r, 50));
      }
      await cli(server, 'SET', 'same', marker, 'EX', '300');
      await cli(server, 'HSET', 'hash', 'field', marker);
      await cli(server, 'RPUSH', 'list', 'one', 'two', 'three', 'four');
      await cli(server, 'ZADD', 'sorted', '1', 'one', '2', 'two');
      await cli(server, 'XADD', 'stream', '*', 'field', marker);
      await cli(server, 'SET', 'large', 'x'.repeat(4000));
      for (let i = 0; i < 120; i++) await cli(server, 'SET', `scan:${i}`, marker);
      await cli(server, '-n', '1', 'SET', 'same', 'DB_ONE_' + marker);
      const acl = await cli(
        server,
        'ACL',
        'SETUSER',
        'diagnostic',
        'reset',
        'on',
        '>' + password,
        '~*',
        '+ping',
        '+select',
        '+client|setinfo',
        '+info',
        '+dbsize',
        '+type',
        '+ttl',
        '+scan',
        '+get',
        '+hget',
        '+hexists',
        '+llen',
        '+lrange',
        '+zrange',
        '+xrange',
      );
      assert.equal(acl, 'OK');
    }
    const a = servers[0]!,
      b = servers[1]!;
    const config = {
      host: '127.0.0.1',
      port: a.port,
      username: 'diagnostic',
      passwordFile: './password',
      maxItems: 3,
      maxResultBytes: 2048,
      queryTimeoutMs: 2000,
    };
    async function bind(
      changes: Partial<Omit<typeof config, 'passwordFile'>> & {
        database?: number;
        password?: string;
        passwordFile?: string | undefined;
      } = {},
    ) {
      const selected = { ...config, ...changes };
      const { passwordFile, ...rest } = selected;
      const plugin = await redis.create(
        { ...rest, ...(passwordFile !== undefined ? { passwordFile } : {}) },
        context(root),
      );
      const bound = await plugin.tools!.bind(bindingContext());
      assert.equal(bound.status, 'ready', JSON.stringify(bound));
      if (bound.status !== 'ready') throw new Error('REDIS_BIND_FAILED');
      t.after(() => bound.binding.close());
      return bound;
    }
    const first = await bind();
    const second = await bind({ port: b.port });
    const call = (name: string, input: JsonObject = {}) =>
      first.binding.call(name, input, new AbortController().signal);
    const read = await call('get', { key: 'same' });
    assert.equal(read.status, 'ok');
    assert.equal(read.content, 'A_ONLY');
    assert.equal(read.resources[0]!.database, 0);
    assert.equal((await call('info', { section: 'memory' })).status, 'ok');
    assert.equal((await call('dbsize')).status, 'ok');
    assert.equal((await call('type', { key: 'same' })).status, 'ok');
    assert.ok(JSON.stringify((await call('type', { key: 'same' })).content).includes('ttl'));
    for (const [name, input] of [
      ['hget', { name: 'hash', key: 'field' }],
      ['hexists', { name: 'hash', key: 'field' }],
      ['llen', { name: 'list' }],
      ['lrange', { name: 'list', start: 0, stop: 1 }],
      ['zrange', { key: 'sorted', start: 0, end: 1 }],
      ['xrange', { key: 'stream', count: 1 }],
    ] as [string, JsonObject][])
      assert.equal((await call(name, input)).status, 'ok', name);
    const page = await call('scan_keys', { pattern: 'scan:*', count: 1 });
    assert.equal(page.status, 'ok');
    assert.equal(page.truncated, true);
    assert.ok(JSON.stringify(page.content).includes('cursor'));
    assert.equal((await call('get', { key: 'large' })).truncated, true);
    for (const [name, input] of [
      ['delete', { key: 'same' }],
      ['set', { key: 'same', value: 'bad' }],
      ['scan_all_keys', {}],
      ['get', { key: 'same', host: 'b.invalid', port: b.port }],
      ['get', { key: 'same', database: 1 }],
      ['lrange', { name: 'list', start: 0, stop: -1 }],
      ['scan_keys', { count: 4 }],
    ] as [string, JsonObject][])
      assert.equal((await call(name, input)).status, 'error');
    const bCommands = await cli(b, 'INFO', 'commandstats');
    assert.ok(!bCommands.includes('cmdstat_get:'), 'binding B must not connect/query on A calls');
    assert.equal(
      await cli(a, '--user', 'diagnostic', '--pass', password, 'SET', 'same', 'bad'),
      "NOPERM User diagnostic has no permissions to run the 'set' command",
    );
    assert.equal(await cli(a, 'GET', 'same'), 'A_ONLY');
    const dbOne = await bind({ database: 1 });
    assert.equal(
      (await dbOne.binding.call('get', { key: 'same' }, new AbortController().signal)).content,
      'DB_ONE_A_ONLY',
    );
    const bad = await bind({ passwordFile: undefined, password: 'wrong-password' });
    assert.equal(
      (await bad.binding.call('get', { key: 'same' }, new AbortController().signal)).status,
      'error',
    );
    assert.equal(
      (await bad.binding.call('type', { key: 'same' }, new AbortController().signal)).status,
      'error',
    );
    assert.equal(
      (await call('get', { key: 'hash' })).status,
      'error',
      'WRONGTYPE is not business success',
    );
    await cli(a, 'CLIENT', 'PAUSE', '3000');
    const cancel = new AbortController();
    const pending = first.binding.call('get', { key: 'same' }, cancel.signal);
    setTimeout(() => cancel.abort(), 50);
    const cancelled = await pending;
    assert.equal(cancelled.failure?.code, 'QUERY_CANCELLED');
    await first.binding.close();
    assert.equal(
      (await second.binding.call('get', { key: 'same' }, new AbortController().signal)).content,
      'B_PRIVATE',
    );
    await exec('docker', ['stop', a.id]);
    // --rm removes the stopped container; retain only B for cleanup.
    servers.splice(servers.indexOf(a), 1);
    const down = await bind();
    assert.equal(
      (await down.binding.call('get', { key: 'same' }, new AbortController().signal)).status,
      'error',
    );
  },
);
