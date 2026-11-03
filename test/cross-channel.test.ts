import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, principal } from './helpers.js';
import { PluginHost } from '../src/core/host.js';
import { InvestigationStore } from '../src/core/store.js';
import { InvestigationCoordinator } from '../src/core/coordinator.js';
import { messageKey } from '../src/core/identity.js';
import { builtinPlugins } from '../src/plugins/catalog.js';
import type { CompositionConfig } from '../src/core/config.js';
import type { RestChannel } from '../src/plugins/rest/index.js';
import type {
  AcceptanceResult,
  ChannelMessage,
  InvestigationDetail,
  InvestigationPage,
  OutboundMessage,
} from '../src/plugin-api/index.js';

const token = 'CROSS_CHANNEL_SYNTHETIC_TOKEN';
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const input = (messageId: string, extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
  address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
  senderId: 'user',
  messageId,
  text: 'original investigation',
  targetId: 'a',
  ...extra,
});

async function setup(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  await copyFile(
    new URL('./fixtures/investigation-plugin.mjs', import.meta.url),
    path.join(f.root, 'plugin.mjs'),
  );
  const stateDirectory = path.join(f.root, 'state');
  let config: CompositionConfig = {
    ...f.config,
    runtime: { stateDirectory },
    plugins: {
      ...f.config.plugins,
      http: {
        module: builtinPlugins.rest!,
        config: {
          token,
          port: 0,
          tenantId: 'different-tenant',
          conversationId: 'browser',
          senderId: 'operator',
        },
      },
    },
    routes: [
      ...f.config.routes,
      {
        channel: 'http',
        tenant: 'different-tenant',
        conversation: 'browser',
        allowedSenders: ['operator'],
        targets: ['a'],
      },
    ],
  };
  let current: InvestigationCoordinator | undefined;
  let failSource = false;
  t.after(async () => {
    await current?.close();
  });
  async function start() {
    await f.writeConfig(config);
    const host = await PluginHost.load(f.configFile, builtinPlugins);
    const sent: OutboundMessage[] = [];
    try {
      host.channelFor('chat').send = async (message) => {
        sent.push(message);
        if (failSource) throw new Error('SYNTHETIC_SEND_FAILED');
        return { address: message.address, messageIds: ['chat-' + message.idempotencyKey] };
      };
    } catch {
      /* A test deliberately removes the original input adapter. */
    }
    const store = await InvestigationStore.open(stateDirectory);
    const coordinator = new InvestigationCoordinator(host, store);
    current = coordinator;
    await coordinator.start();
    const base = 'http://127.0.0.1:' + (host.channelFor('http') as RestChannel).address!.port;
    const get = (route: string) => fetch(base + route, { headers });
    const post = (body: unknown) =>
      fetch(base + '/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    return { host, store, coordinator, sent, get, post };
  }
  return {
    ...f,
    start,
    stateDirectory,
    write: () => f.writeConfig(config),
    disableSource: () => {
      config = {
        ...config,
        plugins: { ...config.plugins, chat: { ...config.plugins.chat!, enabled: false } },
      };
    },
    enableSource: () => {
      config = {
        ...config,
        plugins: { ...config.plugins, chat: { ...config.plugins.chat!, enabled: true } },
      };
    },
    failSource: () => {
      failSource = true;
    },
    revokeSource: () => {
      failSource = false;
      config = {
        ...config,
        routes: config.routes.map((route) =>
          route.channel === 'chat' ? { ...route, targets: ['b'] } : route,
        ),
      };
    },
  };
}

function accepted(value: unknown): AcceptanceResult {
  const result = value as AcceptanceResult;
  assert.equal(result.status, 'accepted');
  return result;
}

test('investigations cross plugin, tenant and conversation boundaries by explicit ID, survive restart and reply per turn', async (t) => {
  const f = await setup(t);
  let run = await f.start();
  const first = accepted(await run.coordinator.handle(input('same-platform-id')));
  await run.coordinator.idle();
  const endpoint = '/api/investigations/' + first.investigationId;
  const detail = (await (await run.get(endpoint)).json()) as InvestigationDetail;
  assert.equal(detail.investigation.sourceChannel, 'chat');
  assert.equal(detail.investigation.canContinue, true);
  assert.equal(detail.turns[0]!.sourceChannel, 'chat');
  assert.ok(detail.turns[0]!.report);
  assert.equal((await run.get(endpoint + '/evidence?turnId=' + first.turnId)).status, 200);
  const list = (await (await run.get('/api/investigations')).json()) as InvestigationPage;
  assert.equal(list.investigations[0]!.investigationId, first.investigationId);
  const foreignReply = run.sent.find((message) => message.reference?.turnId === first.turnId)!;
  const receipt = run.store
    .deliveries()
    .find((delivery) => delivery.message.reference?.turnId === first.turnId)!.receipt!;
  assert.ok(foreignReply);
  const wrongReply = await run.post({
    messageId: 'wrong-quote',
    replyToMessageId: receipt.messageIds[0],
    text: 'do not guess foreign platform reply IDs',
    targetId: 'a',
  });
  assert.equal(wrongReply.status, 422);
  assert.equal(((await wrongReply.json()) as { reason: string }).reason, 'REFERENCE_UNKNOWN');
  const followed = await run.post({
    messageId: 'same-platform-id',
    investigationId: first.investigationId,
    text: 'follow up from HTTP',
  });
  assert.equal(followed.status, 202);
  const second = accepted(await followed.json());
  await run.coordinator.idle();
  assert.equal(second.investigationId, first.investigationId);
  assert.equal(run.store.acceptances().length, 2);
  assert.notEqual(run.store.acceptances()[0]!.key, run.store.acceptances()[1]!.key);
  assert.equal(run.store.acceptances()[1]!.sequence, 2);
  const sourceReplies = run.store
    .deliveries()
    .filter((delivery) => delivery.message.reference?.turnId === first.turnId);
  const httpReplies = run.store
    .deliveries()
    .filter((delivery) => delivery.message.reference?.turnId === second.turnId);
  assert.ok(sourceReplies.length > 0 && httpReplies.length > 0);
  assert.ok(
    sourceReplies.every((delivery) => delivery.message.address.channelInstanceId === 'chat'),
  );
  assert.ok(httpReplies.every((delivery) => delivery.message.address.channelInstanceId === 'http'));
  const back = accepted(
    await run.coordinator.handle(
      input('return-to-chat', {
        investigationId: first.investigationId,
        text: 'continue from original adapter',
      }),
    ),
  );
  await run.coordinator.idle();
  assert.equal(back.investigationId, first.investigationId);
  const events = (await f.events()).map(
    (line) => JSON.parse(line) as { action: string; historyFirstText?: string },
  );
  assert.ok(
    events
      .filter((event) => event.action === 'run')
      .slice(1)
      .every((event) => event.historyFirstText === 'original investigation'),
  );
  await run.coordinator.close();
  run = await f.start();
  const restored = (await (await run.get(endpoint)).json()) as InvestigationDetail;
  assert.deepEqual(
    restored.turns.map((turn) => turn.sourceChannel),
    ['chat', 'http', 'chat'],
  );
  assert.deepEqual(
    restored.turns.map((turn) => turn.sequence),
    [1, 2, 3],
  );
  const status = await run.post({
    messageId: 'cross-status',
    investigationId: first.investigationId,
    action: 'status',
    text: 'status',
  });
  assert.equal(status.status, 202);
  await run.coordinator.idle();
  const control = (await (await run.get(endpoint)).json()) as InvestigationDetail;
  assert.equal(control.turns.at(-1)!.status, 'handled');
});

test('target authorization still gates cross-channel reads and controls', async (t) => {
  const f = await setup(t);
  const run = await f.start();
  const first = accepted(
    await run.coordinator.handle(input('unauthorized-target', { targetId: 'b' })),
  );
  await run.coordinator.idle();
  assert.equal((await run.get('/api/investigations/' + first.investigationId)).status, 403);
  assert.equal(
    (
      await run.get(
        '/api/investigations/' + first.investigationId + '/evidence?turnId=' + first.turnId,
      )
    ).status,
    403,
  );
  const list = (await (await run.get('/api/investigations')).json()) as InvestigationPage;
  assert.deepEqual(list.investigations, []);
  for (const action of [undefined, 'status', 'cancel', 'continue', 'retry-delivery']) {
    const response = await run.post({
      messageId: 'denied-' + action,
      investigationId: first.investigationId,
      text: 'try unauthorized target',
      ...(action ? { action } : {}),
    });
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as { reason: string }).reason, 'ACCESS_DENIED');
  }
  assert.equal(run.store.acceptances().length, 1);
});

test('old target revisions remain readable and controllable but cannot execute another diagnostic turn', async (t) => {
  const f = await setup(t);
  let run = await f.start();
  const first = accepted(await run.coordinator.handle(input('old-scope')));
  await run.coordinator.idle();
  await run.coordinator.close();
  await f.writePrivate('a-tools', { resourceId: 'changed-target-resource' });
  run = await f.start();
  const endpoint = '/api/investigations/' + first.investigationId;
  const detail = (await (await run.get(endpoint)).json()) as InvestigationDetail;
  assert.equal(detail.investigation.canContinue, false);
  assert.ok(detail.turns[0]!.report);
  assert.equal((await run.get(endpoint + '/evidence?turnId=' + first.turnId)).status, 200);
  const resumed = await run.post({
    messageId: 'scope-changed-followup',
    investigationId: first.investigationId,
    text: 'do not mix resources',
  });
  assert.equal(resumed.status, 422);
  assert.equal(((await resumed.json()) as { reason: string }).reason, 'TARGET_SCOPE_CHANGED');
  for (const action of ['status', 'cancel', 'retry-delivery']) {
    assert.equal(
      (
        await run.post({
          messageId: 'old-scope-' + action,
          investigationId: first.investigationId,
          action,
          text: action,
        })
      ).status,
      202,
    );
    await run.coordinator.idle();
  }
  assert.equal(run.coordinator.metrics.turns, 0);
});

test('a durably accepted queued investigation executes after its original adapter is disabled', async (t) => {
  const f = await setup(t);
  await f.write();
  const host = await PluginHost.load(f.configFile, builtinPlugins);
  const store = await InvestigationStore.open(f.stateDirectory);
  const message = input('queued-before-adapter-removal');
  const investigationId = randomUUID();
  const turnId = randomUUID();
  await store.accept({
    version: 1,
    key: messageKey(message),
    sequence: 1,
    acceptedAt: new Date().toISOString(),
    request: { investigationId, turnId, scope: host.authorize(principal, 'a'), message },
  });
  await store.close();
  await host.close();
  f.disableSource();
  const run = await f.start();
  await run.coordinator.idle();
  assert.equal(run.store.turn(turnId).status, 'completed');
  const detail = (await (
    await run.get('/api/investigations/' + investigationId)
  ).json()) as InvestigationDetail;
  assert.ok(detail.turns[0]!.report);
  assert.equal(detail.investigation.canContinue, true);
  assert.equal(
    (
      await run.post({
        messageId: 'resume-without-original-adapter',
        investigationId,
        text: 'continue via current adapter',
      })
    ).status,
    202,
  );
  await run.coordinator.idle();
  assert.equal(run.coordinator.metrics.turns, 2);
});

test('cross-channel delivery retries retain original destinations and cannot borrow the retrier’s recipient grants', async (t) => {
  const f = await setup(t);
  let run = await f.start();
  f.failSource();
  const first = accepted(await run.coordinator.handle(input('retry-original')));
  await run.coordinator.idle();
  const oldDelivery = run.store
    .deliveries()
    .find((delivery) => delivery.message.reference?.turnId === first.turnId)!;
  await run.coordinator.close();
  f.revokeSource();
  run = await f.start();
  const response = await run.post({
    messageId: 'retry-from-http',
    investigationId: first.investigationId,
    action: 'retry-delivery',
    text: 'retry original delivery',
  });
  assert.equal(response.status, 202);
  await run.coordinator.idle();
  const delivery = run.store.deliveries().find((item) => item.id === oldDelivery.id)!;
  assert.equal(delivery.message.address.channelInstanceId, 'chat');
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.failure, 'ACCESS_DENIED');
  assert.equal(run.sent.length, 0);
});

test('an authorized caller can cancel a running investigation and continue it through another adapter', async (t) => {
  const f = await setup(t);
  await f.writePrivate('a-tools', { delayMs: 200 });
  const run = await f.start();
  const first = accepted(await run.coordinator.handle(input('running-on-chat')));
  while (run.store.turn(first.turnId).status === 'queued')
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(run.store.turn(first.turnId).status, 'running');
  const cancelled = await run.post({
    messageId: 'cancel-on-http',
    investigationId: first.investigationId,
    action: 'cancel',
    text: 'cancel',
  });
  assert.equal(cancelled.status, 202);
  await run.coordinator.idle();
  assert.equal(run.store.turn(first.turnId).status, 'cancelled');
  const continued = accepted(
    await run.coordinator.handle(
      input('continue-on-chat', {
        investigationId: first.investigationId,
        action: 'continue',
        text: 'continue investigation',
      }),
    ),
  );
  await run.coordinator.idle();
  assert.equal(continued.investigationId, first.investigationId);
  assert.equal(run.store.turn(continued.turnId).status, 'completed');
  assert.deepEqual(
    run.store.acceptances().map((a) => a.request.message.address.channelInstanceId),
    ['chat', 'http', 'chat'],
  );
});

test('recovered controls persist a reply without their adapter and deliver it later without repeating effects', async (t) => {
  const f = await setup(t);
  let run = await f.start();
  const first = accepted(await run.coordinator.handle(input('before-control-crash')));
  await run.coordinator.idle();
  const message = input('queued-control-before-removal', {
    investigationId: first.investigationId,
    action: 'retry-delivery',
    text: 'retry',
  });
  const turnId = randomUUID();
  await run.store.accept({
    version: 1,
    key: messageKey(message),
    sequence: 2,
    acceptedAt: new Date().toISOString(),
    request: {
      investigationId: first.investigationId,
      turnId,
      scope: run.host.authorize(principal, 'a'),
      message,
    },
  });
  await run.coordinator.close();
  f.disableSource();
  run = await f.start();
  await run.coordinator.idle();
  assert.equal(run.store.turn(turnId).status, 'handled');
  const pending = run.store
    .deliveries()
    .filter((delivery) => delivery.message.reference?.turnId === turnId);
  assert.ok(pending.length > 0);
  assert.ok(
    pending.every(
      (delivery) =>
        delivery.status === 'pending' &&
        delivery.attempts === 0 &&
        delivery.message.address.channelInstanceId === 'chat',
    ),
  );
  await run.coordinator.close();
  f.enableSource();
  run = await f.start();
  await run.coordinator.idle();
  assert.equal(run.store.turn(turnId).status, 'handled');
  assert.equal(run.coordinator.metrics.turns, 0);
  const delivered = run.store
    .deliveries()
    .filter((delivery) => delivery.message.reference?.turnId === turnId);
  assert.deepEqual(
    delivered.map((delivery) => delivery.message),
    pending.map((delivery) => delivery.message),
  );
  assert.ok(delivered.every((delivery) => delivery.status === 'sent'));
  assert.equal(
    run.sent.filter((message) => message.reference?.turnId === turnId).length,
    pending.length,
  );
});
