import type {
  ChannelMessage,
  DeliveryReceipt,
  EngineEvent,
  Evidence,
  InvestigationReport,
  InvestigationRequest,
  InvestigationScope,
  JsonObject,
  JsonSchema,
  PluginManifest,
  TargetSnapshot,
  ToolDefinition,
  ToolQueryResult,
  Principal,
  MessageHandlingResult,
  OutboundMessage,
} from './contracts.js';
import { compileContract, snapshot } from './validation.js';

const text = { type: 'string', minLength: 1 } as const;
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z][A-Za-z0-9_-]*$',
} as const;
const strings = { type: 'array', items: text } as const;
const uniqueStrings = { ...strings, uniqueItems: true } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const schemaObject = { anyOf: [{ type: 'boolean' }, { type: 'object' }] } as const;

export function objectSchema(
  properties: JsonObject,
  required: readonly string[] = Object.keys(properties),
): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const address = objectSchema({ channelInstanceId: id, tenantId: text, conversationId: text });
const principal = objectSchema({
  channelInstanceId: id,
  tenantId: text,
  conversationId: text,
  senderId: text,
});
const pluginScope = objectSchema({
  instanceId: id,
  pluginId: text,
  pluginVersion: text,
  apiVersion: { const: 1 },
  resources: { type: 'object' },
});
const targetSnapshot = objectSchema(
  {
    targetId: id,
    revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    engine: pluginScope,
    tools: { type: 'array', items: pluginScope },
    knowledge: uniqueStrings,
    skills: {
      type: 'array',
      items: objectSchema({
        name: text,
        description: text,
        directory: text,
        digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      }),
    },
  },
  ['targetId', 'revision', 'engine', 'tools', 'knowledge'],
);
const scope = objectSchema({ target: targetSnapshot, principal });
const channelMessage = objectSchema(
  {
    address,
    senderId: text,
    messageId: text,
    text,
    targetId: id,
    investigationId: text,
    replyToMessageId: text,
    action: { enum: ['continue', 'cancel', 'status', 'retry-delivery'] },
  },
  ['address', 'senderId', 'messageId', 'text'],
);
const request = objectSchema({
  investigationId: text,
  turnId: text,
  scope,
  message: channelMessage,
});
const claim = objectSchema({ text, evidenceIds: uniqueStrings });
const report = objectSchema({
  investigationId: text,
  turnId: text,
  targetId: id,
  facts: { type: 'array', items: claim },
  hypotheses: { type: 'array', items: claim },
  recommendations: strings,
  missingEvidence: strings,
});
const failure = objectSchema(
  { code: text, message: text, remoteStatus: { enum: ['stopped', 'unknown'] } },
  ['code', 'message'],
);
const timeRange = objectSchema({ from: timestamp, to: timestamp }, []);
const resultProperties = {
  status: { enum: ['ok', 'error', 'unavailable'] },
  content: {},
  resources: { type: 'array', items: { type: 'object' } },
  truncated: { type: 'boolean' },
  failure,
  timeRange,
};
const resultRequired = ['status', 'content', 'resources', 'truncated'];
const failureConsistency = {
  if: { properties: { status: { const: 'ok' } }, required: ['status'] },
  then: { properties: { failure: false } },
  else: { properties: { failure }, required: ['failure'] },
};
const queryResult = {
  ...(objectSchema(resultProperties, resultRequired) as JsonObject),
  ...failureConsistency,
};
const evidence = {
  ...(objectSchema(
    {
      ...resultProperties,
      id: text,
      investigationId: text,
      turnId: text,
      targetId: id,
      providerInstanceId: id,
      toolName: text,
      parameters: { type: 'object' },
      observedAt: timestamp,
    },
    [
      ...resultRequired,
      'id',
      'investigationId',
      'turnId',
      'targetId',
      'providerInstanceId',
      'toolName',
      'parameters',
      'observedAt',
    ],
  ) as JsonObject),
  ...failureConsistency,
};

const modelUsage = objectSchema({
  inputTokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  outputTokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  complete: { type: 'boolean' },
});

export const schemas = snapshot({
  modelUsage,
  principal,
  channelMessage,
  targetSnapshot,
  investigationScope: scope,
  investigationRequest: request,
  report,
  evidence,
  toolQueryResult: queryResult,
  engineEvent: {
    oneOf: [
      objectSchema({ type: { const: 'progress' }, message: text }),
      objectSchema({ type: { const: 'usage' }, usage: modelUsage }),
      objectSchema({ type: { const: 'report' }, report }),
    ],
  },
  deliveryReceipt: objectSchema({ address, messageIds: { ...uniqueStrings, minItems: 1 } }),
  messageHandlingResult: {
    oneOf: [
      objectSchema({ status: { const: 'accepted' }, investigationId: text, turnId: text }),
      objectSchema({ status: { const: 'rejected' }, reason: text }),
    ],
  },
  outboundMessage: objectSchema(
    {
      address,
      replyToMessageId: text,
      reference: objectSchema({ investigationId: text, turnId: text }),
      text,
      payload: { type: 'object' },
      idempotencyKey: text,
    },
    ['address', 'text', 'idempotencyKey'],
  ),
  pluginManifest: objectSchema(
    {
      id,
      version: text,
      apiVersion: { const: 1 },
      capabilities: {
        type: 'array',
        minItems: 1,
        uniqueItems: true,
        items: { enum: ['engine', 'tools', 'channel'] },
      },
      configSchema: schemaObject,
      knowledge: uniqueStrings,
    },
    ['id', 'version', 'apiVersion', 'capabilities', 'configSchema'],
  ),
  toolDefinition: objectSchema({
    name: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.-]+$' },
    description: text,
    inputSchema: schemaObject,
    readOnly: { type: 'boolean' },
  }),
});

export const validators = Object.freeze({
  principal: compileContract<Principal>(schemas.principal, 'principal'),
  channelMessage: compileContract<ChannelMessage>(schemas.channelMessage, 'channel message'),
  targetSnapshot: compileContract<TargetSnapshot>(schemas.targetSnapshot, 'target snapshot'),
  investigationScope: compileContract<InvestigationScope>(
    schemas.investigationScope,
    'investigation scope',
  ),
  investigationRequest: compileContract<InvestigationRequest>(
    schemas.investigationRequest,
    'investigation request',
  ),
  report: compileContract<InvestigationReport>(schemas.report, 'investigation report'),
  evidence: compileContract<Evidence>(schemas.evidence, 'evidence'),
  engineEvent: compileContract<EngineEvent>(schemas.engineEvent, 'engine event'),
  deliveryReceipt: compileContract<DeliveryReceipt>(schemas.deliveryReceipt, 'delivery receipt'),
  messageHandlingResult: compileContract<MessageHandlingResult>(
    schemas.messageHandlingResult,
    'message handling result',
  ),
  outboundMessage: compileContract<OutboundMessage>(schemas.outboundMessage, 'outbound message'),
  pluginManifest: compileContract<PluginManifest>(schemas.pluginManifest, 'plugin manifest'),
  toolDefinition: compileContract<ToolDefinition>(schemas.toolDefinition, 'tool definition'),
  toolQueryResult: compileContract<ToolQueryResult>(schemas.toolQueryResult, 'tool query result'),
});
