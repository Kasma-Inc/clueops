import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { definePlugin, validators } from '../../plugin-api/index.js';
import type {
  DeliveryReceipt,
  ChannelReadAccess,
  MessageChannel,
  MessageHandler,
  OutboundMessage,
  PluginContext,
} from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';
import { fingerprint } from '../../core/identity.js';
import { credential, credentialSchema, object, privateRedactor, text } from '../shared.js';
import { RestMailbox } from './mailbox.js';

interface Config {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  readonly tokenFile?: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly senderId: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest();
const reply = (response: ServerResponse, status: number, value: unknown): void => {
  if (response.destroyed) return;
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
};

export class RestChannel implements MessageChannel {
  #server: Server | undefined;
  #abort: AbortController | undefined;
  #starting: Promise<void> | undefined;
  #mailbox: RestMailbox | undefined;
  #readAccess: ChannelReadAccess | undefined;
  readonly #token: Buffer;
  readonly #address;
  constructor(
    readonly config: Config,
    readonly context: PluginContext,
    token: string,
  ) {
    this.#token = digest('Bearer ' + token);
    this.#address = {
      channelInstanceId: context.instanceId,
      tenantId: config.tenantId,
      conversationId: config.conversationId,
    };
  }
  get address(): AddressInfo | undefined {
    const value = this.#server?.address();
    return value && typeof value !== 'string' ? value : undefined;
  }
  private check(message: OutboundMessage): void {
    if (fingerprint(message.address) !== fingerprint(this.#address))
      throw new HostError('OUTBOUND_SOURCE_MISMATCH');
  }
  async start(
    handler: MessageHandler,
    parent: AbortSignal,
    readAccess?: ChannelReadAccess,
  ): Promise<void> {
    parent.throwIfAborted();
    if (this.#starting || this.#server) throw new HostError('CHANNEL_ALREADY_STARTED');
    this.#readAccess = readAccess;
    const abort = new AbortController();
    this.#abort = abort;
    const signal = AbortSignal.any([parent, abort.signal]);
    const start = async () => {
      this.#mailbox = await RestMailbox.open(
        path.join(
          this.context.stateDirectory ?? this.context.resolvePath('.clueops/rest'),
          'mailbox',
        ),
        (message) => this.check(message),
      );
      signal.throwIfAborted();
      const server = createServer(
        {
          maxHeaderSize: 8192,
          requestTimeout: 15000,
          headersTimeout: 10000,
          keepAliveTimeout: 1000,
        },
        (request, response) => {
          void this.receive(request, response, handler).catch(() =>
            reply(response, 503, { error: 'REST_UNAVAILABLE' }),
          );
        },
      );
      this.#server = server;
      server.maxConnections = 64;
      const stop = () => {
        server.close();
        server.closeAllConnections();
      };
      signal.addEventListener('abort', stop, { once: true });
      server.once('close', () => signal.removeEventListener('abort', stop));
      try {
        await new Promise<void>((resolve, reject) => {
          const cancelled = () => reject(signal.reason);
          signal.addEventListener('abort', cancelled, { once: true });
          server.once('close', () => signal.removeEventListener('abort', cancelled));
          server.once('error', reject);
          server.listen(
            { host: this.config.host ?? '127.0.0.1', port: this.config.port ?? 8080 },
            () => {
              server.removeListener('error', reject);
              signal.removeEventListener('abort', cancelled);
              resolve();
            },
          );
        });
        signal.throwIfAborted();
      } catch (error) {
        stop();
        throw error;
      }
    };
    this.#starting = start();
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }
  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#starting?.catch(() => {});
    const server = this.#server;
    this.#server = undefined;
    if (server?.listening)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    await this.#mailbox?.idle();
  }
  async send(raw: OutboundMessage): Promise<DeliveryReceipt> {
    const message = validators.outboundMessage.parse(raw);
    this.check(message);
    if (!this.#mailbox) throw new HostError('REST_NOT_STARTED');
    const id = await this.#mailbox.append(message);
    return { address: this.#address, messageIds: [id] };
  }
  async update(raw: DeliveryReceipt, message: OutboundMessage): Promise<DeliveryReceipt> {
    const receipt = validators.deliveryReceipt.parse(raw);
    this.check({ ...message, address: receipt.address });
    if (!receipt.messageIds.length || !receipt.messageIds.every((id) => this.#mailbox?.has(id)))
      throw new HostError('REST_RECEIPT_UNKNOWN');
    return this.send({
      ...message,
      idempotencyKey: fingerprint(['rest-update', receipt.messageIds, message]),
    });
  }
  private async receive(
    request: IncomingMessage,
    response: ServerResponse,
    handler: MessageHandler,
  ) {
    if (!timingSafeEqual(digest(request.headers.authorization ?? ''), this.#token)) {
      response.setHeader('Connection', 'close');
      response.setHeader('WWW-Authenticate', 'Bearer');
      reply(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/messages') return reply(response, 404, { error: 'NOT_FOUND' });
    if (request.method === 'GET') {
      if (
        [...url.searchParams.keys()].some(
          (key) =>
            !['investigationId', 'after', 'limit'].includes(key) ||
            url.searchParams.getAll(key).length !== 1,
        )
      )
        return reply(response, 400, { error: 'INVALID_QUERY' });
      const investigationId = url.searchParams.get('investigationId');
      if (!investigationId || !/^[A-Za-z0-9_-]{1,128}$/.test(investigationId))
        return reply(response, 400, { error: 'INVESTIGATION_REQUIRED' });
      const after = url.searchParams.get('after') ?? '0';
      const limit = url.searchParams.get('limit') ?? '20';
      if (
        !/^\d+$/.test(after) ||
        !/^\d+$/.test(limit) ||
        !Number.isSafeInteger(+after) ||
        +limit < 1 ||
        +limit > 100
      )
        return reply(response, 400, { error: 'INVALID_QUERY' });
      try {
        if (!this.#readAccess) throw new HostError('ACCESS_DENIED');
        this.#readAccess.authorizeInvestigation(
          { ...this.#address, senderId: this.config.senderId },
          investigationId,
        );
      } catch {
        return reply(response, 403, { error: 'ACCESS_DENIED' });
      }
      return reply(response, 200, await this.#mailbox!.page(investigationId, +after, +limit));
    }
    if (request.method !== 'POST') return reply(response, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (url.search) return reply(response, 400, { error: 'INVALID_QUERY' });
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
      return reply(response, 415, { error: 'JSON_REQUIRED' });
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const part of request.iterator({ destroyOnReturn: false })) {
      bytes += part.length;
      if (bytes > 65536) {
        response.setHeader('Connection', 'close');
        return reply(response, 413, { error: 'INPUT_TOO_LARGE' });
      }
      parts.push(part as Buffer);
    }
    let message;
    try {
      const body: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
      );
      if (!object(body) || Object.hasOwn(body, 'address') || Object.hasOwn(body, 'senderId'))
        throw new Error();
      message = validators.channelMessage.parse({
        ...body,
        address: this.#address,
        senderId: this.config.senderId,
      });
    } catch {
      return reply(response, 400, { error: 'INVALID_MESSAGE' });
    }
    const result = validators.messageHandlingResult.parse(await handler(message));
    reply(response, result.status === 'accepted' ? 202 : 422, result);
  }
}

export default definePlugin<Config>({
  manifest: {
    id: 'rest',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['channel'],
    configSchema: credentialSchema(
      {
        host: { enum: ['127.0.0.1', '0.0.0.0', '::1', '::'] },
        port: { type: 'integer', minimum: 0, maximum: 65535 },
        token: text,
        tokenFile: text,
        tenantId: text,
        conversationId: text,
        senderId: text,
      },
      ['tenantId', 'conversationId', 'senderId'],
      'token',
      'tokenFile',
    ),
  },
  async create(config, context) {
    const token = await credential(config.token, config.tokenFile, context);
    if (!/^[\x21-\x7e]{16,512}$/.test(token)) throw new HostError('REST_TOKEN_INVALID');
    privateRedactor([token], context);
    const channel = new RestChannel(config, context, token);
    return {
      scope: {
        tenantId: config.tenantId,
        conversationId: config.conversationId,
        senderId: config.senderId,
      },
      channel,
      dispose: () => channel.stop(),
    };
  },
});
