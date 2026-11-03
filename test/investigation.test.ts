import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.js';
import { InvestigationStore } from '../src/core/store.js';
import { InvestigationCoordinator } from '../src/core/coordinator.js';
import type { ChannelMessage } from '../src/plugin-api/index.js';
const input = (messageId: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
  address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
  senderId: 'user',
  messageId,
  text: 'ERROR same-name web',
  targetId: 'a',
  ...extra,
});
async function setup(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  await copyFile(
    new URL('./fixtures/investigation-plugin.mjs', import.meta.url),
    path.join(f.root, 'plugin.mjs'),
  );
  async function open() {
    const host = await f.loadHost();
    const store = await InvestigationStore.open(path.join(f.root, 'state'));
    const coordinator = new InvestigationCoordinator(host, store);
    return { host, store, coordinator };
  }
  return { ...f, open };
}
test('two same-target events cancel independently; B tools receive zero A queries; followup preserves evidence ownership', async (t) => {
  const f = await setup(t);
  await f.writePrivate('a-tools', { delayMs: 100 });
  const { store, coordinator } = await f.open();
  t.after(() => coordinator.close());
  await coordinator.start();
  const a = await coordinator.handle(input('a-one'));
  const b = await coordinator.handle(input('a-two'));
  if (a.status !== 'accepted' || b.status !== 'accepted') throw new Error();
  while (store.turn(a.turnId).status !== 'running' || store.turn(b.turnId).status !== 'running')
    await new Promise((resolve) => setTimeout(resolve, 5));
  await coordinator.handle(
    input('cancel-a', { investigationId: a.investigationId, action: 'cancel' }),
  );
  await coordinator.idle();
  assert.equal(store.turn(a.turnId).status, 'cancelled');
  assert.equal(store.turn(b.turnId).status, 'completed');
  const follow = await coordinator.handle(
    input('follow-b', { investigationId: b.investigationId }),
  );
  if (follow.status !== 'accepted') throw new Error();
  await coordinator.idle();
  assert.equal(store.turn(follow.turnId).status, 'completed');
  const evidence = await store.evidence(follow.turnId);
  assert.ok(evidence.every((e) => e.investigationId === b.investigationId && e.targetId === 'a'));
  assert.ok(evidence.some((e) => e.providerInstanceId === 'a-tools'));
  for (const delivery of store.deliveries()) {
    const origin = store
      .acceptances()
      .find((record) => record.request.turnId === delivery.message.reference?.turnId);
    assert.ok(origin);
    assert.equal(delivery.message.replyToMessageId, origin.request.message.messageId);
  }
  const events = (await f.events()).map((s) => JSON.parse(s));
  assert.ok(!events.some((e) => e.action === 'query' && e.instanceId === 'b-tools'));
});
test('invalid report gets bounded repair; failure never publishes a completed report', async (t) => {
  const f = await setup(t);
  await f.writePrivate('engine', { invalidReports: 1 });
  let runtime = await f.open();
  await runtime.coordinator.start();
  const repaired = await runtime.coordinator.handle(input('repair'));
  if (repaired.status !== 'accepted') throw new Error();
  await runtime.coordinator.idle();
  assert.equal(runtime.store.turn(repaired.turnId).status, 'completed');
  await runtime.coordinator.close();
  await f.writePrivate('engine', { invalidReports: 99 });
  runtime = await f.open();
  t.after(() => runtime.coordinator.close());
  await runtime.coordinator.start();
  const failed = await runtime.coordinator.handle(input('bad-report'));
  if (failed.status !== 'accepted') throw new Error();
  await runtime.coordinator.idle();
  assert.equal(runtime.store.turn(failed.turnId).status, 'failed');
  assert.equal(runtime.store.turn(failed.turnId).failure, 'REPORT_INVALID');
  const messages = runtime.store
    .deliveries()
    .filter((d) => d.message.reference?.turnId === failed.turnId);
  assert.ok(messages.every((d) => !d.message.text.includes('疑似原因')));
});
test('lost receipts retry after restart without replaying model or queries', async (t) => {
  const f = await setup(t);
  await f.writePrivate('chat', { failSends: 10 });
  let runtime = await f.open();
  await runtime.coordinator.start();
  const first = await runtime.coordinator.handle(input('initial'));
  if (first.status !== 'accepted') throw new Error();
  await runtime.coordinator.idle();
  assert.ok(runtime.store.deliveries().every((d) => d.status === 'unknown'));
  await runtime.coordinator.close();
  await f.writePrivate('chat', { failSends: 0 });
  runtime = await f.open();
  t.after(() => runtime.coordinator.close());
  await runtime.coordinator.start();
  await runtime.coordinator.idle();
  assert.equal(runtime.coordinator.metrics.turns, 0);
  await runtime.coordinator.handle(
    input('retry', { investigationId: first.investigationId, action: 'retry-delivery' }),
  );
  await runtime.coordinator.idle();
  assert.equal(runtime.coordinator.metrics.turns, 0);
  assert.ok(runtime.store.deliveries().every((d) => d.status === 'sent'));
});
test('queued restart with changed scope fails once instead of spinning', async (t) => {
  const f = await setup(t);
  let runtime = await f.open();
  const first = await runtime.coordinator.handle(input('queued'));
  if (first.status !== 'accepted') throw new Error();
  await runtime.coordinator.close();
  await f.writePrivate('a-tools', { resourceId: 'CHANGED_CLUSTER' });
  runtime = await f.open();
  t.after(() => runtime.coordinator.close());
  await runtime.coordinator.start();
  await runtime.coordinator.idle();
  assert.equal(runtime.store.turn(first.turnId).status, 'failed');
  assert.equal(runtime.store.turn(first.turnId).failure, 'TARGET_SCOPE_CHANGED');
  assert.equal(runtime.coordinator.metrics.turns, 0);
});

test('a fresh session after unavailable sources receives the original scoped investigation context', async (t) => {
  const f = await setup(t);
  await f.writePrivate('a-tools', { unavailable: true });
  let runtime = await f.open();
  await runtime.coordinator.start();
  const first = await runtime.coordinator.handle(
    input('offline', { text: 'ORIGINAL_ERROR_CONNECTION_POOL' }),
  );
  if (first.status !== 'accepted') throw new Error();
  await runtime.coordinator.idle();
  const initial = runtime.store.turn(first.turnId);
  assert.equal(initial.status, 'completed');
  assert.equal(initial.sessionHandle, undefined);
  assert.deepEqual(initial.report!.hypotheses, []);
  await runtime.coordinator.close();
  await f.writePrivate('a-tools', { unavailable: false });
  runtime = await f.open();
  t.after(() => runtime.coordinator.close());
  await runtime.coordinator.start();
  const follow = await runtime.coordinator.handle(
    input('back-online', { investigationId: first.investigationId, text: '现在呢？' }),
  );
  if (follow.status !== 'accepted') throw new Error();
  await runtime.coordinator.idle();
  assert.equal(runtime.store.turn(follow.turnId).status, 'completed');
  const run = (await f.events())
    .map((s) => JSON.parse(s))
    .find((e) => e.action === 'run' && e.turnId === follow.turnId);
  assert.equal(run.historyFirstText, 'ORIGINAL_ERROR_CONNECTION_POOL');
});

test('partial source failure is visible to the engine and preserved in the final report', async (t) => {
  const f = await setup(t);
  await f.writePrivate('offline-tools', { unavailable: true });
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      'offline-tools': { module: './plugin.mjs', configFile: './private/offline-tools.yaml' },
    },
    targets: { ...f.config.targets, a: { engine: 'engine', tools: ['a-tools', 'offline-tools'] } },
  });
  const { store, coordinator } = await f.open();
  t.after(() => coordinator.close());
  await coordinator.start();
  const result = await coordinator.handle(input('partial'));
  if (result.status !== 'accepted') throw new Error();
  await coordinator.idle();
  const state = store.turn(result.turnId);
  assert.equal(state.status, 'completed');
  assert.ok(state.report!.missingEvidence.some((message) => message.includes('offline-tools')));
  const run = (await f.events()).map((s) => JSON.parse(s)).find((e) => e.action === 'run');
  assert.deepEqual(run.unavailableContext, ['offline-tools']);
});

test('native engines investigate without MCP tools and keep unavailable sources in the report', async (t) => {
  for (const tools of [[], ['a-tools']]) {
    const f = await setup(t);
    await f.writePrivate('engine', { nativeTools: true });
    await f.writePrivate('a-tools', { unavailable: true });
    await f.writeConfig({
      ...f.config,
      targets: { ...f.config.targets, a: { engine: 'engine', tools } },
    });
    const runtime = await f.open();
    try {
      await runtime.coordinator.start();
      const accepted = await runtime.coordinator.handle(input('native-only'));
      if (accepted.status !== 'accepted') throw new Error();
      await runtime.coordinator.idle();
      const turn = runtime.store.turn(accepted.turnId);
      assert.equal(turn.status, 'completed');
      assert.ok(turn.sessionHandle);
      assert.equal(turn.report!.facts.length, 1);
      const evidence = await runtime.store.evidence(accepted.turnId);
      const native = evidence.find((e) => e.toolName === 'command_execution')!;
      assert.equal(native.providerInstanceId, 'engine');
      assert.equal(native.targetId, 'a');
      assert.deepEqual(turn.report!.facts[0]!.evidenceIds, [native.id]);
      if (tools.length) assert.ok(turn.report!.missingEvidence.some((m) => m.includes('a-tools')));
    } finally {
      await runtime.coordinator.close();
    }
  }
});

test(
  'cancelled report repair retains confirmed usage as incomplete and checkpoints the active session',
  { timeout: 10000 },
  async (t) => {
    const f = await setup(t);
    await f.writePrivate('engine', { invalidReports: 1, recordUsage: true });
    await f.writePrivate('a-tools', { delayMs: 150 });
    const { store, coordinator } = await f.open();
    try {
      await coordinator.start();
      const first = await coordinator.handle(input('repair-usage'));
      if (first.status !== 'accepted') throw Error(first.reason);
      const deadline = Date.now() + 4000;
      while (
        (await f.events())
          .map((event) => JSON.parse(event))
          .filter((event) => event.instanceId === 'engine' && event.action === 'run').length < 2
      ) {
        assert.ok(Date.now() < deadline, 'the repair generation must start');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await coordinator.handle(
        input('cancel-usage-repair', { investigationId: first.investigationId, action: 'cancel' }),
      );
      await coordinator.idle();
      const state = store.turn(first.turnId);
      assert.equal(state.status, 'cancelled');
      assert.deepEqual(state.usage, { inputTokens: 100, outputTokens: 10, complete: false });
      assert.equal((state.sessionHandle as { usagePending: boolean }).usagePending, true);
      await coordinator.close();
      const restored = await InvestigationStore.open(store.directory);
      try {
        assert.deepEqual(restored.turn(first.turnId).usage, state.usage);
      } finally {
        await restored.close();
      }
    } finally {
      await coordinator.close();
    }
  },
);
