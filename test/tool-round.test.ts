import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fixture, principal } from './helpers.js';
import { InvestigationStore } from '../src/core/store.js';
import { ToolRound } from '../src/core/tool-round.js';
import { runtimeDefaults } from '../src/core/runtime-config.js';
import { messageKey } from '../src/core/identity.js';
import { validateReport } from '../src/core/reports.js';
import { CommandEvidence } from '../src/plugins/codex/commands.js';
import type {
  InvestigationRequest,
  ToolProvider,
  ToolDefinition,
  ToolBindingResult,
} from '../src/plugin-api/index.js';
const definition: ToolDefinition = {
  name: 'read',
  description: 'Read',
  readOnly: true,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
async function setup(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const host = await f.loadHost();
  const store = await InvestigationStore.open(path.join(f.root, 'state'));
  t.after(() => store.close());
  async function request(): Promise<InvestigationRequest> {
    const message = {
      address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
      senderId: 'user',
      messageId: randomUUID(),
      text: 'error',
    };
    const request = {
      investigationId: randomUUID(),
      turnId: randomUUID(),
      scope: host.authorize(principal, 'a'),
      message,
    };
    await store.accept({
      version: 1,
      key: messageKey(message),
      acceptedAt: new Date().toISOString(),
      sequence: 1,
      request,
    });
    await store.setTurn(request.turnId, 'running');
    return request;
  }
  return { host, store, request };
}
test('per-round bindings and aliases isolate cancellation, reject late evidence and keep healthy sources', async (t) => {
  const f = await setup(t);
  const a = await f.request();
  const b = await f.request();
  let closed = 0;
  const provider: ToolProvider = {
    definitions: [definition],
    async bind() {
      let ownClosed = false;
      return {
        status: 'ready',
        binding: {
          async call() {
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (ownClosed) throw new Error();
            return { status: 'ok', content: 'A', resources: [], truncated: false };
          },
          async close() {
            if (!ownClosed) closed++;
            ownClosed = true;
          },
        },
      };
    },
  };
  const abort = new AbortController();
  const roundA = new ToolRound(a, f.store, f.host.redactor, runtimeDefaults, abort.signal);
  const roundB = new ToolRound(
    b,
    f.store,
    f.host.redactor,
    runtimeDefaults,
    new AbortController().signal,
  );
  try {
    await roundA.open([
      { instanceId: 'a-tools', provider },
      {
        instanceId: 'unavailable',
        provider: {
          definitions: [],
          async bind() {
            return {
              status: 'unavailable',
              failure: { code: 'OFFLINE', message: 'source offline' },
            };
          },
        },
      },
    ]);
    await roundB.open([{ instanceId: 'a-tools', provider }]);
    assert.equal(roundA.tools[0]!.definition.name, roundB.tools[0]!.definition.name);
    const late = roundA.tools[0]!.call({}, abort.signal);
    abort.abort();
    await roundA.close();
    await assert.rejects(late);
    assert.equal((await roundB.tools[0]!.call({}, new AbortController().signal)).status, 'ok');
    assert.equal((await f.store.evidence(a.turnId)).filter((e) => e.toolName === 'read').length, 0);
    assert.equal((await f.store.evidence(a.turnId))[0]!.status, 'unavailable');
    assert.equal(closed, 1);
  } finally {
    await roundA.close();
    await roundB.close();
  }
  assert.equal(closed, 2);
});
test('partial startup timeout, late acquisition after close and complete metadata budgets are enforced', async (t) => {
  const f = await setup(t);
  const request = await f.request();
  let readyClosed = 0;
  let release: ((result: ToolBindingResult) => void) | undefined;
  const round = new ToolRound(
    request,
    f.store,
    f.host.redactor,
    { ...runtimeDefaults, queryTimeoutMs: 20, maxResultBytes: 500, maxTotalBytes: 1000 },
    new AbortController().signal,
  );
  const healthy: ToolProvider = {
    definitions: [definition],
    async bind() {
      return {
        status: 'ready',
        binding: {
          async call() {
            return {
              status: 'ok',
              content: null,
              resources: [{ huge: 'x'.repeat(10000) }],
              truncated: false,
            };
          },
          async close() {
            readyClosed++;
          },
        },
      };
    },
  };
  await round.open([
    { instanceId: 'healthy', provider: healthy },
    {
      instanceId: 'stalled',
      provider: {
        definitions: [],
        bind: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      },
    },
  ]);
  assert.deepEqual(round.unavailable, ['stalled']);
  assert.equal(round.tools.length, 1);
  const result = await round.tools[0]!.call({}, new AbortController().signal);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.resources, []);
  assert.equal(round.metrics.returnedBytes, 1000);
  await assert.rejects(round.tools[0]!.call({}, new AbortController().signal), /BUDGET/);
  await round.close();
  release!({
    status: 'ready',
    binding: {
      async call() {
        throw new Error();
      },
      async close() {
        readyClosed++;
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readyClosed, 2);
});
test('report validation rejects fabricated, cross-event and failed-evidence facts', async (t) => {
  const f = await setup(t);
  const request = await f.request();
  const report = {
    investigationId: request.investigationId,
    turnId: request.turnId,
    targetId: 'a',
    facts: [{ text: 'confirmed', evidenceIds: ['B-evidence'] }],
    hypotheses: [],
    recommendations: [],
    missingEvidence: [],
  };
  assert.throws(() => validateReport(report, request, []), /REPORT_REFERENCE_INVALID/);
  const evidence = {
    id: 'B-evidence',
    investigationId: 'other',
    turnId: request.turnId,
    targetId: 'a',
    providerInstanceId: 'a-tools',
    toolName: 'read',
    parameters: {},
    resources: [],
    observedAt: new Date().toISOString(),
    status: 'ok' as const,
    content: null,
    truncated: false,
  };
  assert.throws(() => validateReport(report, request, [evidence]), /REPORT_REFERENCE_INVALID/);
  assert.throws(
    () =>
      validateReport(report, request, [
        {
          ...evidence,
          investigationId: request.investigationId,
          status: 'error',
          failure: { code: 'FAIL', message: 'offline' },
        },
      ]),
    /REPORT_FACT_UNSUPPORTED/,
  );
});

test('native observations share host identity, redaction, budgets and cancellation with MCP evidence', async (t) => {
  const f = await setup(t);
  const request = await f.request();
  f.host.redactor.add(['SYNTHETIC_NATIVE_SECRET']);
  const abort = new AbortController();
  const round = new ToolRound(
    request,
    f.store,
    f.host.redactor,
    { ...runtimeDefaults, maxToolCalls: 3, maxResultBytes: 1000, maxTotalBytes: 2000 },
    abort.signal,
  );
  const observation = {
    toolName: 'command_execution',
    parameters: { command: 'read SYNTHETIC_NATIVE_SECRET' },
    result: {
      status: 'ok' as const,
      content: 'SYNTHETIC_NATIVE_SECRET result',
      resources: [],
      truncated: false,
    },
  };
  try {
    const first = await round.recordEngineEvidence(observation, abort.signal);
    assert.equal(first.targetId, request.scope.target.targetId);
    assert.equal(first.investigationId, request.investigationId);
    assert.equal(first.providerInstanceId, request.scope.target.engine.instanceId);
    assert.ok(!JSON.stringify(first).includes('SYNTHETIC_NATIVE_SECRET'));
    const failure = await round.recordEngineEvidence(
      {
        ...observation,
        result: {
          status: 'error',
          content: null,
          resources: [],
          truncated: false,
          failure: { code: 'LOCAL_COMMAND_FAILED', message: 'failed', remoteStatus: 'unknown' },
        },
      },
      abort.signal,
    );
    assert.throws(
      () =>
        validateReport(
          {
            investigationId: request.investigationId,
            turnId: request.turnId,
            targetId: 'a',
            facts: [{ text: 'confirmed', evidenceIds: [failure.id] }],
            hypotheses: [],
            recommendations: [],
            missingEvidence: [],
          },
          request,
          [failure],
        ),
      /REPORT_FACT_UNSUPPORTED/,
    );
    const large = await round.recordEngineEvidence(
      { ...observation, result: { ...observation.result, content: 'x'.repeat(10000) } },
      abort.signal,
    );
    assert.equal(large.status, 'error');
    assert.equal(large.truncated, true);
    assert.equal(large.failure!.code, 'RESULT_BUDGET_EXHAUSTED');
    await assert.rejects(round.recordEngineEvidence(observation, abort.signal), /BUDGET/);
    assert.equal((await f.store.evidence(request.turnId)).length, 3);
    abort.abort();
    await assert.rejects(round.recordEngineEvidence(observation, abort.signal));
  } finally {
    await round.close();
  }
  await assert.rejects(
    round.recordEngineEvidence(observation, new AbortController().signal),
    /TURN_CLOSED/,
  );
});

test('reading native evidence cannot replay captured output outside call or byte budgets', async (t) => {
  const f = await setup(t);
  for (const limits of [
    { maxToolCalls: 1, maxTotalBytes: 10000 },
    { maxToolCalls: 10, maxTotalBytes: 1200 },
  ]) {
    const request = await f.request();
    const signal = new AbortController().signal;
    const round = new ToolRound(
      request,
      f.store,
      f.host.redactor,
      { ...runtimeDefaults, maxResultBytes: 1000, ...limits },
      signal,
    );
    const commands = new CommandEvidence('engine', (observation, callSignal) =>
      round.recordEngineEvidence(observation, callSignal),
    );
    try {
      await commands.observe(
        {
          id: 'command-1',
          type: 'command_execution',
          command: 'read',
          aggregated_output: 'x'.repeat(700),
          status: 'completed',
          exit_code: 0,
        },
        signal,
      );
      if (limits.maxToolCalls === 1)
        await assert.rejects(commands.tool!.call({}, signal), /BUDGET/);
      else {
        const result = await commands.tool!.call({}, signal);
        assert.equal(result.status, 'error');
        assert.equal(result.truncated, true);
        assert.equal(result.content, null);
        await assert.rejects(commands.tool!.call({}, signal), /BUDGET/);
      }
    } finally {
      await round.close();
    }
  }
});

test('native failed command records retain remote uncertainty when read for report citations', async (t) => {
  const f = await setup(t);
  const request = await f.request();
  const signal = new AbortController().signal;
  const round = new ToolRound(request, f.store, f.host.redactor, runtimeDefaults, signal);
  const commands = new CommandEvidence('engine', (observation, callSignal) =>
    round.recordEngineEvidence(observation, callSignal),
  );
  try {
    await commands.observe(
      {
        id: 'failed-command',
        type: 'command_execution',
        command: 'ssh dev read',
        aggregated_output: 'connection lost',
        status: 'failed',
        exit_code: 255,
      },
      signal,
    );
    const result = await commands.tool!.call({}, signal);
    assert.equal(result.status, 'error');
    assert.equal(result.failure!.remoteStatus, 'unknown');
    const records = await f.store.evidence(request.turnId);
    assert.equal(records.length, 2);
    assert.equal(
      result.parameters.sourceEvidenceId,
      records.find((e) => e.toolName === 'command_execution')!.id,
    );
  } finally {
    await round.close();
  }
});

test('tool protocol survives secrets matching schema types, names and result states while business data stays redacted', async (t) => {
  const f = await setup(t);
  const request = await f.request();
  const secrets = ['object', 'string', 'get', 'ok', 'error', 'unknown'];
  f.host.redactor.add(secrets);
  let failed = false;
  const provider: ToolProvider = {
    definitions: [
      {
        name: 'get',
        description: 'get object string ok error unknown',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: { key: { type: 'string' } },
          required: ['key'],
          additionalProperties: false,
        },
      },
    ],
    async bind() {
      return {
        status: 'ready',
        binding: {
          async close() {},
          async call(name) {
            assert.equal(name, 'get', 'the original backend tool name is retained');
            return {
              status: failed ? 'error' : 'ok',
              content: secrets.join(' '),
              resources: [{ label: secrets.join(' ') }],
              truncated: false,
              ...(failed
                ? {
                    failure: {
                      code: 'UPSTREAM_TOOL_FAILED',
                      message: 'error unknown',
                      remoteStatus: 'unknown' as const,
                    },
                  }
                : {}),
            };
          },
        },
      };
    },
  };
  const signal = new AbortController().signal;
  const round = new ToolRound(request, f.store, f.host.redactor, runtimeDefaults, signal);
  t.after(() => round.close());
  await round.open([{ instanceId: 'get', provider }]);
  assert.ok(!round.tools[0]!.definition.description.includes('get'));
  const good = await round.tools[0]!.call({ key: 'ok' }, signal);
  assert.equal(good.status, 'ok');
  assert.equal(good.toolName, 'get');
  assert.equal(good.content, secrets.map(() => '[REDACTED]').join(' '));
  assert.equal(good.parameters.key, '[REDACTED]');
  assert.equal(good.resources[0]!.label, good.content);
  failed = true;
  const bad = await round.tools[0]!.call({ key: 'error' }, signal);
  assert.equal(bad.status, 'error');
  assert.equal(bad.failure?.remoteStatus, 'unknown');
  assert.equal(bad.failure?.message, '[REDACTED] [REDACTED]');
  const native = await round.recordEngineEvidence(
    {
      toolName: 'native',
      parameters: {},
      result: {
        status: 'error',
        content: 'error',
        resources: [],
        truncated: false,
        failure: { code: 'FAIL', message: 'unknown', remoteStatus: 'unknown' },
      },
    },
    signal,
  );
  assert.equal(native.status, 'error');
  assert.equal(native.failure?.remoteStatus, 'unknown');
  assert.equal(native.content, '[REDACTED]');
  assert.deepEqual(
    (await f.store.evidence(request.turnId)).map((e) => e.status),
    ['ok', 'error', 'error'],
  );
});

test('unavailable bindings share evidence redaction and complete result budgets', async (t) => {
  const f = await setup(t),
    request = await f.request();
  f.host.redactor.add(['SYNTHETIC_BINDING_PASSWORD']);
  const round = new ToolRound(
    request,
    f.store,
    f.host.redactor,
    { ...runtimeDefaults, maxResultBytes: 500, maxTotalBytes: 1000 },
    new AbortController().signal,
  );
  t.after(() => round.close());
  await round.open([
    {
      instanceId: 'offline',
      provider: {
        definitions: [],
        async bind() {
          return {
            status: 'unavailable',
            failure: { code: 'AUTH_FAILED', message: 'password=SYNTHETIC_BINDING_PASSWORD' },
          };
        },
      },
    },
    {
      instanceId: 'oversized',
      provider: {
        definitions: [],
        async bind() {
          return { status: 'unavailable', failure: { code: 'OFFLINE', message: 'x'.repeat(5000) } };
        },
      },
    },
  ]);
  const evidence = await f.store.evidence(request.turnId);
  const offline = evidence.find((item) => item.providerInstanceId === 'offline')!;
  assert.equal(offline.status, 'unavailable');
  assert.equal(offline.failure?.message, 'password=[REDACTED]');
  assert.ok(!JSON.stringify(evidence).includes('SYNTHETIC_BINDING_PASSWORD'));
  const oversized = evidence.find((item) => item.providerInstanceId === 'oversized')!;
  assert.equal(oversized.failure?.code, 'RESULT_BUDGET_EXHAUSTED');
  assert.equal(oversized.truncated, true);
  assert.equal(round.metrics.returnedBytes, 1000);
});
