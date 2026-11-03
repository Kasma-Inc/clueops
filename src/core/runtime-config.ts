import type { JsonObject } from '../plugin-api/index.js';

export const runtimeDefaults = Object.freeze({
  stateDirectory: '.clueops/state',
  retentionDays: 7,
  turnTimeoutMs: 120000,
  queryTimeoutMs: 15000,
  cleanupTimeoutMs: 7000,
  messageTimeoutMs: 10000,
  maxInputBytes: 65536,
  maxResultBytes: 131072,
  maxTotalBytes: 1048576,
  maxToolCalls: 40,
  globalConcurrency: 4,
  targetConcurrency: 2,
  reportAttempts: 2,
  deliveryAttempts: 3,
  maxQueuedTurns: 64,
  maxMessageBytes: 3500,
});
export type RuntimeSettings = {
  readonly [K in keyof typeof runtimeDefaults]: (typeof runtimeDefaults)[K] extends string
    ? string
    : number;
} & { readonly maxModelTokens?: number };
export const runtimeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(
      Object.entries(runtimeDefaults).map(([key, value]) => [
        key,
        typeof value === 'string'
          ? { type: 'string', minLength: 1 }
          : {
              type: 'integer',
              minimum: key === 'maxMessageBytes' ? 256 : key === 'retentionDays' ? 0 : 1,
              maximum: key.endsWith('Bytes')
                ? 16777216
                : key.endsWith('Concurrency')
                  ? 64
                  : 3600000,
            },
      ]),
    ),
    maxModelTokens: { type: 'integer', minimum: 1, maximum: 3600000 },
  } as JsonObject,
};
