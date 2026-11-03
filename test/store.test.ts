import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { InvestigationStore } from '../src/core/store.js';
import type { Acceptance } from '../src/core/store.js';
import { messageKey } from '../src/core/identity.js';
import { fixture, principal } from './helpers.js';

const day = 24 * 60 * 60 * 1000;

async function record(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const host = await f.loadHost();
  const message = {
    address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
    senderId: 'user',
    messageId: randomUUID(),
    text: 'synthetic error',
  };
  const acceptance: Acceptance = {
    version: 1,
    key: messageKey(message),
    sequence: 1,
    acceptedAt: new Date().toISOString(),
    request: {
      investigationId: randomUUID(),
      turnId: randomUUID(),
      scope: host.authorize(principal, 'a'),
      message,
    },
  };
  return { ...f, acceptance, directory: path.join(f.root, 'state') };
}

test('retention removes whole investigations and resumes plugin cleanup after reopening', async (t) => {
  const f = await record(t);
  let store = await InvestigationStore.open(f.directory);
  const first = await store.accept(f.acceptance);
  const { investigationId, turnId } = first.request;
  const handle = { directoryId: randomUUID(), threadId: randomUUID() };
  await store.setTurn(turnId, 'running', { sessionHandle: handle });
  const evidenceId = randomUUID();
  await store.saveEvidence(
    {
      id: evidenceId,
      investigationId,
      turnId,
      targetId: 'a',
      providerInstanceId: 'a-tools',
      toolName: 'read',
      parameters: {},
      resources: [],
      observedAt: new Date().toISOString(),
      status: 'ok',
      content: 'saved evidence',
      truncated: false,
    },
    new AbortController().signal,
  );
  await store.setTurn(turnId, 'completed', {
    report: {
      investigationId,
      turnId,
      targetId: 'a',
      facts: [],
      hypotheses: [],
      recommendations: [],
      missingEvidence: [],
    },
  });
  const outgoing = {
    address: first.request.message.address,
    reference: { investigationId, turnId },
    idempotencyKey: 'expired-report',
    text: 'saved report',
  };
  await store.saveOutput({ version: 1, id: 'expired-output', messages: [outgoing] });
  await store.saveDelivery({
    version: 1,
    id: outgoing.idempotencyKey,
    message: outgoing,
    status: 'sent',
    attempts: 1,
    updatedAt: new Date().toISOString(),
    receipt: { address: outgoing.address, messageIds: ['sent'] },
  });
  const message = { ...first.request.message, messageId: randomUUID() };
  const second = await store.accept({
    ...first,
    key: messageKey(message),
    sequence: 2,
    request: { ...first.request, turnId: randomUUID(), message },
  });
  await store.setTurn(second.request.turnId, 'cancelled');
  const auth = path.join(f.directory, 'plugins', '.codex-auth');
  await mkdir(auth, { recursive: true });
  await writeFile(path.join(auth, 'auth.json'), 'keep authentication');
  const plans = await store.prune(Date.now() + day, new Set());
  assert.deepEqual(plans, [
    {
      investigationId,
      sessions: [
        { instanceId: 'engine', pluginId: first.request.scope.target.engine.pluginId, handle },
      ],
      version: 1,
      accepted: [first.key, second.key],
      turns: [turnId, second.request.turnId],
      evidence: [evidenceId],
      deliveries: [outgoing.idempotencyKey],
      outputs: ['expired-output'],
    },
  ]);
  assert.equal(store.acceptances().length, 0);
  assert.equal(store.deliveries().length, 0);
  assert.equal(store.output('expired-output'), undefined);
  await assert.rejects(
    store.accept({
      ...first,
      sequence: 1,
      request: { ...first.request, investigationId: randomUUID(), turnId: randomUUID() },
    }),
    { code: 'MESSAGE_ID_CONFLICT' },
    'a delayed duplicate must not reuse a filename still owned by a prune plan',
  );
  for (const name of ['accepted', 'turns', 'evidence', 'outputs', 'deliveries'])
    assert.deepEqual(await readdir(path.join(f.directory, name)), []);
  await store.close();
  store = await InvestigationStore.open(f.directory);
  assert.equal(
    store.acceptances().length,
    0,
    'deleted work must not become queued after a restart',
  );
  const pending = await store.prune(Number.NEGATIVE_INFINITY, new Set());
  assert.deepEqual(pending, plans, 'plugin cleanup references survive restart');
  await store.finishPruning([investigationId]);
  assert.deepEqual(await readdir(path.join(f.directory, 'pruning')), []);
  assert.equal(await readFile(path.join(auth, 'auth.json'), 'utf8'), 'keep authentication');
  await store.close();
});

test('retention keeps unfinished, undelivered, recently touched and protected investigations', async (t) => {
  const f = await record(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: now - 8 * day });
  const store = await InvestigationStore.open(f.directory);
  t.after(() => store.close());
  const kept: string[] = [];
  async function add(status: 'queued' | 'running' | 'interrupted' | 'cancelled') {
    const message = { ...f.acceptance.request.message, messageId: randomUUID() };
    const item = await store.accept({
      ...f.acceptance,
      acceptedAt: new Date().toISOString(),
      key: messageKey(message),
      request: {
        ...f.acceptance.request,
        investigationId: randomUUID(),
        turnId: randomUUID(),
        message,
      },
    });
    if (status === 'running' || status === 'interrupted')
      await store.setTurn(item.request.turnId, 'running');
    if (status === 'interrupted' || status === 'cancelled')
      await store.setTurn(item.request.turnId, status);
    return item;
  }
  for (const status of ['queued', 'running', 'interrupted'] as const)
    kept.push((await add(status)).request.investigationId);
  const deliveries: import('../src/core/store.js').Delivery[] = [];
  for (const status of ['pending', 'sending', 'unknown', 'failed', 'sent'] as const) {
    const item = await add('cancelled');
    kept.push(item.request.investigationId);
    const message = {
      address: item.request.message.address,
      reference: { investigationId: item.request.investigationId, turnId: item.request.turnId },
      text: 'awaiting delivery',
      idempotencyKey: randomUUID(),
    };
    deliveries.push(
      await store.saveDelivery({
        version: 1,
        id: message.idempotencyKey,
        message,
        status,
        attempts: status === 'pending' ? 0 : 1,
        updatedAt: new Date().toISOString(),
        ...(status === 'sent'
          ? { receipt: { address: message.address, messageIds: ['sent'] } }
          : {}),
      }),
    );
  }
  const protectedItem = await add('cancelled');
  kept.push(protectedItem.request.investigationId);
  const expired = await add('cancelled');
  t.mock.timers.setTime(now);
  await store.saveDelivery(deliveries.at(-1)!);
  const plans = await store.prune(now - 7 * day, new Set([protectedItem.request.investigationId]));
  assert.deepEqual(
    plans.map((p) => p.investigationId),
    [expired.request.investigationId],
  );
  assert.deepEqual(
    new Set(store.acceptances().map((a) => a.request.investigationId)),
    new Set(kept),
  );
  await store.finishPruning(plans.map((p) => p.investigationId));
});

for (const phase of ['prune-planned', 'prune-file-deleted', 'prune-deleted'] as const)
  test(`retention crash at ${phase} cannot resurrect or corrupt an expired investigation`, async (t) => {
    const f = await record(t);
    let store = await InvestigationStore.open(f.directory);
    await store.accept(f.acceptance);
    await store.setTurn(f.acceptance.request.turnId, 'cancelled');
    await store.close();
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        new URL('./fixtures/store-child.mjs', import.meta.url).pathname,
        f.directory,
        phase,
        '',
        'prune',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => {
      child.kill('SIGKILL');
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    while (!output.includes(phase)) await once(child.stdout, 'data');
    child.kill('SIGKILL');
    await once(child, 'exit');
    store = await InvestigationStore.open(f.directory);
    assert.equal(store.acceptances().length, 0);
    const plans = await store.prune(Number.NEGATIVE_INFINITY, new Set());
    assert.equal(plans.length, 1);
    await store.finishPruning(plans.map((p) => p.investigationId));
    await store.close();
    store = await InvestigationStore.open(f.directory);
    assert.deepEqual(await store.prune(Number.NEGATIVE_INFINITY, new Set()), []);
    await store.close();
  });

test('immutable durable acceptance deduplicates and reconstructs queued input without indexes', async (t) => {
  const f = await record(t);
  let store = await InvestigationStore.open(f.directory);
  const first = await store.accept(f.acceptance);
  const second = await store.accept({
    ...f.acceptance,
    request: { ...f.acceptance.request, turnId: randomUUID() },
  });
  assert.deepEqual(second, first);
  await store.close();
  store = await InvestigationStore.open(f.directory);
  assert.deepEqual(store.find(first.key), first);
  assert.equal(store.turn(first.request.turnId).status, 'queued');
  await store.close();
});

test('native writer lock refuses concurrent instances and releases after SIGKILL', async (t) => {
  const f = await record(t);
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      new URL('./fixtures/store-child.mjs', import.meta.url).pathname,
      f.directory,
      'temp-synced',
      Buffer.from(JSON.stringify(f.acceptance)).toString('base64'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let text = '';
  child.stdout.on('data', (chunk) => {
    text += String(chunk);
  });
  while (!text.includes('temp-synced')) {
    await once(child.stdout, 'data');
  }
  await assert.rejects(InvestigationStore.open(f.directory), { code: 'STATE_DIRECTORY_LOCKED' });
  child.kill('SIGKILL');
  await once(child, 'exit');
  const store = await InvestigationStore.open(f.directory);
  assert.equal(store.acceptances().length, 0);
  await store.close();
});

test('crash after publication recovers the complete acceptance with identical event and turn', async (t) => {
  const f = await record(t);
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      new URL('./fixtures/store-child.mjs', import.meta.url).pathname,
      f.directory,
      'published',
      Buffer.from(JSON.stringify(f.acceptance)).toString('base64'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let text = '';
  child.stdout.on('data', (chunk) => {
    text += String(chunk);
  });
  while (!text.includes('published')) {
    await once(child.stdout, 'data');
  }
  child.kill('SIGKILL');
  await once(child, 'exit');
  const store = await InvestigationStore.open(f.directory);
  assert.deepEqual(store.find(f.acceptance.key), f.acceptance);
  assert.deepEqual(await store.accept(f.acceptance), f.acceptance);
  await store.close();
});

test('restart interrupts started turns and preserves sent-message associations', async (t) => {
  const f = await record(t);
  let store = await InvestigationStore.open(f.directory);
  await store.accept(f.acceptance);
  await store.setTurn(f.acceptance.request.turnId, 'running', {
    sessionHandle: { threadId: 'private-handle' },
  });
  const message = {
    address: f.acceptance.request.message.address,
    reference: {
      investigationId: f.acceptance.request.investigationId,
      turnId: f.acceptance.request.turnId,
    },
    text: 'accepted',
    idempotencyKey: 'outgoing',
  };
  await store.saveDelivery({
    version: 1,
    id: 'outgoing',
    message,
    status: 'sent',
    attempts: 1,
    updatedAt: new Date().toISOString(),
    receipt: { address: message.address, messageIds: ['platform-message'] },
  });
  await store.close();
  store = await InvestigationStore.open(f.directory);
  assert.equal(store.turn(f.acceptance.request.turnId).status, 'interrupted');
  assert.deepEqual(store.deliveries()[0]?.receipt?.messageIds, ['platform-message']);
  await store.close();
});

test('late evidence is rejected without disabling the store and cross-target delivery fails', async (t) => {
  const f = await record(t);
  const store = await InvestigationStore.open(f.directory);
  await store.accept(f.acceptance);
  await store.setTurn(f.acceptance.request.turnId, 'running');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    store.saveEvidence(
      {
        id: randomUUID(),
        investigationId: f.acceptance.request.investigationId,
        turnId: f.acceptance.request.turnId,
        targetId: 'a',
        providerInstanceId: 'a-tools',
        toolName: 'read',
        parameters: {},
        resources: [],
        observedAt: new Date().toISOString(),
        status: 'ok',
        content: null,
        truncated: false,
      },
      controller.signal,
    ),
  );
  await store.setTurn(f.acceptance.request.turnId, 'cancelled');
  await assert.rejects(
    store.saveDelivery({
      version: 1,
      id: 'wrong-group',
      message: {
        address: { ...f.acceptance.request.message.address, conversationId: 'other-room' },
        reference: {
          investigationId: f.acceptance.request.investigationId,
          turnId: f.acceptance.request.turnId,
        },
        text: 'report',
        idempotencyKey: 'wrong-group',
      },
      status: 'pending',
      attempts: 0,
      updatedAt: new Date().toISOString(),
    }),
    { code: 'DELIVERY_SCOPE_INVALID' },
  );
  assert.equal((await store.evidence(f.acceptance.request.turnId)).length, 0);
  await store.close();
});

test('the commit boundary rejects identities and ordinals that would corrupt recovery', async (t) => {
  const f = await record(t);
  let store = await InvestigationStore.open(f.directory);
  await store.accept(f.acceptance);
  const changedMessage = { ...f.acceptance.request.message, messageId: randomUUID() };
  const next = {
    ...f.acceptance,
    key: messageKey(changedMessage),
    sequence: 2,
    request: { ...f.acceptance.request, turnId: randomUUID(), message: changedMessage },
  };
  await assert.rejects(
    store.accept({ ...next, request: { ...next.request, turnId: f.acceptance.request.turnId } }),
    { code: 'ACCEPTANCE_CONFLICT' },
  );
  await assert.rejects(store.accept({ ...next, sequence: 1 }), { code: 'ACCEPTANCE_CONFLICT' });
  await assert.rejects(
    store.accept({
      ...next,
      request: {
        ...next.request,
        scope: { ...next.request.scope, principal: { ...principal, senderId: 'other' } },
      },
    }),
    { code: 'ACCEPTANCE_CONFLICT' },
  );
  assert.deepEqual(await store.accept(f.acceptance), f.acceptance);
  await store.accept(next);
  await store.close();
  store = await InvestigationStore.open(f.directory);
  assert.equal(store.acceptances().length, 2);
  await store.close();
});
