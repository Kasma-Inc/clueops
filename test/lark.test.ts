import test from 'node:test';
import { Client, WSClient, EventDispatcher, defaultHttpInstance } from '@larksuiteoapi/node-sdk';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import larkPlugin, { normalizeLarkEvent, createLarkDispatcher } from '../src/plugins/lark/index.js';
const identity = {
  appId: 'cli_0123456789abcdef',
  tenantId: 'tenant',
  botOpenId: 'bot',
  instanceId: 'lark',
};
const raw = (text: string) => ({
  app_id: identity.appId,
  tenant_key: 'tenant',
  sender: { sender_type: 'user', tenant_key: 'tenant', sender_id: { open_id: 'user' } },
  message: {
    chat_id: 'room',
    chat_type: 'group',
    message_id: 'message',
    message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 ' + text }),
    mentions: [{ key: '@_user_1', id: { open_id: 'bot' } }],
  },
});
test('Lark validates source identities, accepts addressed group logs and normalizes explicit commands', () => {
  const event = raw('/target prod\nERROR connection refused');
  const normalized = normalizeLarkEvent(event, identity)!;
  assert.equal(normalized.targetId, 'prod');
  assert.equal(normalized.text, 'ERROR connection refused');
  assert.equal(normalized.address.channelInstanceId, 'lark');
  assert.equal(normalizeLarkEvent({ ...event, app_id: 'wrong' }, identity), undefined);
  assert.equal(normalizeLarkEvent({ ...event, tenant_key: 'wrong' }, identity), undefined);
  assert.equal(
    normalizeLarkEvent({ ...event, sender: { ...event.sender, sender_type: 'app' } }, identity),
    undefined,
  );
  assert.equal(
    normalizeLarkEvent({ ...event, message: { ...event.message, mentions: [] } }, identity),
    undefined,
  );
  assert.equal(
    normalizeLarkEvent(raw('/target prod'), identity),
    undefined,
    'target-only reply never picks up old logs',
  );
  assert.equal(normalizeLarkEvent(raw('/continue event-1'), identity)!.action, 'continue');
  assert.equal(
    normalizeLarkEvent(raw('/event event-1 why?'), identity)!.investigationId,
    'event-1',
  );
  const reply = normalizeLarkEvent(
    { ...event, message: { ...event.message, parent_id: 'report-part-2', mentions: [] } },
    identity,
  )!;
  assert.equal(reply.replyToMessageId, 'report-part-2');
  const post = normalizeLarkEvent(
    {
      ...event,
      message: {
        ...event.message,
        message_type: 'post',
        content: JSON.stringify({
          en_us: {
            title: '',
            content: [
              [{ tag: 'text', text: '/target prod\nfirst' }],
              [{ tag: 'text', text: 'second' }],
            ],
          },
        }),
      },
    },
    identity,
  )!;
  assert.equal(post.text, 'first\nsecond');
  for (const [command, field, id] of [
    ['target', 'targetId', 'prod'],
    ['event', 'investigationId', 'event-1'],
  ] as const) {
    const tagged = normalizeLarkEvent(
      {
        ...event,
        message: {
          ...event.message,
          message_type: 'post',
          content: JSON.stringify({
            content: [
              [
                { tag: 'at', user_id: 'bot' },
                { tag: 'text', text: ` /${command} ${id}\nERROR rich log` },
              ],
            ],
          }),
        },
      },
      identity,
    )!;
    assert.equal(tagged[field], id);
    assert.equal(tagged.text, 'ERROR rich log');
  }
});
test('official EventDispatcher waits for durable acceptance and propagates failure for platform retry', async () => {
  let release: (() => void) | undefined;
  let completed = false;
  const dispatcher = createLarkDispatcher(
    identity,
    async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 'accepted', investigationId: 'i', turnId: 't' };
    },
    new AbortController().signal,
  );
  const event = raw('ERROR');
  const envelope = {
    schema: '2.0',
    header: {
      app_id: event.app_id,
      tenant_key: event.tenant_key,
      event_type: 'im.message.receive_v1',
    },
    event: { sender: event.sender, message: event.message },
  };
  const acknowledgement = dispatcher.invoke(envelope, { needCheck: false }).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  release!();
  await acknowledgement;
  assert.equal(completed, true);
  const failure = createLarkDispatcher(
    identity,
    async () => {
      throw new Error('PERSISTENCE_FAILED');
    },
    new AbortController().signal,
  );
  await assert.rejects(failure.invoke(envelope, { needCheck: false }), /PERSISTENCE_FAILED/);
});

test('Lark lazily reads only explicitly mentioned quotes and validates text, rich text and source', async (t) => {
  let dispatcher!: EventDispatcher;
  const http = defaultHttpInstance.create();
  t.mock.method(defaultHttpInstance, 'create', () => http);
  t.mock.method(http, 'post', async () => ({
    code: 0,
    tenant_access_token: 'SYNTHETIC_QUOTE_TOKEN',
    expire: 7200,
  }));
  let item = {
    message_id: 'quoted-log',
    chat_id: 'room',
    msg_type: 'text',
    deleted: false,
    body: { content: JSON.stringify({ text: '/target wrong\nERROR original log' }) },
  };
  let code = 0,
    reads = 0;
  t.mock.method(http, 'request', async (request: { url: string }) => {
    if (request.url.includes('/auth/'))
      return { code: 0, tenant_access_token: 'SYNTHETIC_QUOTE_TOKEN', expire: 7200 };
    reads++;
    assert.ok(request.url.endsWith('/messages/quoted-log'));
    return { code, data: { items: [item] } };
  });
  t.mock.method(
    WSClient.prototype,
    'start',
    async function (this: WSClient, options: Parameters<WSClient['start']>[0]) {
      dispatcher = options.eventDispatcher!;
      (this as unknown as { onReady(): void }).onReady();
    },
  );
  t.mock.method(WSClient.prototype, 'close', () => {});
  const instance = await larkPlugin.create({ ...minimalConfig, botOpenId: 'bot' }, pluginContext);
  t.after(() => instance.dispose());
  let shouldRead = true,
    expectedReader = true;
  let received: { messageId: string; text: string } | undefined;
  await instance.channel!.start(async (message, reception) => {
    const reader = reception?.readContext;
    if (!expectedReader) assert.equal(reception?.linkedReplyOnly, true);
    assert.equal(message.targetId, 'prod');
    assert.equal(Boolean(reader), expectedReader);
    if (shouldRead && reader) received = await reader(new AbortController().signal);
    return accepted();
  }, new AbortController().signal);
  const emit = async (mentioned = true) => {
    const event = raw('/target prod');
    await dispatcher.invoke(
      {
        schema: '2.0',
        header: {
          app_id: event.app_id,
          tenant_key: event.tenant_key,
          event_type: 'im.message.receive_v1',
        },
        event: {
          sender: event.sender,
          message: {
            ...event.message,
            parent_id: 'quoted-log',
            mentions: mentioned ? event.message.mentions : [],
          },
        },
      },
      { needCheck: false },
    );
  };
  await emit();
  assert.deepEqual(received, {
    messageId: 'quoted-log',
    text: '/target wrong\nERROR original log',
  });
  assert.equal(reads, 1);
  item = {
    ...item,
    msg_type: 'post',
    body: {
      content: JSON.stringify({
        content: [
          [
            { tag: 'text', text: 'rich log ' },
            { tag: 'a', text: 'link label', href: 'https://example.invalid' },
          ],
        ],
      }),
    },
  };
  await emit();
  assert.equal(received!.text, 'rich log link label');
  for (const [title, tag] of [
    ['线上报错', 'code_block'],
    ['', 'code_block'],
    ['', 'md'],
  ] as const) {
    item = {
      ...item,
      body: {
        content: JSON.stringify({
          title,
          content: [[{ tag, language: 'BASH', text: 'ERROR database connection refused' }]],
        }),
      },
    };
    await emit();
    assert.ok(received!.text.includes('ERROR database connection refused'));
    if (title) assert.ok(received!.text.includes(title));
  }
  const fetched = reads;
  shouldRead = false;
  await emit();
  assert.equal(reads, fetched, 'merely receiving a reader does not fetch a message');
  expectedReader = false;
  // A non-mentioned parent still normalizes as a possible investigation followup.
  const plain = raw('/target prod question');
  await dispatcher.invoke(
    {
      schema: '2.0',
      header: {
        app_id: plain.app_id,
        tenant_key: plain.tenant_key,
        event_type: 'im.message.receive_v1',
      },
      event: {
        sender: plain.sender,
        message: {
          ...plain.message,
          content: JSON.stringify({ text: '/target prod question' }),
          parent_id: 'quoted-log',
          mentions: [],
        },
      },
    },
    { needCheck: false },
  );
  assert.equal(reads, fetched);
  expectedReader = true;
  shouldRead = true;
  const valid = { ...item };
  for (const [changed, reason] of [
    [{ ...valid, chat_id: 'other-room' }, 'QUOTED_MESSAGE_UNAVAILABLE'],
    [{ ...valid, message_id: 'other-id' }, 'QUOTED_MESSAGE_UNAVAILABLE'],
    [{ ...valid, deleted: true }, 'QUOTED_MESSAGE_UNAVAILABLE'],
    [{ ...valid, msg_type: 'image' }, 'QUOTED_MESSAGE_UNSUPPORTED'],
    [
      {
        ...valid,
        body: {
          content: JSON.stringify({
            title: '标题不是图片内容',
            content: [[{ tag: 'img', image_key: 'synthetic' }]],
          }),
        },
      },
      'QUOTED_MESSAGE_UNSUPPORTED',
    ],
    [{ ...valid, body: { content: 'x'.repeat(131073) } }, 'QUOTED_MESSAGE_TOO_LARGE'],
  ] as const) {
    item = changed;
    await assert.rejects(emit(), { code: reason });
  }
  item = valid;
  code = 99991672;
  await assert.rejects(emit(), { code: 'QUOTED_MESSAGE_UNAVAILABLE' });
});

test('Lark derives tenant identity from authenticated events and keeps optional tenant pinning', () => {
  const { tenantId: _tenant, ...automatic } = identity;
  const event = raw('ERROR');
  assert.equal(normalizeLarkEvent(event, automatic)!.address.tenantId, 'tenant');
  const other = { ...event, tenant_key: 'other', sender: { ...event.sender, tenant_key: 'other' } };
  assert.equal(normalizeLarkEvent(other, automatic)!.address.tenantId, 'other');
  assert.equal(normalizeLarkEvent(other, identity), undefined);
  assert.equal(normalizeLarkEvent({ ...event, tenant_key: '' }, automatic), undefined);
  assert.equal(
    normalizeLarkEvent(
      { ...event, sender: { ...event.sender, tenant_key: 'mismatch' } },
      automatic,
    ),
    undefined,
  );
  const { tenant_key: _senderTenant, ...sender } = event.sender;
  assert.ok(normalizeLarkEvent({ ...event, sender }, automatic));
});

const pluginContext = {
  instanceId: 'lark',
  configFile: '/tmp/lark-test.yaml',
  resolvePath: (file: string) => path.resolve('/tmp', file),
};
const minimalConfig = { appId: identity.appId, appSecret: 'SYNTHETIC_LARK_SECRET' };
const accepted = async () => ({ status: 'accepted' as const, investigationId: 'i', turnId: 't' });

test('Lark reply help exposes copyable commands for this investigation using the existing parser', async () => {
  const instance = await larkPlugin.create(minimalConfig, pluginContext);
  try {
    const reference = { investigationId: '56435287-31c5-4a9c-b403-ddba199c5261', turnId: 'turn' };
    const messages = instance.channel!.renderReply!(
      {
        kind: 'status',
        targetId: 'dev',
        text: 'INTERNAL STATUS',
        reference,
        turns: [{ sequence: 1, turnId: 'turn', status: 'completed' }],
      },
      3500,
    );
    const formatted = messages.map((message) => message.text).join('');
    assert.ok(formatted.startsWith('• 第 1 轮：已完成\n\n'));
    assert.ok(!formatted.includes('INTERNAL STATUS'));
    assert.match(formatted, /在本群 @机器人/);
    assert.match(formatted, /回复此卡片并 @机器人/);
    assert.match(formatted, /重试发送/);
    const commands = formatted.split('\n').flatMap((line) => {
      const slash = line.indexOf('/');
      return slash === -1 ? [] : [line.slice(slash)];
    });
    assert.equal(commands.length, 5);
    for (const [index, action] of [
      'event',
      'status',
      'cancel',
      'continue',
      'retry-delivery',
    ].entries()) {
      const command = normalizeLarkEvent(raw(commands[index]!), identity)!;
      assert.ok(command, 'advertised commands must be accepted');
      assert.equal(command.investigationId, reference.investigationId);
      assert.equal(command.action, action === 'event' ? undefined : action);
      if (action === 'event') assert.equal(command.text, '你的问题');
    }
    assert.equal(
      normalizeLarkEvent(raw(`/continue ${reference.investigationId} 更多日志`), identity)!.text,
      '更多日志',
    );
  } finally {
    await instance.dispose();
  }
});

test('Lark replies to the triggering request with stable UUIDs and preserves legacy delivery', async (t) => {
  const calls: Array<{ url: string; method: string; data: Record<string, unknown> }> = [];
  let refuseReply = false;
  const http = defaultHttpInstance.create();
  t.mock.method(defaultHttpInstance, 'create', () => http);
  t.mock.method(http, 'post', async () => ({
    code: 0,
    tenant_access_token: 'SYNTHETIC_CARD_TOKEN',
    expire: 7200,
  }));
  t.mock.method(
    http,
    'request',
    async (request: { url: string; method: string; data: Record<string, unknown> }) => {
      if (request.url.includes('/auth/'))
        return { code: 0, tenant_access_token: 'SYNTHETIC_CARD_TOKEN', expire: 7200 };
      calls.push(request);
      if (refuseReply) return { code: 230011 };
      return { code: 0, data: { message_id: 'card-message' } };
    },
  );
  const instance = await larkPlugin.create(
    { ...minimalConfig, appId: 'cli_card_delivery_test' },
    pluginContext,
  );
  try {
    const reference = { investigationId: 'event', turnId: 'turn' };
    const [rendered] = instance.channel!.renderReply!(
      { kind: 'status', reference, targetId: 'dev', text: '已完成' },
      3500,
    );
    const message = {
      ...rendered!,
      address: { channelInstanceId: 'lark', tenantId: 'tenant', conversationId: 'room' },
      reference,
      replyToMessageId: 'user-request',
      idempotencyKey: 'stable-key',
    };
    const receipt = await instance.channel!.send(message);
    await instance.channel!.send(message);
    await instance.channel!.update(receipt, message);
    assert.equal(calls[0]!.data.msg_type, 'interactive');
    assert.ok(calls[0]!.url.endsWith('/messages/user-request/reply'));
    assert.ok(calls[1]!.url.endsWith('/messages/user-request/reply'));
    assert.equal(calls[0]!.data.reply_in_thread, false);
    assert.equal(calls[0]!.data.receive_id, undefined);
    assert.deepEqual(JSON.parse(calls[0]!.data.content as string), message.payload);
    assert.equal(calls[0]!.data.uuid, calls[1]!.data.uuid);
    assert.equal(calls[2]!.method, 'PATCH');
    const { payload: _payload, ...legacy } = message;
    await instance.channel!.send(legacy);
    await instance.channel!.update(receipt, legacy);
    assert.equal(calls[3]!.data.msg_type, 'text');
    assert.ok(calls[3]!.url.endsWith('/messages/user-request/reply'));
    assert.equal(calls[4]!.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[3]!.data.content as string), { text: legacy.text });
    const { replyToMessageId: _reply, ...oldText } = legacy;
    const { replyToMessageId: _cardReply, ...oldCard } = message;
    await instance.channel!.send(oldText);
    await instance.channel!.send(oldCard);
    assert.ok(calls[5]!.url.endsWith('/messages'));
    assert.equal(calls[5]!.data.receive_id, 'room');
    assert.equal(calls[5]!.data.msg_type, 'text');
    assert.equal(calls[6]!.data.msg_type, 'interactive');
    assert.equal(calls[6]!.data.uuid, calls[0]!.data.uuid);
    refuseReply = true;
    const before = calls.length;
    await assert.rejects(instance.channel!.send(message), { code: 'LARK_SEND_RECEIPT_UNKNOWN' });
    assert.equal(calls.length, before + 1, 'reply errors cannot fall back to unquoted sends');
    assert.ok(calls.at(-1)!.url.endsWith('/messages/user-request/reply'));
  } finally {
    await instance.dispose();
  }
});

test('Lark credential-only startup discovers its bot through the SDK and receives tenant-scoped messages', async (t) => {
  let dispatcher: EventDispatcher | undefined;
  const lookup = t.mock.method(
    Client.prototype,
    'request',
    async (options: Parameters<Client['request']>[0]) => {
      assert.equal(options.url, '/open-apis/bot/v3/info');
      assert.equal(options.method, 'GET');
      return { code: 0, bot: { open_id: 'bot' } };
    },
  );
  t.mock.method(
    WSClient.prototype,
    'start',
    async function (this: WSClient, options: Parameters<WSClient['start']>[0]) {
      dispatcher = options.eventDispatcher;
      (this as unknown as { onReady(): void }).onReady();
    },
  );
  t.mock.method(WSClient.prototype, 'close', () => {});
  const instance = await larkPlugin.create(minimalConfig, pluginContext);
  try {
    assert.equal(lookup.mock.callCount(), 0, 'configuration loading does not make network calls');
    const messages: unknown[] = [];
    await instance.channel!.start(async (message) => {
      messages.push(message);
      return accepted();
    }, new AbortController().signal);
    assert.equal(lookup.mock.callCount(), 1);
    for (const tenant of ['tenant-a', 'tenant-b']) {
      const event = raw('ERROR');
      await dispatcher!.invoke(
        {
          schema: '2.0',
          header: {
            app_id: identity.appId,
            tenant_key: tenant,
            event_type: 'im.message.receive_v1',
          },
          event: { message: event.message, sender: { ...event.sender, tenant_key: tenant } },
        },
        { needCheck: false },
      );
    }
    assert.deepEqual(
      messages.map((value) => (value as { address: { tenantId: string } }).address.tenantId),
      ['tenant-a', 'tenant-b'],
    );
  } finally {
    await instance.dispose();
  }
});

test('explicit Lark bot identity skips lookup and keeps configured tenant filtering', async (t) => {
  const lookup = t.mock.method(Client.prototype, 'request', async () => {
    throw Error('lookup must not run');
  });
  let dispatcher: EventDispatcher | undefined;
  t.mock.method(
    WSClient.prototype,
    'start',
    async function (this: WSClient, options: Parameters<WSClient['start']>[0]) {
      dispatcher = options.eventDispatcher;
      (this as unknown as { onReady(): void }).onReady();
    },
  );
  t.mock.method(WSClient.prototype, 'close', () => {});
  const instance = await larkPlugin.create(
    { ...minimalConfig, botOpenId: 'bot', tenantId: 'tenant' },
    pluginContext,
  );
  let calls = 0;
  try {
    await instance.channel!.start(async () => {
      calls++;
      return accepted();
    }, new AbortController().signal);
    const event = raw('ERROR');
    await dispatcher!.invoke(
      {
        schema: '2.0',
        header: {
          app_id: identity.appId,
          tenant_key: 'other',
          event_type: 'im.message.receive_v1',
        },
        event: { message: event.message, sender: { ...event.sender, tenant_key: 'other' } },
      },
      { needCheck: false },
    );
    assert.equal(calls, 0);
    assert.equal(lookup.mock.callCount(), 0);
  } finally {
    await instance.dispose();
  }
});

test('Lark invalid identity lookup fails without starting a listener or leaking upstream errors', async (t) => {
  let response: unknown;
  t.mock.method(Client.prototype, 'request', async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const start = t.mock.method(WSClient.prototype, 'start', async () => {});
  for (response of [
    null,
    { code: 403 },
    { code: 0, bot: { open_id: '' } },
    Error('SYNTHETIC_LARK_SECRET'),
  ]) {
    const instance = await larkPlugin.create(minimalConfig, pluginContext);
    try {
      await assert.rejects(instance.channel!.start(accepted, new AbortController().signal), {
        code: 'LARK_BOT_IDENTITY_FAILED',
      });
    } finally {
      await instance.dispose();
    }
  }
  assert.equal(start.mock.callCount(), 0);
});

test('Lark stop cancels identity discovery, rejects overlapping starts and ignores late identity results', async (t) => {
  let release: ((value: unknown) => void) | undefined;
  t.mock.method(
    Client.prototype,
    'request',
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const listen = t.mock.method(WSClient.prototype, 'start', async () => {});
  const instance = await larkPlugin.create(minimalConfig, pluginContext);
  try {
    const start = instance.channel!.start(accepted, new AbortController().signal);
    await assert.rejects(instance.channel!.start(accepted, new AbortController().signal), {
      code: 'CHANNEL_ALREADY_STARTED',
    });
    await instance.channel!.stop();
    await assert.rejects(start, { code: 'LARK_START_ABORTED' });
    release!({ code: 0, bot: { open_id: 'bot' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(listen.mock.callCount(), 0);
  } finally {
    await instance.dispose();
  }
});

test('Lark startup failure observes both SDK start and readiness rejection', async (t) => {
  t.mock.method(WSClient.prototype, 'start', async function (this: WSClient) {
    (this as unknown as { onError(): void }).onError();
  });
  t.mock.method(WSClient.prototype, 'close', () => {});
  const instance = await larkPlugin.create({ ...minimalConfig, botOpenId: 'bot' }, pluginContext);
  try {
    await assert.rejects(instance.channel!.start(accepted, new AbortController().signal), {
      code: 'LARK_CONNECTION_FAILED',
    });
  } finally {
    await instance.dispose();
  }
});

test('Lark identity discovery has a bounded wait and cannot start a socket after timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Client.prototype, 'request', () => new Promise(() => {}));
  const listen = t.mock.method(WSClient.prototype, 'start', async () => {});
  const instance = await larkPlugin.create(minimalConfig, pluginContext);
  try {
    const failure = assert.rejects(
      instance.channel!.start(accepted, new AbortController().signal),
      { code: 'LARK_BOT_IDENTITY_FAILED' },
    );
    t.mock.timers.tick(8001);
    await failure;
    assert.equal(listen.mock.callCount(), 0);
  } finally {
    await instance.dispose();
  }
});

test(
  'real SDK token pre-request is bounded and cancelled with identity discovery',
  { timeout: 10000 },
  async (t) => {
    let seen!: () => void;
    let disconnected!: () => void;
    const received = new Promise<void>((resolve) => {
      seen = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const server = createServer((req) => {
      req.resume();
      seen();
    });
    server.on('connection', (socket) => socket.once('close', disconnected));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    let observedSignal: AbortSignal | undefined;
    let observedTimeout: number | undefined;
    const redirect = (
      options: Parameters<
        NonNullable<Parameters<typeof defaultHttpInstance.interceptors.request.use>[0]>
      >[0],
    ) => {
      options.url = origin + new URL(options.url!, 'https://open.larksuite.com').pathname;
      observedSignal = options.signal as AbortSignal | undefined;
      observedTimeout = options.timeout;
      return options;
    };
    // Redirect both the pre-fix shared transport and the fixed instance transport locally.
    const fallback = defaultHttpInstance.interceptors.request.use(redirect);
    t.after(async () => {
      defaultHttpInstance.interceptors.request.eject(fallback);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const create = defaultHttpInstance.create.bind(defaultHttpInstance);
    t.mock.method(
      defaultHttpInstance,
      'create',
      (options: Parameters<typeof defaultHttpInstance.create>[0]) => {
        const http = create(options);
        http.interceptors.request.use(redirect);
        return http;
      },
    );
    const socketStart = t.mock.method(WSClient.prototype, 'start', async () => {});
    const instance = await larkPlugin.create(
      { ...minimalConfig, appId: 'cli_' + randomBytes(8).toString('hex') },
      pluginContext,
    );
    try {
      const start = instance.channel!.start(accepted, new AbortController().signal);
      const rejected = assert.rejects(start, { code: 'LARK_START_ABORTED' });
      await received;
      await instance.channel!.stop();
      await rejected;
      assert.equal(observedTimeout, 8000);
      assert.ok(observedSignal?.aborted, 'token POST inherits the discovery abort signal');
      await closed;
      assert.equal(socketStart.mock.callCount(), 0);
    } finally {
      await instance.dispose();
    }
  },
);

test('Lark cancels message requests and token pre-requests when its lifecycle stops', async (t) => {
  for (const operation of [
    'send',
    'reply',
    'update',
    'patch',
    'token',
    'quote',
    'quote-token',
  ] as const) {
    await t.test(operation, async (t) => {
      const sockets = new Set<import('node:net').Socket>();
      let incoming!: () => void;
      const received = new Promise<void>((resolve) => {
        incoming = resolve;
      });
      const server = createServer((request, response) => {
        if (
          request.url?.includes('/auth/') &&
          operation !== 'token' &&
          operation !== 'quote-token'
        ) {
          request.resume();
          response.setHeader('Content-Type', 'application/json');
          response.end(
            JSON.stringify({ code: 0, tenant_access_token: 'SYNTHETIC_HTTP_TOKEN', expire: 7200 }),
          );
        } else incoming();
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      let observedSignal: AbortSignal | undefined, observedTimeout: number | undefined;
      const redirect = (
        options: Parameters<
          NonNullable<Parameters<typeof defaultHttpInstance.interceptors.request.use>[0]>
        >[0],
      ) => {
        options.url = origin + new URL(options.url!, 'https://open.larksuite.com').pathname;
        observedSignal = options.signal as AbortSignal | undefined;
        observedTimeout = options.timeout;
        return options;
      };
      // Both current and pre-fix transports stay on the local synthetic server.
      const fallback = defaultHttpInstance.interceptors.request.use(redirect);
      const create = defaultHttpInstance.create.bind(defaultHttpInstance);
      t.mock.method(defaultHttpInstance, 'create', (options: Parameters<typeof create>[0]) => {
        const http = create(options);
        http.interceptors.request.use(redirect);
        return http;
      });
      let dispatcher!: EventDispatcher;
      t.mock.method(
        WSClient.prototype,
        'start',
        async function (this: WSClient, options: Parameters<WSClient['start']>[0]) {
          dispatcher = options.eventDispatcher!;
          (this as unknown as { onReady(): void }).onReady();
        },
      );
      t.mock.method(WSClient.prototype, 'close', () => {});
      const instance = await larkPlugin.create(
        { ...minimalConfig, appId: 'cli_' + randomBytes(8).toString('hex'), botOpenId: 'bot' },
        pluginContext,
      );
      let pending: Promise<string> | undefined;
      try {
        let reader: import('../src/plugin-api/index.js').MessageContextReader | undefined;
        await instance.channel!.start(async (_message, readContext) => {
          reader = readContext?.readContext;
          return accepted();
        }, new AbortController().signal);
        const message: import('../src/plugin-api/index.js').OutboundMessage = {
          address: { channelInstanceId: 'lark', tenantId: 'tenant', conversationId: 'room' },
          text: 'synthetic report',
          idempotencyKey: 'delivery',
          ...(operation === 'reply' ? { replyToMessageId: 'user-request' } : {}),
          ...(operation === 'patch' ? { payload: { schema: '2.0' } } : {}),
        };
        if (operation === 'quote' || operation === 'quote-token') {
          const event = raw('/target prod question');
          const appId = (instance.scope as { appId: string }).appId;
          await dispatcher.invoke(
            {
              schema: '2.0',
              header: { app_id: appId, tenant_key: 'tenant', event_type: 'im.message.receive_v1' },
              event: {
                sender: event.sender,
                message: { ...event.message, parent_id: 'quoted-log' },
              },
            },
            { needCheck: false },
          );
          assert.ok(reader);
        }
        const work =
          operation === 'quote' || operation === 'quote-token'
            ? reader!(new AbortController().signal)
            : operation === 'update' || operation === 'patch'
              ? instance.channel!.update(
                  { address: message.address, messageIds: ['report-message'] },
                  message,
                )
              : instance.channel!.send(message);
        pending = work.then(
          () => 'resolved',
          () => 'rejected',
        );
        await received;
        await instance.dispose();
        const result = await Promise.race([
          pending,
          new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 1000)),
        ]);
        assert.equal(result, 'rejected');
        assert.equal(observedTimeout, 8000);
        assert.ok(observedSignal?.aborted);
        for (let i = 0; sockets.size && i < 100; i++)
          await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(sockets.size, 0, 'stopping a channel must release pending HTTP sockets');
      } finally {
        await instance.dispose();
        defaultHttpInstance.interceptors.request.eject(fallback);
        server.closeAllConnections();
        await pending;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});
