import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import restPlugin, { RestChannel } from '../src/plugins/rest/index.js';
import type {
  ChannelMessage,
  OutboundMessage,
  PluginContext,
  MessageHandler,
} from '../src/plugin-api/index.js';
import { PluginHost } from '../src/core/host.js';
import { InvestigationCoordinator } from '../src/core/coordinator.js';
import { InvestigationStore } from '../src/core/store.js';
import { builtinPlugins } from '../src/plugins/catalog.js';
import { fixture } from './helpers.js';

const token = 'SYNTHETIC_REST_TOKEN_ONLY';
const identity = { tenantId: 'tenant', conversationId: 'room', senderId: 'user' };
const accept: MessageHandler = async () => ({
  status: 'accepted',
  investigationId: 'event',
  turnId: 'turn',
});
const readAccess = { authorizeInvestigation() {} };
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const url = (channel: RestChannel) => 'http://127.0.0.1:' + channel.address!.port + '/messages';
async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-rest-test-'));
  const context: PluginContext = {
    instanceId: 'http',
    configFile: path.join(root, 'config.yaml'),
    stateDirectory: path.join(root, 'state'),
    resolvePath: (file) => path.resolve(root, file),
  };
  const channels: RestChannel[] = [];
  t.after(async () => {
    for (const channel of channels) await channel.stop();
    await rm(root, { recursive: true, force: true });
  });
  async function create(overrides: Partial<PluginContext> = {}) {
    const instance = await restPlugin.create(
      { ...identity, port: 0, token },
      { ...context, ...overrides },
    );
    assert.ok(!JSON.stringify(instance.scope).includes(token));
    const channel = instance.channel as RestChannel;
    channels.push(channel);
    return channel;
  }
  const outbound = (id: string): OutboundMessage => ({
    address: {
      channelInstanceId: context.instanceId,
      tenantId: identity.tenantId,
      conversationId: identity.conversationId,
    },
    idempotencyKey: id,
    text: 'reply ' + id,
    reference: { investigationId: 'event', turnId: 'turn' },
  });
  return { root, context, create, outbound };
}
const post = (endpoint: string, message: unknown) =>
  fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(message) });

test('REST authenticates every request, fixes caller identity and bounds malformed inputs without echoing them', async (t) => {
  const f = await setup(t);
  const channel = await f.create();
  const seen: ChannelMessage[] = [];
  await channel.start(
    async (message) => {
      seen.push(message);
      if (message.text === 'fail') throw new Error(token);
      if (message.text === 'reject') return { status: 'rejected', reason: 'ACCESS_DENIED' };
      return accept(message);
    },
    new AbortController().signal,
    readAccess,
  );
  for (const endpoint of [url(channel), url(channel) + '?token=' + token]) {
    const unauthorized = await fetch(endpoint);
    assert.equal(unauthorized.status, 401);
    assert.ok(!(await unauthorized.text()).includes(token));
  }
  assert.equal(
    (await fetch(url(channel), { headers: { Authorization: 'Bearer wrong' } })).status,
    401,
  );
  const message = { messageId: 'one', text: 'investigate', targetId: 'dev' };
  const accepted = await post(url(channel), message);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    status: 'accepted',
    investigationId: 'event',
    turnId: 'turn',
  });
  assert.deepEqual(seen[0], { ...message, address: f.outbound('x').address, senderId: 'user' });
  for (const body of [
    null,
    [],
    { ...message, senderId: 'admin' },
    { ...message, address: { channelInstanceId: 'lark' } },
    { ...message, unknown: true },
    { ...message, action: 'delete' },
  ])
    assert.equal((await post(url(channel), body)).status, 400);
  assert.equal(
    (await fetch(url(channel), { method: 'POST', headers, body: '{' + token })).status,
    400,
  );
  assert.equal(
    (await fetch(url(channel), { method: 'POST', headers, body: new Uint8Array([255]) })).status,
    400,
  );
  assert.equal(
    (
      await fetch(url(channel), {
        method: 'POST',
        headers: { Authorization: headers.Authorization },
        body: '{}',
      })
    ).status,
    415,
  );
  assert.equal((await post(url(channel), { ...message, text: 'x'.repeat(70000) })).status, 413);
  assert.equal((await fetch(url(channel) + '?after=-1', { headers })).status, 400);
  assert.equal((await fetch(url(channel) + '?limit=101', { headers })).status, 400);
  assert.equal((await fetch(url(channel) + '?conversationId=other', { headers })).status, 400);
  assert.equal((await post(url(channel) + '?token=' + token, message)).status, 400);
  assert.equal((await fetch(url(channel) + '/unknown', { headers })).status, 404);
  assert.equal((await fetch(url(channel), { method: 'DELETE', headers })).status, 405);
  assert.equal((await post(url(channel), { ...message, text: 'reject' })).status, 422);
  const failed = await post(url(channel), { ...message, text: 'fail' });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'REST_UNAVAILABLE' });
  assert.equal(seen.length, 3);
});

test('REST mailbox has ordered durable cursors, idempotent receipts, append-only revisions and isolated instances', async (t) => {
  const f = await setup(t);
  let channel = await f.create();
  await channel.start(accept, new AbortController().signal, readAccess);
  const receipts = await Promise.all(
    Array.from({ length: 5 }, (_, i) => channel.send(f.outbound('key-' + i))),
  );
  assert.deepEqual(await channel.send(f.outbound('key-0')), receipts[0]);
  await assert.rejects(channel.send({ ...f.outbound('key-0'), text: 'different' }), {
    code: 'REST_IDEMPOTENCY_CONFLICT',
  });
  await assert.rejects(
    channel.send({
      ...f.outbound('wrong'),
      address: { ...f.outbound('wrong').address, conversationId: 'other' },
    }),
    { code: 'OUTBOUND_SOURCE_MISMATCH' },
  );
  await assert.rejects(channel.send({ ...f.outbound('huge'), text: 'x'.repeat(131072) }), {
    code: 'REST_REPLY_TOO_LARGE',
  });
  const read = async (after = 0, limit = 20) =>
    (
      await fetch(url(channel) + `?investigationId=event&after=${after}&limit=${limit}`, {
        headers,
      })
    ).json() as Promise<{
      messages: { cursor: number; messageId: string; text: string }[];
      nextCursor: number;
    }>;
  const first = await read(0, 2);
  assert.deepEqual(
    first.messages.map((m) => m.text),
    ['reply key-0', 'reply key-1'],
  );
  assert.equal(first.nextCursor, 2);
  const second = await read(first.nextCursor);
  assert.deepEqual(
    second.messages.map((m) => m.cursor),
    [3, 4, 5],
  );
  const revision = { ...f.outbound('key-0'), text: 'revised reply' };
  const revised = await channel.update(receipts[0]!, revision);
  assert.deepEqual(await channel.update(receipts[0]!, revision), revised);
  assert.notDeepEqual(revised, receipts[0]);
  assert.equal((await read(5)).messages[0]!.text, 'revised reply');
  await assert.rejects(channel.update({ ...receipts[0]!, messageIds: ['unknown'] }, revision), {
    code: 'REST_RECEIPT_UNKNOWN',
  });
  await channel.stop();
  channel = await f.create();
  await channel.start(accept, new AbortController().signal, readAccess);
  assert.deepEqual(await channel.send(f.outbound('key-0')), receipts[0]);
  assert.equal((await read(5)).messages.length, 1);
  assert.equal((await read(6)).nextCursor, 6);
  await channel.send(f.outbound('after-restart'));
  assert.equal((await read(6)).nextCursor, 7);
  const mailbox = path.join(f.context.stateDirectory!, 'mailbox');
  await rename(mailbox, mailbox + '-offline');
  await assert.rejects(channel.send(f.outbound('io-retry')), { code: 'ENOENT' });
  await rename(mailbox + '-offline', mailbox);
  await channel.send(f.outbound('io-retry'));
  assert.equal((await read(7)).messages[0]!.text, 'reply io-retry');
  const other = await f.create({ instanceId: 'other', stateDirectory: path.join(f.root, 'other') });
  await other.start(accept, new AbortController().signal, readAccess);
  assert.deepEqual(await (await fetch(url(other) + '?investigationId=event', { headers })).json(), {
    messages: [],
    nextCursor: 0,
  });
});

test('REST startup cancellation and listener failure clean up without accepting late requests', async (t) => {
  const f = await setup(t);
  const channel = await f.create();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(channel.start(accept, aborted.signal), { name: 'AbortError' });
  const start = channel.start(accept, new AbortController().signal, readAccess);
  await assert.rejects(channel.start(accept, new AbortController().signal, readAccess), {
    code: 'CHANNEL_ALREADY_STARTED',
  });
  await channel.stop();
  await assert.rejects(start, { name: 'AbortError' });
  assert.equal(channel.address, undefined);
  await channel.start(accept, new AbortController().signal, readAccess);
  const endpoint = url(channel);
  const conflictInstance = await restPlugin.create(
    { ...identity, token, port: channel.address!.port },
    { ...f.context, stateDirectory: path.join(f.root, 'conflict') },
  );
  const conflict = conflictInstance.channel!;
  await assert.rejects(conflict.start(accept, new AbortController().signal, readAccess), {
    code: 'EADDRINUSE',
  });
  await conflictInstance.dispose();
  assert.equal((await fetch(endpoint + '?investigationId=event', { headers })).status, 200);
  await Promise.all([channel.stop(), channel.stop()]);
  await assert.rejects(fetch(endpoint + '?investigationId=event', { headers }));
  await mkdir(path.join(f.root, 'bad', 'mailbox'), { recursive: true });
  await writeFile(path.join(f.root, 'bad', 'mailbox', 'bad.json'), 'invalid');
  const bad = await f.create({ stateDirectory: path.join(f.root, 'bad') });
  await assert.rejects(bad.start(accept, new AbortController().signal, readAccess), {
    code: 'REST_MAILBOX_INVALID',
  });
  assert.equal(bad.address, undefined);
});

test('REST curl flow uses host authorization, durable acceptance, follow-ups and relative configFile/token paths', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'http', 'keys'), { recursive: true });
  await writeFile(path.join(f.root, 'http', 'keys', 'rest.token'), token);
  await writeFile(
    path.join(f.root, 'http', 'rest.yaml'),
    stringify({ ...identity, tokenFile: './keys/rest.token', port: 0 }),
  );
  await f.writeConfig({
    ...f.config,
    runtime: { stateDirectory: path.join(f.root, 'state') },
    plugins: {
      ...f.config.plugins,
      chat: { module: builtinPlugins.rest!, configFile: './http/rest.yaml' },
    },
  });
  let coordinator: InvestigationCoordinator | undefined;
  try {
    async function start() {
      const host = await PluginHost.load(f.configFile, builtinPlugins);
      const store = await InvestigationStore.open(host.runtime.stateDirectory);
      coordinator = new InvestigationCoordinator(host, store);
      await coordinator.start();
      return { host, store, channel: host.channelFor('chat') as RestChannel };
    }
    let run = await start();
    const message = { messageId: 'first', text: 'synthetic error', targetId: 'a' };
    const accepted = await post(url(run.channel), message);
    assert.equal(accepted.status, 202);
    const reference = (await accepted.json()) as { investigationId: string; turnId: string };
    await coordinator!.idle();
    assert.equal(run.store.acceptances().length, 1);
    assert.equal((await post(url(run.channel), message)).status, 202);
    await coordinator!.idle();
    assert.equal(run.store.acceptances().length, 1);
    assert.equal(
      (await post(url(run.channel), { ...message, messageId: 'denied', targetId: 'not-allowed' }))
        .status,
      422,
    );
    assert.equal(
      (
        await post(url(run.channel), {
          messageId: 'follow-up',
          text: 'explain',
          investigationId: reference.investigationId,
        })
      ).status,
      202,
    );
    await coordinator!.idle();
    assert.equal(run.store.acceptances().length, 2);
    assert.ok(
      run.store
        .acceptances()
        .every(
          (a) =>
            a.request.investigationId === reference.investigationId &&
            a.request.scope.target.targetId === 'a',
        ),
    );
    assert.equal(
      (
        await post(url(run.channel), {
          messageId: 'switch',
          text: 'switch',
          investigationId: reference.investigationId,
          targetId: 'b',
        })
      ).status,
      422,
    );
    for (const action of ['status', 'cancel']) {
      assert.equal(
        (
          await post(url(run.channel), {
            messageId: action,
            text: action,
            investigationId: reference.investigationId,
            action,
          })
        ).status,
        202,
      );
      await coordinator!.idle();
    }
    const replies = (await (
      await fetch(url(run.channel) + '?investigationId=' + reference.investigationId, { headers })
    ).json()) as {
      messages: { messageId: string; text: string }[];
      nextCursor: number;
    };
    assert.ok(replies.messages.some((m) => m.text.includes('Synthetic fixture')));
    const count = replies.messages.length;
    await coordinator!.close();
    run = await start();
    await coordinator!.idle();
    const restored = (await (
      await fetch(url(run.channel) + '?investigationId=' + reference.investigationId, { headers })
    ).json()) as typeof replies;
    assert.equal(restored.messages.length, count);
    assert.deepEqual(
      restored.messages.map((m) => m.messageId),
      replies.messages.map((m) => m.messageId),
    );
    assert.equal((await post(url(run.channel), message)).status, 202);
    assert.equal(run.store.acceptances().length, 4);
    const files = await readdir(path.join(f.root, 'state', 'plugins', 'chat', 'mailbox'));
    const persisted = await Promise.all(
      files
        .filter((file) => file.endsWith('.json'))
        .map(async (file) =>
          JSON.parse(
            await readFile(path.join(f.root, 'state', 'plugins', 'chat', 'mailbox', file), 'utf8'),
          ),
        ),
    );
    assert.equal(
      persisted.filter(
        (entry) => entry.message.reference?.investigationId === reference.investigationId,
      ).length,
      count,
    );
  } finally {
    await coordinator?.close();
  }
});

test('REST requires one investigation, filters before pagination, and invokes current read authorization', async (t) => {
  const f = await setup(t);
  const channel = await f.create();
  let revoked = false;
  await channel.start(accept, new AbortController().signal, {
    authorizeInvestigation(principal, id) {
      assert.deepEqual(principal, { ...f.outbound('x').address, senderId: 'user' });
      if (revoked || !['event', 'other-event'].includes(id)) throw Error('denied');
    },
  });
  for (let i = 0; i < 6; i++)
    await channel.send({
      ...f.outbound('mixed-' + i),
      reference: { investigationId: i % 2 ? 'event' : 'other-event', turnId: 'turn-' + i },
    });
  for (const query of [
    '',
    '?after=0',
    '?investigationId=',
    '?investigationId=event&investigationId=other-event',
  ])
    assert.equal((await fetch(url(channel) + query, { headers })).status, 400);
  const page = async (id: string, after = 0) =>
    fetch(url(channel) + `?investigationId=${id}&after=${after}&limit=2`, { headers });
  const first = (await (await page('event')).json()) as {
    messages: { text: string }[];
    nextCursor: number;
  };
  assert.deepEqual(
    first.messages.map((m) => m.text),
    ['reply mixed-1', 'reply mixed-3'],
  );
  const second = (await (await page('event', first.nextCursor)).json()) as typeof first;
  assert.deepEqual(
    second.messages.map((m) => m.text),
    ['reply mixed-5'],
  );
  assert.equal((await page('unknown')).status, 403);
  revoked = true;
  assert.equal((await page('event')).status, 403);
  await channel.stop();
  await channel.start(accept, new AbortController().signal);
  assert.equal((await page('event')).status, 403, 'missing host authorization fails closed');
});

test('REST history reads reject another source and revoked target permissions even for known investigation IDs', async (t) => {
  const f = await fixture(t);
  const stateDirectory = path.join(f.root, 'state');
  let config = {
    ...f.config,
    runtime: { stateDirectory },
    plugins: {
      ...f.config.plugins,
      chat: { module: builtinPlugins.rest!, config: { ...identity, port: 0, token } },
      other: {
        module: builtinPlugins.rest!,
        config: { ...identity, conversationId: 'other-room', port: 0, token },
      },
    },
    routes: [
      ...f.config.routes,
      {
        channel: 'other',
        tenant: 'tenant',
        conversation: 'other-room',
        allowedSenders: ['user'],
        targets: ['a'],
      },
    ],
  };
  await f.writeConfig(config);
  let coordinator: InvestigationCoordinator | undefined;
  async function start() {
    const host = await PluginHost.load(f.configFile, builtinPlugins);
    const store = await InvestigationStore.open(stateDirectory);
    coordinator = new InvestigationCoordinator(host, store);
    await coordinator.start();
    return host;
  }
  try {
    let host = await start();
    const channel = host.channelFor('chat') as RestChannel;
    const other = host.channelFor('other') as RestChannel;
    const accepted = (await (
      await post(url(channel), {
        messageId: 'source-private',
        text: 'private investigation',
        targetId: 'a',
      })
    ).json()) as { investigationId: string };
    await coordinator!.idle();
    const query = '?investigationId=' + accepted.investigationId;
    assert.equal((await fetch(url(channel) + query, { headers })).status, 200);
    assert.equal((await fetch(url(other) + query, { headers })).status, 403);
    assert.equal(
      (
        await post(url(other), {
          messageId: 'cross-status',
          text: 'status',
          action: 'status',
          investigationId: accepted.investigationId,
        })
      ).status,
      422,
    );
    await coordinator!.close();
    config = {
      ...config,
      routes: config.routes.map((route) =>
        route.channel === 'chat' ? { ...route, targets: ['b'] } : route,
      ),
    };
    await f.writeConfig(config);
    host = await start();
    assert.equal(
      (await fetch(url(host.channelFor('chat') as RestChannel) + query, { headers })).status,
      403,
    );
  } finally {
    await coordinator?.close();
  }
});
