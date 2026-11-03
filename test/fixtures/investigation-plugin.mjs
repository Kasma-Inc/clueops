import { appendFile } from 'node:fs/promises';
export const measurements = {
  activeBindings: 0,
  peakBindings: 0,
  bindings: 0,
  queries: 0,
  runs: 0,
  sends: 0,
  targetActive: {},
  targetPeak: {},
};
export default {
  manifest: {
    id: 'investigation-fixture',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['engine', 'tools', 'channel'],
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceId', 'credential'],
      properties: {
        resourceId: { type: 'string' },
        credential: { type: 'string' },
        eventsFile: { type: 'string' },
        delayMs: { type: 'integer' },
        unavailable: { type: 'boolean' },
        invalidReports: { type: 'integer' },
        failSends: { type: 'integer' },
        resultBytes: { type: 'integer' },
        nativeTools: { type: 'boolean' },
        recordUsage: { type: 'boolean' },
      },
    },
  },
  async create(config, context) {
    context.registerSecrets?.([config.credential]);
    const record = async (action, detail = {}) => {
      if (config.eventsFile)
        await appendFile(
          context.resolvePath(config.eventsFile),
          JSON.stringify({ instanceId: context.instanceId, action, at: Date.now(), ...detail }) +
            '\n',
        );
    };
    const definition = {
      name: 'read',
      description: 'Read synthetic same-name resource',
      readOnly: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    };
    const sent = new Map();
    function session(options, previous) {
      const handle = previous ?? {
        targetId: options.scope.target.targetId,
        revision: options.scope.target.revision,
      };
      if (
        handle.targetId !== options.scope.target.targetId ||
        handle.revision !== options.scope.target.revision
      )
        throw new Error('WRONG_HANDLE');
      let runs = 0;
      return {
        handle,
        async *runTurn(request, signal) {
          measurements.runs++;
          runs++;
          if (config.recordUsage) handle.usagePending = true;
          await record('run', {
            historyFirstText: options.history?.inputs[0]?.text ?? null,
            unavailableContext:
              options.history?.evidence
                .filter((e) => e.status === 'unavailable')
                .map((e) => e.providerInstanceId) ?? [],
            targetId: handle.targetId,
            eventId: request.investigationId,
            turnId: request.turnId,
          });
          const evidence = await Promise.all(options.tools.map((t) => t.call({}, signal)));
          if (config.nativeTools)
            evidence.push(
              await options.recordEvidence(
                {
                  toolName: 'command_execution',
                  parameters: { command: 'synthetic-native-read' },
                  result: {
                    status: 'ok',
                    content: 'native evidence',
                    resources: [],
                    truncated: false,
                  },
                },
                signal,
              ),
            );
          signal.throwIfAborted();
          if (config.recordUsage) {
            handle.usagePending = false;
            yield {
              type: 'usage',
              usage: { inputTokens: runs * 100, outputTokens: runs * 10, complete: true },
            };
          }
          const invalid = runs <= (config.invalidReports ?? 0);
          yield {
            type: 'report',
            report: {
              investigationId: request.investigationId,
              turnId: request.turnId,
              targetId: handle.targetId,
              facts: evidence
                .filter((e) => e.status === 'ok')
                .map((e) => ({
                  text: '查询返回 ' + e.providerInstanceId,
                  evidenceIds: [invalid ? 'FABRICATED_EVIDENCE' : e.id],
                })),
              hypotheses: [],
              recommendations: [],
              missingEvidence: [],
            },
          };
        },
        async close() {},
      };
    }
    return {
      scope: { resourceId: config.resourceId },
      engine: {
        supportsNativeTools: config.nativeTools === true,
        async createSession(options) {
          return session(options);
        },
        async resumeSession(handle, options) {
          return session(options, handle);
        },
      },
      tools: {
        definitions: [definition],
        async bind(bindingContext) {
          if (config.unavailable)
            return {
              status: 'unavailable',
              failure: { code: 'OFFLINE', message: 'unavailable source' },
            };
          measurements.bindings++;
          measurements.activeBindings++;
          measurements.peakBindings = Math.max(
            measurements.peakBindings,
            measurements.activeBindings,
          );
          let closed = false;
          const target = bindingContext.targetId;
          measurements.targetActive[target] = (measurements.targetActive[target] ?? 0) + 1;
          measurements.targetPeak[target] = Math.max(
            measurements.targetPeak[target] ?? 0,
            measurements.targetActive[target],
          );
          return {
            status: 'ready',
            binding: {
              async call() {
                measurements.queries++;
                await record('query', {
                  targetId: bindingContext.targetId,
                  eventId: bindingContext.investigationId,
                  turnId: bindingContext.turnId,
                });
                await new Promise((resolve) => setTimeout(resolve, config.delayMs ?? 5));
                return {
                  status: 'ok',
                  content: {
                    marker: config.resourceId,
                    sameName: 'web',
                    payload: 'x'.repeat(config.resultBytes ?? 16),
                  },
                  resources: [{ resourceId: config.resourceId }],
                  truncated: false,
                };
              },
              async close() {
                if (!closed) {
                  measurements.activeBindings--;
                  measurements.targetActive[target]--;
                }
                closed = true;
              },
            },
          };
        },
      },
      channel: {
        async start() {},
        async stop() {},
        async send(message) {
          measurements.sends++;
          const n = (sent.get(message.idempotencyKey) ?? 0) + 1;
          sent.set(message.idempotencyKey, n);
          await record('send', {
            eventId: message.reference?.investigationId ?? '',
            key: message.idempotencyKey,
          });
          if (n <= (config.failSends ?? 0)) throw new Error('RECEIPT_UNKNOWN');
          return { address: message.address, messageIds: [message.idempotencyKey] };
        },
        async update(receipt) {
          return receipt;
        },
      },
      async dispose() {},
    };
  },
};
