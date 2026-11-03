import {
  Client,
  Domain,
  EventDispatcher,
  LoggerLevel,
  WSClient,
  defaultHttpInstance,
} from '@larksuiteoapi/node-sdk';
import type { HttpInstance } from '@larksuiteoapi/node-sdk';
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

function messageText(type: string, serialized: string, strict = false): string | undefined {
  let content: unknown;
  try {
    content = JSON.parse(serialized);
  } catch {
    return;
  }
  let value = '';
  if (type === 'text') {
    if (!object(content) || typeof content.text !== 'string') return;
    value = content.text;
  } else {
    if (!object(content)) return;
    const post = Array.isArray(content.content)
      ? content
      : Object.values(content).find((v) => object(v) && Array.isArray(v.content));
    if (!object(post) || !Array.isArray(post.content)) return;
    if (strict && post.content.some((row) => !Array.isArray(row))) return;
    let unsupported = false;
    value =
      (typeof post.title === 'string' ? post.title + '\n' : '') +
      post.content
        .map((row) =>
          Array.isArray(row)
            ? row
                .map((item) => {
                  if (object(item)) {
                    if (
                      ['text', 'a', 'md', 'code_block'].includes(String(item.tag)) &&
                      typeof item.text === 'string'
                    )
                      return item.tag === 'code_block' || item.tag === 'md'
                        ? `\n${item.text}\n`
                        : item.text;
                    if (item.tag === 'at')
                      return !strict
                        ? ''
                        : typeof item.user_name === 'string'
                          ? `@${item.user_name}`
                          : '@[提及]';
                    if (item.tag === 'hr') return strict ? '\n---\n' : '';
                    if (item.tag === 'emotion' && typeof item.emoji_type === 'string')
                      return strict ? `:${item.emoji_type}:` : '';
                  }
                  unsupported = true;
                  return '';
                })
                .join('')
            : '',
        )
        .join('\n');
    if (strict && unsupported) return;
  }
  return value;
}

export function normalizeLarkEvent(raw: unknown, identity: Identity): ChannelMessage | undefined {
  if (
    !object(raw) ||
    raw.app_id !== identity.appId ||
    typeof raw.tenant_key !== 'string' ||
    !raw.tenant_key.length ||
    (identity.tenantId !== undefined && raw.tenant_key !== identity.tenantId) ||
    !object(raw.sender) ||
    raw.sender.sender_type !== 'user' ||
    (raw.sender.tenant_key !== undefined && raw.sender.tenant_key !== raw.tenant_key) ||
    !object(raw.sender.sender_id) ||
    typeof raw.sender.sender_id.open_id !== 'string' ||
    !object(raw.message)
  )
    return;
  const message = raw.message;
  if (
    message.chat_type !== 'group' ||
    !['text', 'post'].includes(String(message.message_type)) ||
    typeof message.content !== 'string' ||
    Buffer.byteLength(message.content) > 131072
  )
    return;
  const mentions = Array.isArray(message.mentions) ? message.mentions.filter(object) : [];
  const addressed = mentions.filter((m) => object(m.id) && m.id.open_id === identity.botOpenId);
  if (!addressed.length && !message.parent_id) return;
  let value = messageText(String(message.message_type), message.content);
  if (value === undefined) return;
  for (const mention of addressed)
    if (typeof mention.key === 'string') value = value.replaceAll(mention.key, '');
  value = value.trim();
  if (!value) {
    if (!message.parent_id || !addressed.length) return;
    value = '请分析引用的消息。';
  }
  const command =
    /^\/(target|event|continue|cancel|status|retry-delivery)\s+([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(
      value,
    );
  const fields: Record<string, string> = {};
  if (command) {
    fields[command[1] === 'target' ? 'targetId' : 'investigationId'] = command[2]!;
    if (!['target', 'event'].includes(command[1]!)) fields.action = command[1]!;
    value = command[3]?.trim() || (fields.action ? command[1]! : '');
    if (!value) {
      if (!message.parent_id || !addressed.length) return;
      value = '请分析引用的消息。';
    }
  }
  try {
    return validators.channelMessage.parse({
      address: {
        channelInstanceId: identity.instanceId,
        tenantId: raw.tenant_key,
        conversationId: message.chat_id,
      },
      senderId: raw.sender.sender_id.open_id,
      messageId: message.message_id,
      text: value,
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
    'im.message.receive_v1': async (raw) => {
      signal.throwIfAborted();
      const message = normalizeLarkEvent(raw, identity);
      if (!message) return;
      // Let persistence errors reject: WSClient sends a non-200 ACK and the platform may redeliver.
      const explicitlyAddressed =
        object(raw) &&
        object(raw.message) &&
        Array.isArray(raw.message.mentions) &&
        raw.message.mentions.some(
          (mention) =>
            object(mention) && object(mention.id) && mention.id.open_id === identity.botOpenId,
        );
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
    const client = new Client({ ...clientOptions, httpInstance: http as unknown as HttpInstance });
    let ws: WSClient | undefined;
    let starting = false;
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
                  client.request<unknown>({
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
                  !object(response) ||
                  response.code !== 0 ||
                  !object(response.bot) ||
                  typeof response.bot.open_id !== 'string' ||
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
                httpInstance: lookupHttp as unknown as HttpInstance,
              });
              let response;
              try {
                response = await withDeadline(
                  lookup.im.message.get({
                    path: { message_id: message.replyToMessageId! },
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
              if (!['text', 'post'].includes(item.msg_type ?? ''))
                throw new HostError('QUOTED_MESSAGE_UNSUPPORTED');
              if (Buffer.byteLength(item.body.content) > 131072)
                throw new HostError('QUOTED_MESSAGE_TOO_LARGE');
              const text = messageText(item.msg_type!, item.body.content, true);
              if (!text?.trim()) throw new HostError('QUOTED_MESSAGE_UNSUPPORTED');
              return { messageId: item.message_id, text };
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
