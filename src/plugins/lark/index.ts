import {
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  defaultHttpInstance,
} from '@larksuiteoapi/node-sdk';
import type { EventHandles, HttpInstance } from '@larksuiteoapi/node-sdk';
import { definePlugin, validators } from '../../plugin-api/index.js';
import type {
  ChannelMessage,
  MessageHandler,
  MessageContextReader,
  OutboundMessage,
} from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';
import { withDeadline } from '../../core/lifecycle.js';
import { fingerprint } from '../../core/identity.js';
import { credential, credentialSchema, object, privateRedactor, text } from '../shared.js';
import { renderLarkReply } from './cards.js';

export type LarkMessageEvent = Parameters<NonNullable<EventHandles['im.message.receive_v1']>>[0];

interface BotInfoResponse {
  code: number;
  bot?: { open_id: string };
}

interface Identity {
  appId: string;
  tenantId?: string;
  botOpenId: string;
  instanceId: string;
}
interface Config {
  appId: string;
  appSecret?: string;
  appSecretFile?: string;
  tenantId?: string;
  botOpenId?: string;
}
const quiet = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

export function normalizeLarkEvent(
  event: LarkMessageEvent,
  identity: Identity,
): ChannelMessage | undefined {
  if (
    event.app_id !== identity.appId ||
    typeof event.tenant_key !== 'string' ||
    !event.tenant_key.length ||
    (identity.tenantId !== undefined && event.tenant_key !== identity.tenantId) ||
    !['user', 'bot'].includes(event.sender.sender_type) ||
    (event.sender.tenant_key !== undefined && event.sender.tenant_key !== event.tenant_key) ||
    !event.sender.sender_id?.open_id ||
    event.sender.sender_id.open_id === identity.botOpenId
  )
    return;
  const message = event.message;
  if (
    message.chat_type !== 'group' ||
    !['text', 'post', 'interactive'].includes(message.message_type) ||
    Buffer.byteLength(message.content) > 131072
  )
    return;
  const addressed = (message.mentions ?? []).filter(
    (mention) => mention.id.open_id === identity.botOpenId,
  );
  if (!addressed.length && (event.sender.sender_type === 'bot' || !message.parent_id)) return;
  // Read explicit commands only; the model always receives the original content.
  let command: RegExpExecArray | null = null;
  if (message.message_type === 'text' || message.message_type === 'post') {
    try {
      const content: unknown = JSON.parse(message.content);
      let input = '';
      if (object(content) && message.message_type === 'text') {
        if (typeof content.text === 'string') input = content.text;
      } else if (object(content)) {
        const post = Array.isArray(content.content)
          ? content
          : Object.values(content).find((value) => object(value) && Array.isArray(value.content));
        if (object(post) && Array.isArray(post.content))
          input = [
            typeof post.title === 'string' ? post.title : '',
            ...post.content.map((row) =>
              Array.isArray(row)
                ? row
                    .filter(object)
                    .filter((item) => ['text', 'a', 'md', 'code_block'].includes(String(item.tag)))
                    .map((item) => (typeof item.text === 'string' ? item.text : ''))
                    .join('')
                : '',
            ),
          ].join('\n');
      }
      for (const mention of addressed) input = input.replaceAll(mention.key, '');
      command =
        /^\/(target|event|continue|cancel|status|retry-delivery)\s+([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(
          input.trim(),
        );
    } catch {
      // Unrecognized content still passes through unchanged as model input.
    }
  }
  let fields: Partial<Pick<ChannelMessage, 'targetId' | 'investigationId' | 'action'>> = {};
  if (command) {
    const name = command[1];
    if (name === 'target') fields = { targetId: command[2]! };
    else if (name === 'event') fields = { investigationId: command[2]! };
    else if (
      name === 'continue' ||
      name === 'cancel' ||
      name === 'status' ||
      name === 'retry-delivery'
    )
      fields = { investigationId: command[2]!, action: name };
    if (!command[3]?.trim() && !fields.action && (!message.parent_id || !addressed.length)) return;
  }
  try {
    return validators.channelMessage.parse({
      address: {
        channelInstanceId: identity.instanceId,
        tenantId: event.tenant_key,
        conversationId: message.chat_id,
      },
      senderId: event.sender.sender_id.open_id,
      messageId: message.message_id,
      text: message.content,
      ...(typeof message.parent_id === 'string' && message.parent_id
        ? { replyToMessageId: message.parent_id }
        : {}),
      ...fields,
    });
  } catch {
    return;
  }
}

export function createLarkDispatcher(
  identity: Identity,
  handler: MessageHandler,
  signal: AbortSignal,
  readContext?: (message: ChannelMessage, signal: AbortSignal) => ReturnType<MessageContextReader>,
): EventDispatcher {
  return new EventDispatcher({ logger: quiet, loggerLevel: LoggerLevel.error }).register({
    'im.message.receive_v1': async (event) => {
      signal.throwIfAborted();
      const message = normalizeLarkEvent(event, identity);
      if (!message) return;
      // Let persistence errors reject: WSClient sends a non-200 ACK and the platform may redeliver.
      const explicitlyAddressed =
        event.message.mentions?.some((mention) => mention.id.open_id === identity.botOpenId) ??
        false;
      await handler(
        message,
        !explicitlyAddressed
          ? { linkedReplyOnly: true }
          : readContext && message.replyToMessageId
            ? { readContext: (contextSignal) => readContext(message, contextSignal) }
            : undefined,
      );
    },
  });
}

export default definePlugin<Config>({
  manifest: {
    id: 'lark',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['channel'],
    configSchema: credentialSchema(
      {
        appId: { ...text, pattern: '^cli_[0-9a-fA-F]{16}$' },
        appSecretFile: text,
        appSecret: text,
        tenantId: text,
        botOpenId: text,
      },
      ['appId'],
      'appSecret',
      'appSecretFile',
    ),
  },
  async create(config, context) {
    const secret = await credential(config.appSecret, config.appSecretFile, context);
    privateRedactor([secret], context);
    const clientOptions = {
      appId: config.appId,
      appSecret: secret,
      domain: Domain.Lark,
      logger: quiet,
      loggerLevel: LoggerLevel.error,
    };
    let abort = new AbortController();
    // Transport defaults also cover the SDK's token pre-requests.
    const http = defaultHttpInstance.create({ signal: abort.signal, timeout: 8000 });
    http.interceptors.response.use((response) => response.data);
    const client = new Client({ ...clientOptions, httpInstance: http as HttpInstance });
    let ws: WSClient | undefined;
    let starting = false;
    let currentBotOpenId = config.botOpenId;
    const check = (message: OutboundMessage) => {
      if (
        message.address.channelInstanceId !== context.instanceId ||
        (config.tenantId !== undefined && message.address.tenantId !== config.tenantId)
      )
        throw new HostError('OUTBOUND_SOURCE_MISMATCH');
    };
    const stop = async () => {
      abort.abort();
      ws?.close({ force: true });
      ws = undefined;
    };
    return {
      scope: {
        appId: config.appId,
        ...(config.tenantId !== undefined ? { tenantId: config.tenantId } : {}),
        ...(config.botOpenId !== undefined ? { botOpenId: config.botOpenId } : {}),
        domain: 'lark',
      },
      channel: {
        describe: () => (currentBotOpenId === undefined ? {} : { botOpenId: currentBotOpenId }),
        async start(handler, parent) {
          if (ws || starting) throw new HostError('CHANNEL_ALREADY_STARTED');
          parent.throwIfAborted();
          starting = true;
          abort = new AbortController();
          const signal = AbortSignal.any([parent, abort.signal]);
          http.defaults.signal = signal;
          try {
            let botOpenId = config.botOpenId;
            if (botOpenId === undefined) {
              try {
                const response = await withDeadline(
                  client.request<BotInfoResponse>({
                    method: 'GET',
                    url: '/open-apis/bot/v3/info',
                    signal,
                    timeout: 8000,
                  }),
                  8000,
                  signal,
                );
                signal.throwIfAborted();
                if (
                  response?.code !== 0 ||
                  typeof response.bot?.open_id !== 'string' ||
                  !response.bot.open_id.length
                )
                  throw new HostError('LARK_BOT_IDENTITY_FAILED');
                botOpenId = response.bot.open_id;
              } catch {
                throw new HostError(
                  signal.aborted ? 'LARK_START_ABORTED' : 'LARK_BOT_IDENTITY_FAILED',
                );
              }
            }
            signal.throwIfAborted();
            const identity: Identity = {
              appId: config.appId,
              botOpenId,
              instanceId: context.instanceId,
              ...(config.tenantId !== undefined ? { tenantId: config.tenantId } : {}),
            };
            currentBotOpenId = botOpenId;
            const readContext = async (message: ChannelMessage, contextSignal: AbortSignal) => {
              const lookupSignal = AbortSignal.any([
                signal,
                contextSignal,
                AbortSignal.timeout(8000),
              ]);
              const lookupHttp = defaultHttpInstance.create({
                signal: lookupSignal,
                timeout: 8000,
              });
              lookupHttp.interceptors.response.use((response) => response.data);
              const lookup = new Client({
                ...clientOptions,
                httpInstance: lookupHttp as HttpInstance,
              });
              let response;
              try {
                response = await withDeadline(
                  lookup.im.message.get({
                    path: { message_id: message.replyToMessageId! },
                    params: { card_msg_content_type: 'user_card_content' },
                  }),
                  8000,
                  lookupSignal,
                );
              } catch {
                throw new HostError('QUOTED_MESSAGE_UNAVAILABLE');
              }
              lookupSignal.throwIfAborted();
              const item = response.data?.items?.[0];
              if (
                response.code !== 0 ||
                response.data?.items?.length !== 1 ||
                !item ||
                typeof item.message_id !== 'string' ||
                item.message_id !== message.replyToMessageId ||
                item.chat_id !== message.address.conversationId ||
                item.deleted ||
                !item.body?.content
              )
                throw new HostError('QUOTED_MESSAGE_UNAVAILABLE');
              if (!['text', 'post', 'interactive'].includes(item.msg_type ?? ''))
                throw new HostError('QUOTED_MESSAGE_UNSUPPORTED');
              if (Buffer.byteLength(item.body.content) > 131072)
                throw new HostError('QUOTED_MESSAGE_TOO_LARGE');
              return { messageId: item.message_id, text: item.body.content };
            };
            const ready = new Promise<void>((resolve, reject) => {
              ws = new WSClient({
                appId: config.appId,
                appSecret: secret,
                domain: Domain.Lark,
                logger: quiet,
                loggerLevel: LoggerLevel.error,
                autoReconnect: true,
                handshakeTimeoutMs: 8000,
                onReady() {
                  if (signal.aborted) {
                    ws?.close({ force: true });
                    reject(new HostError('LARK_START_ABORTED'));
                  } else resolve();
                },
                onError() {
                  reject(new HostError('LARK_CONNECTION_FAILED'));
                },
              });
              signal.addEventListener(
                'abort',
                () => {
                  ws?.close({ force: true });
                  reject(new HostError('LARK_START_ABORTED'));
                },
                { once: true },
              );
            });
            await Promise.all([
              ws!.start({
                eventDispatcher: createLarkDispatcher(identity, handler, signal, readContext),
              }),
              ready,
            ]);
          } catch (error) {
            await stop();
            throw error;
          } finally {
            starting = false;
          }
        },
        stop,
        renderReply: renderLarkReply,
        async send(message) {
          check(message);
          const data = {
            msg_type: message.payload ? 'interactive' : 'text',
            content: JSON.stringify(message.payload ?? { text: message.text }),
            uuid: fingerprint(message.idempotencyKey).slice(0, 48),
          };
          const response = message.replyToMessageId
            ? await client.im.message.reply({
                path: { message_id: message.replyToMessageId },
                data: { ...data, reply_in_thread: false },
              })
            : await client.im.message.create({
                params: { receive_id_type: 'chat_id' },
                data: { ...data, receive_id: message.address.conversationId },
              });
          if (response.code !== 0 || !response.data?.message_id)
            throw new HostError('LARK_SEND_RECEIPT_UNKNOWN');
          return { address: message.address, messageIds: [response.data.message_id] };
        },
        async update(receipt, message) {
          check(message);
          if (
            fingerprint(receipt.address) !== fingerprint(message.address) ||
            receipt.messageIds.length !== 1
          )
            throw new HostError('LARK_RECEIPT_INVALID');
          const path = { message_id: receipt.messageIds[0]! };
          const response = message.payload
            ? await client.im.message.patch({
                path,
                data: { content: JSON.stringify(message.payload) },
              })
            : await client.im.message.update({
                path,
                data: { msg_type: 'text', content: JSON.stringify({ text: message.text }) },
              });
          if (response.code !== 0) throw new HostError('LARK_UPDATE_FAILED');
          return receipt;
        },
      },
      dispose: stop,
    };
  },
});
