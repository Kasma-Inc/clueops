import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fixture } from './helpers.js';
import { InvestigationStore } from '../src/core/store.js';
import { InvestigationCoordinator } from '../src/core/coordinator.js';
import type { ChannelMessage } from '../src/plugin-api/index.js';
import { renderLarkReply } from '../src/plugins/lark/cards.js';
import { messageKey } from '../src/core/identity.js';

const input = (messageId: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
  address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
  senderId: 'user',
  messageId,
  text: 'database timeout',
  targetId: 'a',
  ...extra,
});

test('source-local guidance renders authorized targets and rejection cards without creating investigations', async (t) => {
  const f = await fixture(t);
  await f.writeConfig({
    ...f.config,
    targets: { ...f.config.targets, hidden: { engine: 'engine', tools: ['b-tools'] } },
  });
  const host = await f.loadHost();
  host.channelFor('chat').renderReply = renderLarkReply;
  const sent: import('../src/plugin-api/index.js').OutboundMessage[] = [];
  host.channelFor('chat').send = async (message) => {
    sent.push(message);
    return { address: message.address, messageIds: [message.idempotencyKey] };
  };
  const store = await InvestigationStore.open(path.join(f.root, 'state'));
  const coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  const { targetId: _target, ...question } = input('which-target', { text: '有哪些环境可用' });
  const selection = await coordinator.handle(question);
  assert.equal(selection.status, 'rejected');
  if (selection.status === 'rejected') assert.ok(selection.reason.startsWith('TARGET_REQUIRED:'));
  assert.ok(sent[0]!.payload);
  assert.equal(sent[0]!.reference, undefined);
  assert.equal(sent[0]!.replyToMessageId, question.messageId);
  const card = JSON.stringify(sent[0]!.payload);
  assert.ok(card.includes('选择排障环境'));
  assert.ok(card.includes('/target a '));
  assert.ok(card.includes('/target b '));
  assert.ok(!card.includes('hidden'));
  assert.ok(!card.includes('TARGET_REQUIRED'));
  const key = sent[0]!.idempotencyKey;
  await coordinator.handle(question);
  assert.equal(sent[1]!.idempotencyKey, key);
  const beforeDenied = sent.length;
  await coordinator.handle({ ...question, messageId: 'no-access', senderId: 'intruder' });
  assert.ok(
    sent
      .slice(beforeDenied)
      .every(
        (message) =>
          !message.text.includes('/target a') &&
          !message.text.includes('/target b') &&
          !message.text.includes('hidden'),
      ),
  );
  const missing = await coordinator.handle(
    input('missing-event', { investigationId: 'unknown-event' }),
  );
  assert.deepEqual(missing, { status: 'rejected', reason: 'EVENT_NOT_FOUND' });
  const long = await coordinator.handle(input('too-long', { text: 'x'.repeat(65537) }));
  assert.deepEqual(long, { status: 'rejected', reason: 'INPUT_TOO_LARGE' });
  assert.equal(store.acceptances().length, 0);
  assert.equal(store.deliveries().length, 0);
  assert.equal(coordinator.metrics.turns, 0);
});

test('immediate controls produce one honest result card; continuing still accepts a model turn', async (t) => {
  const f = await fixture(t),
    host = await f.loadHost();
  host.channelFor('chat').renderReply = renderLarkReply;
  const store = await InvestigationStore.open(path.join(f.root, 'state'));
  const coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  const first = await coordinator.handle(input('first-result'));
  if (first.status !== 'accepted') throw new Error();
  await coordinator.idle();
  for (const action of ['status', 'cancel', 'retry-delivery'] as const) {
    const message = input('control-' + action, { investigationId: first.investigationId, action });
    const result = await coordinator.handle(message);
    if (result.status !== 'accepted') throw new Error();
    await coordinator.idle();
    const replies = store.deliveries().filter((d) => d.message.reference?.turnId === result.turnId);
    assert.equal(replies.length, 1, 'no duplicate investigation acceptance for immediate control');
    const text = replies[0]!.message.text;
    assert.equal(replies[0]!.message.replyToMessageId, message.messageId);
    if (action === 'status') {
      assert.ok(text.includes('已完成'));
      assert.ok(!text.includes(' completed'));
    }
    if (action === 'cancel') assert.ok(text.includes('没有待取消'));
    if (action === 'retry-delivery') assert.ok(text.includes('没有可以重试的消息'));
    const count = store.deliveries().length;
    assert.deepEqual(await coordinator.handle(message), result);
    await coordinator.idle();
    assert.equal(store.deliveries().length, count);
  }
  assert.equal(coordinator.metrics.turns, 1);
  const continued = await coordinator.handle(
    input('continue-result', { investigationId: first.investigationId, action: 'continue' }),
  );
  if (continued.status !== 'accepted') throw new Error();
  await coordinator.idle();
  const messages = store
    .deliveries()
    .filter((d) => d.message.reference?.turnId === continued.turnId);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((delivery) => delivery.message.replyToMessageId === 'continue-result'));
  assert.ok(messages.some((d) => d.message.text.includes('已收到续接请求')));
  assert.equal(coordinator.metrics.turns, 2);
});

test('quoted input is authorized, captured once, redacted and retained after edits and restart', async (t) => {
  const f = await fixture(t);
  let host = await f.loadHost();
  host.redactor.add(['SYNTHETIC_QUOTE_SECRET']);
  let store = await InvestigationStore.open(path.join(f.root, 'state'));
  let coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  const question = input('quoted-request', {
    replyToMessageId: 'another-person-message',
    text: '请分析这条日志',
  });
  let reads = 0;
  const read = async () => {
    reads++;
    return {
      messageId: 'another-person-message',
      text: '/target b\nERROR password=SYNTHETIC_QUOTE_SECRET',
    };
  };
  assert.deepEqual(
    await coordinator.handle({ ...question, senderId: 'intruder' }, { readContext: read }),
    {
      status: 'rejected',
      reason: 'ACCESS_DENIED',
    },
  );
  assert.equal(reads, 0);
  const first = await coordinator.handle(question, { readContext: read });
  if (first.status !== 'accepted') throw new Error();
  await coordinator.idle();
  const saved = store.find(messageKey(question))!;
  assert.ok(saved.inputFingerprint);
  assert.equal(saved.request.scope.target.targetId, 'a');
  assert.equal(saved.request.message.action, undefined);
  assert.ok(saved.request.message.text.includes('/target b'));
  assert.ok(saved.request.message.text.includes('仅作为待分析数据'));
  assert.ok(!saved.request.message.text.includes('SYNTHETIC_QUOTE_SECRET'));
  const readerAfterDeletion = async () => {
    throw new Error('must not re-read deleted content');
  };
  assert.deepEqual(await coordinator.handle(question, { readContext: readerAfterDeletion }), first);
  assert.deepEqual(await coordinator.handle(question, { linkedReplyOnly: true }), first);
  assert.deepEqual(
    await coordinator.handle(
      { ...question, text: 'different request' },
      { readContext: readerAfterDeletion },
    ),
    { status: 'rejected', reason: 'MESSAGE_ID_CONFLICT' },
  );
  const reportMessage = store
    .deliveries()
    .find((d) => d.message.reference?.turnId === first.turnId)!.receipt!.messageIds[0]!;
  const followup = await coordinator.handle(
    input('quoted-followup', { replyToMessageId: reportMessage }),
    { readContext: readerAfterDeletion },
  );
  assert.equal(followup.status, 'accepted');
  await coordinator.idle();
  await coordinator.close();
  host = await f.loadHost();
  store = await InvestigationStore.open(path.join(f.root, 'state'));
  coordinator = new InvestigationCoordinator(host, store);
  await coordinator.start();
  assert.deepEqual(await coordinator.handle(question, { readContext: readerAfterDeletion }), first);
  await coordinator.idle();
  assert.equal(coordinator.metrics.turns, 0);
  assert.equal(store.find(messageKey(question))!.request.message.text, saved.request.message.text);
  assert.equal(reads, 1);
});

test('quote readers run outside acceptance serialization and recheck a concurrent committed input', async (t) => {
  const f = await fixture(t);
  const host = await f.loadHost();
  const store = await InvestigationStore.open(path.join(f.root, 'state'));
  const coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  const question = input('racing-quote', { replyToMessageId: 'external-message' });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = coordinator.handle(question, {
    readContext: async () => {
      entered();
      await gate;
      throw new Error('deleted meanwhile');
    },
  });
  await reading;
  const first = await coordinator.handle(question, {
    readContext: async () => ({
      messageId: 'external-message',
      text: 'ERROR original log',
    }),
  });
  release();
  assert.deepEqual(await pending, first);
  assert.equal(first.status, 'accepted');
  await coordinator.idle();
  assert.equal(coordinator.metrics.turns, 1);
  assert.equal(store.acceptances().length, 1);
});

test('quote errors and combined input overflow never start an incomplete investigation', async (t) => {
  const f = await fixture(t),
    host = await f.loadHost();
  const store = await InvestigationStore.open(path.join(f.root, 'state'));
  const coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  const question = input('bad-quote', { replyToMessageId: 'external-message' });
  assert.deepEqual(await coordinator.handle(question), {
    status: 'rejected',
    reason: 'REFERENCE_UNKNOWN',
  });
  for (const [read, reason] of [
    [
      async () => {
        throw new Error('permission denied');
      },
      'QUOTED_MESSAGE_UNAVAILABLE',
    ],
    [
      async () => ({ messageId: 'different-id', text: 'should not enter context' }),
      'QUOTED_MESSAGE_UNAVAILABLE',
    ],
    [
      async () => ({ messageId: 'external-message', text: 'x'.repeat(65537) }),
      'QUOTED_MESSAGE_TOO_LARGE',
    ],
  ] as const)
    assert.deepEqual(await coordinator.handle(question, { readContext: read }), {
      status: 'rejected',
      reason,
    });
  assert.equal(store.acceptances().length, 0);
  assert.equal(coordinator.metrics.turns, 0);
});

test('unaddressed unrelated replies are silent while known investigation replies still continue', async (t) => {
  const f = await fixture(t),
    host = await f.loadHost();
  let sends = 0;
  const send = host.channelFor('chat').send;
  host.channelFor('chat').send = async (message) => {
    sends++;
    return send(message);
  };
  const store = await InvestigationStore.open(path.join(f.root, 'state'));
  const coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  const unrelated = await coordinator.handle(
    input('unrelated-reply', { replyToMessageId: 'someone-else' }),
    { linkedReplyOnly: true },
  );
  assert.equal(unrelated.status, 'rejected');
  assert.equal(sends, 0);
  assert.equal(store.acceptances().length, 0);
  await coordinator.start();
  const first = await coordinator.handle(input('known-request'));
  if (first.status !== 'accepted') throw new Error();
  await coordinator.idle();
  const follow = await coordinator.handle(
    input('known-followup', { replyToMessageId: 'known-request' }),
    { linkedReplyOnly: true },
  );
  assert.equal(follow.status, 'accepted');
  if (follow.status === 'accepted') assert.equal(follow.investigationId, first.investigationId);
  await coordinator.idle();
});

test('plain rejection guidance chunks long authorized target names without changing the reason', async (t) => {
  const f = await fixture(t);
  const ids = ['a'.repeat(128), 'b'.repeat(128)];
  await f.writeConfig({
    ...f.config,
    runtime: { maxMessageBytes: 256 },
    targets: Object.fromEntries(ids.map((id) => [id, f.config.targets.a!])),
    routes: [{ ...f.config.routes[0]!, targets: ids }],
  });
  const host = await f.loadHost();
  const sent: import('../src/plugin-api/index.js').OutboundMessage[] = [];
  host.channelFor('chat').send = async (message) => {
    sent.push(message);
    return { address: message.address, messageIds: [message.idempotencyKey] };
  };
  const store = await InvestigationStore.open(path.join(f.root, 'state'));
  const coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  const { targetId: _target, ...question } = input('long-environments');
  const result = await coordinator.handle(question);
  if (result.status !== 'rejected') throw new Error();
  assert.ok(result.reason.startsWith('TARGET_REQUIRED:'));
  assert.equal(sent.map((message) => message.text).join(''), result.reason);
  assert.ok(sent.length > 1 && sent.every((message) => Buffer.byteLength(message.text) <= 256));
  assert.equal(store.acceptances().length, 0);
});

test('recovered controls disclose uncertain previous effects and keep saved results on another restart', async (t) => {
  for (const action of ['cancel', 'retry-delivery'] as const) {
    await t.test(action, async (t) => {
      const f = await fixture(t);
      let host = await f.loadHost();
      let store = await InvestigationStore.open(path.join(f.root, 'state'));
      t.after(() => store.close());
      const message = input('before-interruption');
      const original = await store.accept({
        version: 1,
        acceptedAt: new Date().toISOString(),
        key: messageKey(message),
        sequence: 1,
        request: {
          investigationId: 'interrupted-control',
          turnId: 'original-turn',
          scope: host.authorize({ ...message.address, senderId: message.senderId }, 'a'),
          message,
        },
      });
      const commandMessage = input('pending-command', {
        investigationId: original.request.investigationId,
        action,
      });
      await store.accept({
        ...original,
        key: messageKey(commandMessage),
        sequence: 2,
        request: { ...original.request, turnId: 'command-turn', message: commandMessage },
      });
      // Simulate a crash after the operation took effect, before its result was saved.
      if (action === 'retry-delivery') await store.setTurn('original-turn', 'running');
      await store.setTurn('original-turn', action === 'cancel' ? 'cancelled' : 'completed', {
        ...(action === 'cancel'
          ? { failure: 'USER_CANCELLED' }
          : {
              report: {
                investigationId: original.request.investigationId,
                turnId: original.request.turnId,
                targetId: 'a',
                facts: [],
                hypotheses: [],
                recommendations: [],
                missingEvidence: [],
              },
            }),
      });
      await store.close();
      await host.close();
      host = await f.loadHost();
      host.channelFor('chat').renderReply = renderLarkReply;
      const effects: unknown[] = [];
      const render = host.channelFor('chat').renderReply!;
      host.channelFor('chat').renderReply = (reply, budget) => {
        if (reply.kind === 'status') effects.push(reply.effect);
        return render(reply, budget);
      };
      store = await InvestigationStore.open(path.join(f.root, 'state'));
      let coordinator = new InvestigationCoordinator(host, store);
      t.after(() => coordinator.close());
      await coordinator.start();
      await coordinator.idle();
      assert.deepEqual(effects, [{ outcome: 'uncertain' }]);
      const results = () =>
        store.deliveries().filter((d) => d.message.reference?.turnId === 'command-turn');
      assert.equal(results().length, 1);
      assert.ok(results()[0]!.message.text.includes('未能完整确认'));
      assert.ok(!results()[0]!.message.text.includes('当前没有'));
      assert.equal(store.turn('command-turn').status, 'handled');
      assert.equal(coordinator.metrics.turns, 0);
      const saved = JSON.stringify(results());
      await coordinator.close();
      host = await f.loadHost();
      host.channelFor('chat').renderReply = renderLarkReply;
      store = await InvestigationStore.open(path.join(f.root, 'state'));
      coordinator = new InvestigationCoordinator(host, store);
      await coordinator.start();
      await coordinator.idle();
      assert.equal(JSON.stringify(results()), saved);
      assert.equal(coordinator.metrics.turns, 0);
    });
  }
});

test('long sensitive reports are delivered within the byte limit and survive restart', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'plugin.mjs');
  const source = await readFile(file, 'utf8');
  const changed = source.replace(
    "['Synthetic fixture; no real investigation performed.']",
    "['password=x\\n'.repeat(300)]",
  );
  assert.notEqual(changed, source);
  await writeFile(file, changed);
  let host = await f.loadHost();
  let store = await InvestigationStore.open(path.join(f.root, 'state'));
  let coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  const result = await coordinator.handle(input('sensitive-report'));
  if (result.status !== 'accepted') throw new Error();
  await coordinator.idle();
  const messages = store.deliveries().map((delivery) => delivery.message);
  assert.ok(messages.some((message) => message.text.includes('缺失信息')));
  assert.ok(messages.length > 2);
  assert.ok(messages.every((message) => Buffer.byteLength(message.text) <= 3500));
  assert.ok(!JSON.stringify(messages).includes('password=x'));
  assert.ok(store.deliveries().every((delivery) => delivery.status === 'sent'));
  await coordinator.close();
  host = await f.loadHost();
  store = await InvestigationStore.open(path.join(f.root, 'state'));
  coordinator = new InvestigationCoordinator(host, store);
  await coordinator.start();
  await coordinator.idle();
  assert.equal(coordinator.metrics.turns, 0);
  assert.equal(store.deliveries().length, messages.length);
});

test('disabled source notifications do not block other channels and resume when the source is enabled', async (t) => {
  const f = await fixture(t);
  let host = await f.loadHost();
  let store = await InvestigationStore.open(path.join(f.root, 'state'));
  let coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  const result = await coordinator.handle(input('before-disable'));
  if (result.status !== 'accepted') throw new Error();
  await coordinator.close();
  store = await InvestigationStore.open(path.join(f.root, 'state'));
  await store.setTurn(result.turnId, 'running');
  await store.close();
  await f.writePrivate('replacement');
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      chat: { ...f.config.plugins.chat!, enabled: false },
      replacement: { module: './plugin.mjs', configFile: './private/replacement.yaml' },
    },
    routes: [...f.config.routes, { ...f.config.routes[0]!, channel: 'replacement' }],
  });
  host = await f.loadHost();
  store = await InvestigationStore.open(path.join(f.root, 'state'));
  coordinator = new InvestigationCoordinator(host, store);
  await coordinator.start();
  await coordinator.idle();
  assert.equal(store.turn(result.turnId).status, 'interrupted');
  assert.equal(coordinator.metrics.turns, 0);
  assert.ok((await f.events()).includes('replacement:start'));
  await coordinator.close();
  await f.writeConfig();
  host = await f.loadHost();
  store = await InvestigationStore.open(path.join(f.root, 'state'));
  coordinator = new InvestigationCoordinator(host, store);
  await coordinator.start();
  await coordinator.idle();
  assert.ok(
    store
      .deliveries()
      .some(
        (delivery) =>
          delivery.status === 'sent' && delivery.message.text.includes('服务重启后本轮状态不确定'),
      ),
  );
  assert.equal(coordinator.metrics.turns, 0);
});

test('durable acceptance, concurrent followups, conflicts and report retry preserve event identity', async (t) => {
  const f = await fixture(t);
  const host = await f.loadHost();
  const store = await InvestigationStore.open(path.join(f.root, 'state'));
  const coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  const first = await coordinator.handle(input('initial'));
  assert.equal(first.status, 'accepted');
  if (first.status !== 'accepted') return;
  assert.deepEqual(await coordinator.handle(input('initial')), first);
  const followups = await Promise.all(
    ['one', 'two'].map((id) =>
      coordinator.handle(input(id, { investigationId: first.investigationId })),
    ),
  );
  assert.ok(
    followups.every((f) => f.status === 'accepted' && f.investigationId === first.investigationId),
  );
  assert.deepEqual(
    store.acceptances().map((a) => a.sequence),
    [1, 2, 3],
  );
  assert.equal(
    (
      await coordinator.handle(
        input('conflict', { targetId: 'b', investigationId: first.investigationId }),
      )
    ).status,
    'rejected',
  );
  assert.equal(
    (
      await coordinator.handle(
        input('cross-room', {
          address: { ...input('').address, conversationId: 'other' },
          investigationId: first.investigationId,
        }),
      )
    ).status,
    'rejected',
  );
  await coordinator.idle();
  assert.ok(store.acceptances().every((a) => store.turn(a.request.turnId).status === 'completed'));
  const turns = coordinator.metrics.turns;
  const receipt = store
    .deliveries()
    .find((d) => d.message.reference?.turnId === first.turnId)!.receipt!;
  const reply = await coordinator.handle(
    input('reply', { replyToMessageId: receipt.messageIds[0]! }),
  );
  assert.equal(reply.status, 'accepted');
  await coordinator.idle();
  assert.equal(coordinator.metrics.turns, turns + 1);
  const retry = await coordinator.handle(
    input('retry', { investigationId: first.investigationId, action: 'retry-delivery' }),
  );
  assert.equal(retry.status, 'accepted');
  await coordinator.idle();
  assert.equal(coordinator.metrics.turns, turns + 1);
});

test('no implicit target/pending log, secret redaction and durable control deduplication', async (t) => {
  const f = await fixture(t);
  const host = await f.loadHost();
  host.redactor.add(['test-password']);
  const store = await InvestigationStore.open(path.join(f.root, 'state'));
  const coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  const { targetId: _target, ...unselected } = input('ambiguous');
  assert.equal((await coordinator.handle(unselected)).status, 'rejected');
  assert.equal(store.acceptances().length, 0);
  assert.equal(
    (await coordinator.handle(input('big', { text: 'x'.repeat(70000) }))).status,
    'rejected',
  );
  const first = await coordinator.handle(input('secret', { text: 'password=test-password' }));
  if (first.status !== 'accepted') throw new Error();
  assert.ok(!JSON.stringify(store.acceptances()).includes('test-password'));
  await coordinator.idle();
  const command = input('cancel-once', {
    investigationId: first.investigationId,
    action: 'cancel',
  });
  const cancelled = await coordinator.handle(command);
  await coordinator.idle();
  const after = await coordinator.handle(
    input('after-cancel', { investigationId: first.investigationId }),
  );
  if (after.status !== 'accepted') throw new Error();
  assert.deepEqual(await coordinator.handle(command), cancelled);
  await coordinator.idle();
  assert.equal(store.turn(after.turnId).status, 'completed');
});

test('restart pauses interrupted predecessors until an explicit durable continuation', async (t) => {
  const f = await fixture(t);
  await f.writeConfig({ ...f.config, runtime: { maxQueuedTurns: 1 } });
  let host = await f.loadHost();
  let store = await InvestigationStore.open(path.join(f.root, 'state'));
  let coordinator = new InvestigationCoordinator(host, store);
  const first = await coordinator.handle(input('initial'));
  if (first.status !== 'accepted') throw new Error();
  // Controlled pre-start snapshot; no channel started. Stop scheduling before its next macrotask.
  await coordinator.close();
  store = await InvestigationStore.open(path.join(f.root, 'state'));
  await store.setTurn(first.turnId, 'running');
  await store.close();
  host = await f.loadHost();
  store = await InvestigationStore.open(path.join(f.root, 'state'));
  const original = store.acceptances()[0]!;
  const otherMessage = input('historical-paused');
  await store.accept({
    ...original,
    key: messageKey(otherMessage),
    sequence: 1,
    request: {
      ...original.request,
      investigationId: 'other-event',
      turnId: 'other-turn',
      message: otherMessage,
    },
  });
  await store.setTurn('other-turn', 'running');
  await store.setTurn('other-turn', 'interrupted');
  coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  assert.equal(store.turn(first.turnId).status, 'interrupted');
  const follow = await coordinator.handle(
    input('queued-follow', { investigationId: first.investigationId }),
  );
  if (follow.status !== 'accepted') throw new Error();
  await coordinator.idle();
  assert.equal(store.turn(follow.turnId).status, 'queued');
  assert.equal(coordinator.metrics.turns, 0);
  assert.deepEqual(await coordinator.handle(input('overflow')), {
    status: 'rejected',
    reason: 'QUEUE_FULL',
  });
  for (const action of ['status', 'retry-delivery'] as const)
    assert.equal(
      (await coordinator.handle(input(action, { investigationId: first.investigationId, action })))
        .status,
      'accepted',
    );
  assert.deepEqual(
    await coordinator.handle(
      input('other-continue', { investigationId: 'other-event', action: 'continue' }),
    ),
    { status: 'rejected', reason: 'QUEUE_FULL' },
  );
  const continued = await coordinator.handle(
    input('explicit-continue', { investigationId: first.investigationId, action: 'continue' }),
  );
  assert.equal(continued.status, 'accepted');
  assert.deepEqual(
    await coordinator.handle(
      input('extra-continue', { investigationId: first.investigationId, action: 'continue' }),
    ),
    { status: 'rejected', reason: 'QUEUE_FULL' },
  );
  await coordinator.idle();
  assert.equal(store.turn(first.turnId).status, 'failed');
  assert.equal(store.turn(follow.turnId).status, 'completed');
  assert.equal(coordinator.metrics.turns, 2);
  assert.equal(
    (await coordinator.handle(input('blocked-follow', { investigationId: 'other-event' }))).status,
    'accepted',
  );
  await coordinator.idle();
  assert.equal(
    (
      await coordinator.handle(
        input('cancel-full', { investigationId: 'other-event', action: 'cancel' }),
      )
    ).status,
    'accepted',
  );
  await coordinator.idle();
  assert.equal(store.turn('other-turn').status, 'cancelled');
  assert.equal(coordinator.metrics.turns, 2);
});

test('outbound plan and mapping survive restart and changed chunk limits without new model runs', async (t) => {
  const f = await fixture(t);
  let host = await f.loadHost();
  let store = await InvestigationStore.open(path.join(f.root, 'state'));
  let coordinator = new InvestigationCoordinator(host, store);
  await coordinator.start();
  const first = await coordinator.handle(input('initial'));
  if (first.status !== 'accepted') throw new Error();
  await coordinator.idle();
  const messages = store.deliveries().map((d) => d.message);
  const sentId = store.deliveries()[0]!.receipt!.messageIds[0]!;
  await coordinator.close();
  await f.writeConfig({ ...f.config, runtime: { maxMessageBytes: 256 } });
  host = await f.loadHost();
  store = await InvestigationStore.open(path.join(f.root, 'state'));
  coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  await coordinator.idle();
  assert.deepEqual(
    store
      .deliveries()
      .map((d) => d.message)
      .sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)),
    messages.sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)),
  );
  assert.equal(coordinator.metrics.turns, 0);
  const reply = await coordinator.handle(input('after-restart', { replyToMessageId: sentId }));
  assert.equal(reply.status, 'accepted');
  if (reply.status === 'accepted') assert.equal(reply.investigationId, first.investigationId);
  await coordinator.idle();
  if (reply.status === 'accepted')
    assert.ok(
      store
        .deliveries()
        .filter((delivery) => delivery.message.reference?.turnId === reply.turnId)
        .every((delivery) => delivery.message.replyToMessageId === 'after-restart'),
      'reply to the user followup, not the bot card it referenced',
    );
});

test('renderers receive redacted data, keep protocol constants and reuse saved cards after restart', async (t) => {
  const f = await fixture(t);
  await f.writeConfig({ ...f.config, runtime: { maxMessageBytes: 256, deliveryAttempts: 1 } });
  let host = await f.loadHost();
  host.redactor.add(['2.0', 'blue', 'markdown']);
  host.redactor.add(['Synthetic fixture; no real investigation performed.']);
  let formatted = 0;
  host.channelFor('chat').renderReply = (reply, limit) => {
    assert.ok(
      !JSON.stringify(reply).includes('Synthetic fixture; no real investigation performed.'),
    );
    formatted++;
    return renderLarkReply(reply, limit);
  };
  host.channelFor('chat').send = async () => {
    throw new Error('SYNTHETIC_DELIVERY_FAILURE');
  };
  let store = await InvestigationStore.open(path.join(f.root, 'state'));
  let coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  const first = await coordinator.handle(input('formatted-reply'));
  if (first.status !== 'accepted') throw new Error();
  await coordinator.idle();
  assert.equal(store.turn(first.turnId).status, 'completed');
  assert.equal(formatted, 2, 'accepted message and report are each formatted once');
  const original = store.deliveries().map((d) => d.message);
  assert.ok(original.length > 2, 'help participates in chunking');
  assert.ok(original.every((message) => message.replyToMessageId === 'formatted-reply'));
  assert.ok(original.every((message) => Buffer.byteLength(message.text) <= 256));
  assert.ok(original.every((message) => message.payload?.schema === '2.0'));
  assert.ok(
    original.every(
      (message) => (message.payload?.header as { template: string }).template === 'blue',
    ),
  );
  assert.ok(original.every((message) => message.payload?.schema === '2.0'));
  const body = original.map((message) => message.text).join('');
  assert.equal(body.split(`/event ${first.investigationId} 你的问题`).length - 1, 2);
  for (const [action, label] of [
    ['event', '补充问题'],
    ['status', '查看进展'],
    ['cancel', '取消排查'],
    ['continue', '继续排查'],
    ['retry-delivery', '重试发送'],
  ])
    assert.equal(
      original.filter((message) =>
        message.text.includes(`${label}：/${action} ${first.investigationId}`),
      ).length,
      2,
      'each advertised command must remain copyable in one chunk',
    );
  assert.ok(store.deliveries().every((delivery) => delivery.status === 'unknown'));
  await coordinator.close();

  host = await f.loadHost();
  let newReplies = 0;
  host.channelFor('chat').renderReply = (reply, limit) => {
    if (reply.kind === 'notice') throw new Error('unexpected notice');
    assert.notEqual(
      reply.reference.turnId,
      first.turnId,
      'persisted plans must not be rendered again',
    );
    newReplies++;
    return renderLarkReply(reply, limit);
  };
  store = await InvestigationStore.open(path.join(f.root, 'state'));
  coordinator = new InvestigationCoordinator(host, store);
  await coordinator.start();
  const retry = await coordinator.handle(
    input('retry-formatted', { investigationId: first.investigationId, action: 'retry-delivery' }),
  );
  assert.equal(retry.status, 'accepted');
  await coordinator.idle();
  assert.equal(newReplies, 1, 'a control command formats only its result');
  if (retry.status === 'accepted')
    assert.ok(
      store
        .deliveries()
        .filter((d) => d.message.reference?.turnId === retry.turnId)
        .map((d) => d.message.text)
        .join('')
        .includes(`重试 ${original.length} 条`),
    );
  assert.equal(coordinator.metrics.turns, 0);
  assert.deepEqual(
    store
      .deliveries()
      .filter((d) => d.message.reference?.turnId === first.turnId)
      .map((d) => d.message)
      .sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)),
    [...original].sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey)),
  );
  assert.ok(store.deliveries().every((delivery) => delivery.status === 'sent'));
});

test('report identity survives a credential matching the target while prose stays redacted through persistence and rendering', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.root, 'plugin.mjs'),
    await readFile(new URL('./fixtures/investigation-plugin.mjs', import.meta.url), 'utf8'),
  );
  await f.writePrivate('a-tools', { credential: 'a' });
  const host = await f.loadHost();
  host.redactor.add([...'0123456789abcdef']);
  const rendered: import('../src/plugin-api/index.js').InvestigationReport[] = [];
  let renderedText = '';
  host.channelFor('chat').renderReply = (reply, limit) => {
    if (reply.kind === 'report' && reply.report) {
      rendered.push(reply.report);
      renderedText = reply.text;
    }
    return renderLarkReply(reply, limit);
  };
  const directory = path.join(f.root, 'state');
  let store = await InvestigationStore.open(directory);
  let coordinator = new InvestigationCoordinator(host, store);
  t.after(() => coordinator.close());
  await coordinator.start();
  const result = await coordinator.handle(input('short-report-secret'));
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') return;
  await coordinator.idle();
  const state = store.turn(result.turnId);
  assert.equal(state.status, 'completed');
  const report = state.report!;
  assert.equal(report.investigationId, result.investigationId);
  assert.equal(report.turnId, result.turnId);
  assert.equal(report.targetId, 'a');
  const ids = new Set((await store.evidence(result.turnId)).map((item) => item.id));
  assert.equal(report.facts.length, 1);
  assert.ok(report.facts.every((claim) => claim.evidenceIds.every((id) => ids.has(id))));
  const prose = [
    ...report.facts.map((claim) => claim.text),
    ...report.hypotheses.map((claim) => claim.text),
    ...report.recommendations,
    ...report.missingEvidence,
  ];
  assert.ok(prose.every((text) => !text.includes('a')));
  assert.deepEqual(rendered, [report]);
  assert.ok(
    report.facts.every((claim) => claim.evidenceIds.every((id) => renderedText.includes(id))),
    'plain-text report citations retain their original evidence IDs',
  );
  await coordinator.close();
  const restoredHost = await f.loadHost();
  store = await InvestigationStore.open(directory);
  coordinator = new InvestigationCoordinator(restoredHost, store);
  await coordinator.start();
  await coordinator.idle();
  assert.deepEqual(store.turn(result.turnId).report, report);
});
