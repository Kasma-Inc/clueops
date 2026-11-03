import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ContractError,
  compileContract,
  definePlugin,
  snapshot,
  validators,
} from '../src/plugin-api/index.js';

const address = { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' };

test('message contract rejects missing identities, wrong types and undeclared fields', () => {
  const message = { address, senderId: 'user', messageId: 'message', text: 'failure log' };
  assert.equal(validators.channelMessage.accepts(message), true);
  assert.equal(
    validators.channelMessage.accepts({ ...message, address: { ...address, tenantId: '' } }),
    false,
  );
  assert.equal(validators.channelMessage.accepts({ ...message, text: 4 }), false);
  assert.equal(validators.channelMessage.accepts({ ...message, credentials: 'secret' }), false);
  assert.throws(() => validators.channelMessage.parse({ ...message, text: null }), ContractError);
});

test('report and evidence contracts preserve explicit facts, missing evidence and failure states', () => {
  const report = {
    investigationId: 'incident',
    turnId: 'turn',
    targetId: 'a',
    facts: [{ text: 'Observed failure', evidenceIds: ['e1'] }],
    hypotheses: [],
    recommendations: [],
    missingEvidence: ['Previous log expired'],
  };
  assert.equal(validators.report.accepts(report), true);
  assert.equal(
    validators.report.accepts({ ...report, facts: [{ text: 'No evidence identifiers' }] }),
    false,
  );
  assert.equal(validators.engineEvent.accepts({ type: 'report', report }), true);
  assert.equal(validators.engineEvent.accepts({ type: 'sdk-vendor-event', report }), false);
  const evidence = {
    id: 'e1',
    investigationId: 'incident',
    turnId: 'turn',
    targetId: 'a',
    providerInstanceId: 'source',
    toolName: 'read',
    parameters: {},
    resources: [],
    observedAt: '2026-11-01T00:00:00Z',
    status: 'error',
    content: null,
    truncated: false,
  };
  assert.equal(validators.evidence.accepts(evidence), false);
  assert.equal(
    validators.evidence.accepts({
      ...evidence,
      failure: { code: 'UNAVAILABLE', message: 'Source unavailable' },
    }),
    true,
  );
  assert.equal(validators.evidence.accepts({ ...evidence, status: 'ok' }), true);
  assert.equal(
    validators.evidence.accepts({ ...evidence, status: 'ok', observedAt: 'not-a-date' }),
    false,
  );
});

test('contract parsing produces independent immutable data without freezing the caller', () => {
  const message = { address: { ...address }, senderId: 'user', messageId: 'message', text: 'log' };
  const parsed = validators.channelMessage.parse(message);
  message.address.conversationId = 'other';
  assert.equal(parsed.address.conversationId, 'room');
  assert.equal(Object.isFrozen(parsed.address), true);
  assert.equal(Object.isFrozen(message.address), false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    cycle,
    { value: undefined },
    { value: NaN },
    { value: BigInt(1) },
    new Date(),
  ]) {
    assert.throws(() => snapshot(value), ContractError);
  }
});

test('schemas are synchronous, strictly checked, non-coercing and isolated by schema id', () => {
  const one = compileContract({ $id: 'urn:test:same', type: 'string' }, 'one');
  const two = compileContract({ $id: 'urn:test:same', type: 'integer' }, 'two');
  assert.equal(one.accepts('3'), true);
  assert.equal(two.accepts('3'), false);
  assert.equal(two.accepts(3), true);
  assert.throws(() => compileContract({ type: 'string', typo: true }, 'invalid'));
  assert.throws(() => compileContract({ $async: true, type: 'string' }, 'async'));
  const invalid = { password: 'DO_NOT_PRINT_THIS' };
  assert.throws(
    () => one.parse(invalid),
    (error) => error instanceof ContractError && !String(error).includes(invalid.password),
  );
});

test('terminal refusals and target prompts require no fabricated investigation or retry', () => {
  assert.equal(
    validators.messageHandlingResult.accepts({ status: 'rejected', reason: 'TARGET_REQUIRED' }),
    true,
  );
  assert.equal(validators.messageHandlingResult.accepts({ status: 'accepted' }), false);
  assert.equal(
    validators.messageHandlingResult.accepts({
      status: 'accepted',
      investigationId: 'i',
      turnId: 't',
    }),
    true,
  );
  const reply = {
    address,
    text: 'Please resend with a target and the original log',
    idempotencyKey: 'message-refusal',
  };
  assert.equal(validators.outboundMessage.accepts(reply), true);
  assert.equal(validators.outboundMessage.accepts({ ...reply, replyToMessageId: 'request' }), true);
  assert.equal(validators.outboundMessage.accepts({ ...reply, replyToMessageId: '' }), false);
  assert.equal(validators.outboundMessage.accepts({ ...reply, replyToMessageId: 1 }), false);
  assert.equal(
    validators.outboundMessage.accepts({ ...reply, reference: { investigationId: 'i' } }),
    false,
  );
});

test('TypeScript plugin configuration can use an ordinary interface', async () => {
  interface Config {
    resourceId: string;
    credential: string;
  }
  const plugin = definePlugin<Config>({
    manifest: {
      id: 'typed-source',
      version: '1',
      apiVersion: 1,
      capabilities: ['tools'],
      configSchema: {
        type: 'object',
        required: ['resourceId', 'credential'],
        properties: { resourceId: { type: 'string' }, credential: { type: 'string' } },
      },
    },
    async create(config) {
      return {
        scope: { resourceId: config.resourceId },
        tools: {
          definitions: [],
          async bind() {
            return {
              status: 'unavailable',
              failure: { code: 'SYNTHETIC', message: 'Typed contract fixture' },
            };
          },
        },
        async dispose() {},
      };
    },
  });
  const instance = await plugin.create(
    { resourceId: 'a', credential: 'PRIVATE' },
    { instanceId: 'source', configFile: '/synthetic.yaml', resolvePath: (value) => value },
  );
  assert.deepEqual(instance.scope, { resourceId: 'a' });
  await instance.dispose();
});
