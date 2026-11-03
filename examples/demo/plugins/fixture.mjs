import { appendFile } from 'node:fs/promises';

// Offline demo and configuration/contract test fixture. It never contacts production.
export default {
  manifest: {
    id: 'synthetic-fixture',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['engine', 'tools', 'channel'],
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['resourceId', 'credential'],
      properties: {
        resourceId: { type: 'string', minLength: 1 },
        credential: { type: 'string', minLength: 1 },
        namespaces: { type: 'array', uniqueItems: true, items: { type: 'string' } },
        eventsFile: { type: 'string' },
        failCreate: { type: 'boolean' },
        failStart: { type: 'boolean' },
        failDispose: { type: 'boolean' },
        duplicateTools: { type: 'boolean' },
      },
    },
  },
  async create(config, context) {
    const record = async (action) => {
      if (config.eventsFile)
        await appendFile(
          context.resolvePath(config.eventsFile),
          context.instanceId + ':' + action + '\n',
        );
    };
    await record('create');
    if (config.failCreate) throw new Error(config.credential);
    const definition = {
      name: 'read_evidence',
      description: 'Read synthetic evidence',
      readOnly: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    };
    let sent = 0;
    const session = (handle) => ({
      handle,
      async *runTurn(request, signal) {
        signal.throwIfAborted();
        yield {
          type: 'report',
          report: {
            investigationId: request.investigationId,
            turnId: request.turnId,
            targetId: request.scope.target.targetId,
            facts: [],
            hypotheses: [],
            recommendations: [],
            missingEvidence: ['Synthetic fixture; no real investigation performed.'],
          },
        };
      },
      async close() {
        await record('session-close');
      },
    });
    return {
      scope: { resourceId: config.resourceId, namespaces: config.namespaces ?? [] },
      engine: {
        async createSession(options) {
          return session({ targetId: options.scope.target.targetId });
        },
        async resumeSession(handle) {
          return session(handle);
        },
      },
      tools: {
        definitions: config.duplicateTools ? [definition, definition] : [definition],
        async bind(bindingContext) {
          bindingContext.signal.throwIfAborted();
          return {
            status: 'ready',
            binding: {
              async call(name, arguments_, signal) {
                signal.throwIfAborted();
                if (name !== 'read_evidence' || Object.keys(arguments_).length) {
                  return {
                    status: 'error',
                    content: null,
                    resources: [],
                    truncated: false,
                    failure: { code: 'OUT_OF_SCOPE', message: 'Synthetic query rejected' },
                  };
                }
                return {
                  status: 'ok',
                  content: { resourceId: config.resourceId },
                  resources: [{ resourceId: config.resourceId }],
                  truncated: false,
                };
              },
              async close() {
                await record('binding-close');
              },
            },
          };
        },
      },
      channel: {
        async start(_handler, signal) {
          await record('start');
          signal.throwIfAborted();
          if (config.failStart) throw new Error(config.credential);
        },
        async stop() {
          await record('stop');
        },
        async send(message) {
          return { address: message.address, messageIds: [context.instanceId + '-' + ++sent] };
        },
        async update(receipt) {
          return receipt;
        },
      },
      async dispose() {
        await record('dispose');
        if (config.failDispose) throw new Error(config.credential);
      },
    };
  },
};
