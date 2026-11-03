import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mcpProvider } from '../src/mcp/process.js';
import { openToolBridge } from '../src/mcp/bridge.js';
import { Redactor } from '../src/core/redaction.js';
import type {
  BoundDiagnosticTool,
  ToolBindingContext,
  ToolDefinition,
} from '../src/plugin-api/index.js';
const bindingContext = (): ToolBindingContext => ({
  investigationId: 'incident',
  turnId: 'turn',
  targetId: 'a',
  scopeRevision: 'a'.repeat(64),
  signal: AbortSignal.timeout(15000),
});
const read: ToolDefinition = {
  name: 'read',
  description: 'Read',
  readOnly: true,
  inputSchema: {
    type: 'object',
    properties: { delayMs: { type: 'integer', minimum: 0 } },
    additionalProperties: false,
  },
};

test('official stdio transport honors catalog contracts, environment whitelist, scope and independent closure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-mcp-test-'));
  const catalog = path.join(root, 'catalog.json');
  const record = path.join(root, 'calls.jsonl');
  await writeFile(catalog, JSON.stringify([read]));
  const provider = mcpProvider({
    allowedTools: ['read'],
    startupTimeoutMs: 2000,
    queryTimeoutMs: 200,
    maxResultBytes: 1024,
    async command() {
      return {
        command: process.execPath,
        args: [path.resolve(import.meta.dirname, 'fixtures/mcp-server.mjs'), catalog, record],
      };
    },
    prepare(_name, input) {
      return input;
    },
    resources() {
      return [{ cluster: 'a' }];
    },
    sanitize: (value) => new Redactor().value(value),
  });
  process.env.INCIDENT_TEST_B_SECRET = 'SYNTHETIC_B_CREDENTIAL';
  try {
    const a = await provider.bind(bindingContext());
    const b = await provider.bind(bindingContext());
    assert.equal(a.status, 'ready');
    assert.equal(b.status, 'ready');
    if (a.status !== 'ready' || b.status !== 'ready') return;
    try {
      assert.equal(
        (await a.binding.call('write', {}, new AbortController().signal)).status,
        'error',
      );
      assert.equal(
        (await a.binding.call('read', { address: 'B' }, new AbortController().signal)).status,
        'error',
      );
      await a.binding.close();
      assert.equal((await b.binding.call('read', {}, new AbortController().signal)).status, 'ok');
      const timed = await b.binding.call('read', { delayMs: 500 }, new AbortController().signal);
      assert.equal(timed.status, 'error');
      assert.equal(timed.failure?.remoteStatus, 'unknown');
      assert.ok(
        !JSON.parse((await readFile(record, 'utf8')).split('\n')[0]!).inheritedUnexpectedEnv,
      );
      await writeFile(
        catalog,
        JSON.stringify([
          { ...read, inputSchema: { type: 'object', properties: { changed: { type: 'string' } } } },
        ]),
      );
      await assert.rejects(provider.bind(bindingContext()), /TOOL_CATALOG_CHANGED/);
    } finally {
      await a.binding.close();
      await b.binding.close();
    }
  } finally {
    delete process.env.INCIDENT_TEST_B_SECRET;
    await rm(root, { recursive: true, force: true });
  }
});

test('loopback MCP bridge authenticates, gates protocol methods and exposes only bound tools', async (t) => {
  let calls = 0;
  const bound: BoundDiagnosticTool = {
    providerInstanceId: 'a',
    definition: read,
    async call() {
      calls++;
      return {
        id: 'e',
        investigationId: 'i',
        turnId: 't',
        targetId: 'a',
        providerInstanceId: 'a',
        toolName: 'read',
        parameters: {},
        resources: [],
        observedAt: new Date().toISOString(),
        status: 'ok',
        content: 'A',
        truncated: false,
      };
    },
  };
  const bridge = await openToolBridge(
    [bound, { ...bound, definition: { ...read, name: 'remote', readOnly: false } }],
    new AbortController().signal,
  );
  t.after(() => bridge.close());
  const request = (method: string, token = bridge.token) =>
    fetch(bridge.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
    });
  assert.equal((await request('tools/list', 'wrong')).status, 401);
  for (const method of ['completion/complete', 'resources/read', 'prompts/get', 'logging/setLevel'])
    assert.equal((await request(method)).status, 403);
  const client = new Client(
    { name: 'test', version: '1' },
    { versionNegotiation: { mode: 'legacy' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(bridge.url), {
      requestInit: { headers: { authorization: 'Bearer ' + bridge.token } },
    }),
  );
  try {
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      ['read', 'remote'],
    );
    const catalog = (await client.listTools()).tools;
    assert.equal(catalog.find((t) => t.name === 'read')!.annotations?.readOnlyHint, true);
    assert.equal(catalog.find((t) => t.name === 'remote')!.annotations?.readOnlyHint, false);
    assert.equal((await client.callTool({ name: 'read', arguments: {} })).isError, false);
    await assert.rejects(client.callTool({ name: 'b_read', arguments: {} }), /not found/);
    assert.equal(calls, 1);
  } finally {
    await client.close();
  }
});

test('catalog relay preserves upstream side effects and rejects additions or changed annotations', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-mcp-relay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, 'catalog.json');
  const record = path.join(root, 'calls.jsonl');
  const write = { ...read, name: 'write', readOnly: false };
  const unannotated = { ...read, name: 'unannotated', readOnly: null };
  await writeFile(catalog, JSON.stringify([read, write, unannotated]));
  const provider = mcpProvider({
    startupTimeoutMs: 2000,
    queryTimeoutMs: 1000,
    maxResultBytes: 1024,
    command: async () => ({
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, 'fixtures/mcp-server.mjs'), catalog, record],
    }),
    prepare: (_name, input) => input,
    resources: () => [],
    sanitize: (value) => new Redactor().value(value),
  });
  const a = await provider.bind(bindingContext());
  assert.equal(a.status, 'ready');
  if (a.status !== 'ready') return;
  try {
    assert.equal(a.definitions!.find((d) => d.name === 'read')!.readOnly, true);
    assert.equal(a.definitions!.find((d) => d.name === 'write')!.readOnly, false);
    assert.equal(a.definitions!.find((d) => d.name === 'unannotated')!.readOnly, false);
    assert.equal((await a.binding.call('write', {}, new AbortController().signal)).status, 'ok');
  } finally {
    await a.binding.close();
  }
  await writeFile(catalog, JSON.stringify([read, { ...write, readOnly: true }, unannotated]));
  await assert.rejects(provider.bind(bindingContext()), /TOOL_CATALOG_CHANGED/);
  await writeFile(catalog, JSON.stringify([read, write, unannotated, { ...read, name: 'new' }]));
  await assert.rejects(provider.bind(bindingContext()), /TOOL_CATALOG_CHANGED/);
});

test('MCP relay accepts dynamic fields allowed by additionalProperties and patternProperties', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-mcp-dynamic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, 'catalog.json'),
    record = path.join(root, 'calls.jsonl');
  await writeFile(
    catalog,
    JSON.stringify([
      {
        ...read,
        name: 'additional',
        inputSchema: {
          type: 'object',
          properties: { fixed: { type: 'string' } },
          additionalProperties: { type: 'string' },
        },
      },
      {
        ...read,
        name: 'pattern',
        inputSchema: {
          type: 'object',
          properties: { fixed: { type: 'string' } },
          patternProperties: { '^metric_': { type: 'integer' } },
          additionalProperties: false,
        },
      },
    ]),
  );
  const provider = mcpProvider({
    startupTimeoutMs: 2000,
    queryTimeoutMs: 1000,
    maxResultBytes: 1024,
    command: async () => ({
      command: process.execPath,
      args: [path.resolve(import.meta.dirname, 'fixtures/mcp-server.mjs'), catalog, record],
    }),
    prepare: (_name, input) => input,
    resources: () => [],
    sanitize: (value) => new Redactor().value(value),
  });
  const bound = await provider.bind(bindingContext());
  assert.equal(bound.status, 'ready');
  if (bound.status !== 'ready') return;
  t.after(() => bound.binding.close());
  const signal = new AbortController().signal;
  assert.equal(
    (await bound.binding.call('additional', { fixed: 'x', extra: 'valid' }, signal)).status,
    'ok',
  );
  assert.equal(
    (await bound.binding.call('pattern', { fixed: 'x', metric_count: 2 }, signal)).status,
    'ok',
  );
  assert.equal((await bound.binding.call('additional', { extra: 2 }, signal)).status, 'error');
  assert.equal((await bound.binding.call('pattern', { other: 2 }, signal)).status, 'error');
  const calls = (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.map((call) => call.arguments),
    [
      { fixed: 'x', extra: 'valid' },
      { fixed: 'x', metric_count: 2 },
    ],
  );
});
