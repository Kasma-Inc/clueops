import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { InvestigationStore } from '../src/core/store.js';
import type { Acceptance } from '../src/core/store.js';
import { messageKey } from '../src/core/identity.js';
import { fixture, principal } from './helpers.js';

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
