import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import redis, { redisTools } from '../src/plugins/redis/index.js';
import { compileContract } from '../src/plugin-api/index.js';
import type { JsonObject, ToolBindingContext } from '../src/plugin-api/index.js';

const bindingContext = (): ToolBindingContext => ({
  investigationId: 'event',
  turnId: 'turn',
  targetId: 'a',
  scopeRevision: 'a'.repeat(64),
  signal: new AbortController().signal,
});
test('Redis schema rejects URI credentials, topology switches and invalid limits', () => {
  const parser = compileContract(redis.manifest.configSchema, 'redis');
  for (const value of [
    { host: 'redis://user:secret@host' },
    { host: 'localhost', database: -1 },
    { host: 'localhost', cluster: true },
    { host: 'localhost', maxItems: 1001 },
    { host: 'localhost', tls: { rejectUnauthorized: false } },
  ])
    assert.throws(() => parser.parse(value));
  parser.parse({ host: 'localhost' });
});

test('Redis credentials/TLS stay private and calls are bounded, read-only, isolated and cancellable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-redis-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'password'), ' synthetic password \r\n');
  await writeFile(path.join(root, 'ca.pem'), 'SYNTHETIC_CA');
  const record = path.join(root, 'record');
  const secrets: string[] = [];
  const context = {
    instanceId: 'redis',
    configFile: path.join(root, 'config.yaml'),
    resolvePath: (s: string) => path.resolve(root, s),
    registerSecrets: (values: readonly string[]) => {
      secrets.push(...values);
    },
  };
  const config = {
    backend: {
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, 'fixtures/redis-mcp.mjs'), record],
    },
    host: 'a.invalid',
    database: 3,
    username: 'reader',
    passwordFile: './password',
    tls: { caFile: './ca.pem' },
    maxItems: 3,
    maxResultBytes: 1024,
    queryTimeoutMs: 150,
  };
  process.env.INCIDENT_REDIS_B_SECRET = 'B_PRIVATE';
  t.after(() => {
    delete process.env.INCIDENT_REDIS_B_SECRET;
  });
  const a = await redis.create(config, context);
  const b = await redis.create({ ...config, host: 'b.invalid' }, context);
  assert.equal(secrets[0], ' synthetic password ');
  assert.ok(!JSON.stringify(a.scope).includes('password'));
  assert.notDeepEqual(a.scope, b.scope);
  const first = await a.tools!.bind(bindingContext());
  const second = await b.tools!.bind(bindingContext());
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  if (first.status !== 'ready' || second.status !== 'ready') return;
  t.after(() => first.binding.close());
  t.after(() => second.binding.close());
  assert.deepEqual(
    first.definitions!.map((d) => d.name),
    [...redisTools],
  );
  assert.ok(first.definitions!.every((d) => d.readOnly));
  const call = (name: string, input: JsonObject = {}) =>
    first.binding.call(name, input, new AbortController().signal);
  for (const [name, input] of [
    ['delete', { key: 'key' }],
    ['scan_all_keys', {}],
    ['get', { key: 'key', host: 'b.invalid' }],
    ['get', { key: 'key', database: 4 }],
    ['scan_keys', { count: 4 }],
    ['scan_keys', { cursor: -1 }],
    ['scan_keys', { cursor: 9007199254740992 }],
    ['lrange', { name: 'x', start: 0, stop: -1 }],
    ['zrange', { key: 'x', start: 0, end: 3 }],
    ['xrange', { key: 'x', count: 4 }],
  ] as [string, JsonObject][])
    assert.equal((await call(name, input)).status, 'error');
  const callsBefore = (await readFile(record, 'utf8')).trim().split('\n');
  assert.equal(callsBefore.length, 2, 'rejected requests never reach MCP');
  const startup = callsBefore.map((s) => JSON.parse(s));
  assert.ok(
    startup.every((s) => s.env.passwordMatches && !s.env.unexpectedEnv && s.env.noDotenv === '1'),
  );
  assert.equal(startup[0].env.db, '3');
  assert.equal(startup[0].env.certReqs, 'required');
  assert.equal(startup[0].env.caFile, path.join(root, 'ca.pem'));
  assert.equal((await call('get', { key: 'key' })).content, 'a.invalid');
  assert.equal(
    (await second.binding.call('get', { key: 'key' }, new AbortController().signal)).content,
    'b.invalid',
  );
  assert.equal((await call('get', { key: 'secret' })).content, '[REDACTED]');
  assert.equal((await call('get', { key: 'auth' })).status, 'error');
  assert.equal((await call('type', { key: 'type-error' })).status, 'error');
  assert.equal((await call('get', { key: 'business-error' })).status, 'ok');
  assert.equal((await call('get', { key: 'business-json' })).status, 'ok');
  assert.equal((await call('scan_keys')).truncated, true, 'empty page with a cursor is incomplete');
  assert.equal((await call('scan_keys', { pattern: 'complete' })).truncated, false);
  assert.equal((await call('lrange', { name: 'list', start: 0, stop: 2 })).truncated, true);
  assert.equal((await call('get', { key: 'large' })).truncated, true);
  const timed = await call('get', { key: 'delay' });
  assert.equal(timed.failure?.code, 'QUERY_TIMEOUT');
  assert.equal(timed.failure?.remoteStatus, 'unknown');
  const cancel = new AbortController();
  const pending = first.binding.call('get', { key: 'delay' }, cancel.signal);
  setTimeout(() => cancel.abort(), 30);
  assert.equal((await pending).failure?.code, 'QUERY_CANCELLED');
  await first.binding.close();
  await assert.rejects(access(startup[0].cwd));
  assert.equal(
    (await second.binding.call('dbsize', {}, new AbortController().signal)).status,
    'ok',
  );
  await assert.rejects(
    redis.create({ ...config, password: 'also-inline' }, context),
    /CREDENTIAL_CHOICE_INVALID/,
  );
  await assert.rejects(
    redis.create({ ...config, tls: { keyFile: './password' } }, context),
    /REDIS_TLS_CLIENT_PAIR_REQUIRED/,
  );
  const { passwordFile: _passwordFile, ...base } = config;
  const shortSecret = await redis.create({ ...base, password: 'Error' }, context);
  const shortBound = await shortSecret.tools!.bind(bindingContext());
  assert.equal(shortBound.status, 'ready');
  if (shortBound.status === 'ready') {
    t.after(() => shortBound.binding.close());
    const failed = await shortBound.binding.call(
      'get',
      { key: 'auth' },
      new AbortController().signal,
    );
    assert.equal(
      failed.status,
      'error',
      'redaction of a short secret cannot corrupt backend error recognition',
    );
    assert.ok(JSON.stringify(failed.content).includes('[REDACTED]'));
    assert.ok(!JSON.stringify(failed.content).includes('Error'));
  }
});
