import { createHash } from 'node:crypto';
import { jsonValue } from '../plugin-api/index.js';
import type { ChannelMessage, JsonValue } from '../plugin-api/index.js';

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, JsonValue>)[key]!)}`)
    .join(',')}}`;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256')
    .update(canonical(jsonValue(value)))
    .digest('hex');
}

export function messageKey(message: ChannelMessage): string {
  const a = message.address;
  return fingerprint([a.channelInstanceId, a.tenantId, a.conversationId, message.messageId]);
}
