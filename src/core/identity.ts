import { createHash } from 'node:crypto';
import { jsonValue } from '../plugin-api/index.js';
import type { ChannelMessage, JsonValue } from '../plugin-api/index.js';

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
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
