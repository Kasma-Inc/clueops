import { randomUUID } from 'node:crypto';
import { compileContract, validators } from '../plugin-api/index.js';
import type {
  BoundDiagnosticTool,
  Evidence,
  InvestigationRequest,
  JsonObject,
  ToolBinding,
  EngineObservation,
  ToolProvider,
  ToolQueryResult,
} from '../plugin-api/index.js';
import { HostError } from './errors.js';
import { fingerprint } from './identity.js';
import { InvestigationStore } from './store.js';
import { Redactor } from './redaction.js';
import type { RuntimeSettings } from './runtime-config.js';
import { withDeadline } from './lifecycle.js';

export class ToolRound {
  readonly #abort = new AbortController();
  readonly #bindings: ToolBinding[] = [];
  readonly #tools: BoundDiagnosticTool[] = [];
  readonly unavailable: string[] = [];
  readonly metrics = { calls: 0, returnedBytes: 0, queryMilliseconds: 0, unavailableSources: 0 };
  #closed = false;
  #closePromise: Promise<void> | undefined;
  constructor(
    private readonly request: InvestigationRequest,
    private readonly store: InvestigationStore,
    private readonly redactor: Redactor,
    private readonly limits: RuntimeSettings,
    private readonly signal: AbortSignal,
  ) {}

  async open(providers: readonly { instanceId: string; provider: ToolProvider }[]): Promise<void> {
    const combined = AbortSignal.any([this.signal, this.#abort.signal]);
    const results = await Promise.allSettled(
      providers.map(async ({ instanceId, provider }) => {
        const acquisition = provider.bind({
          investigationId: this.request.investigationId,
          turnId: this.request.turnId,
          targetId: this.request.scope.target.targetId,
          scopeRevision: this.request.scope.target.revision,
          signal: combined,
        });
        let abandoned = false;
        void acquisition.then(
          (result) => {
            if (result.status !== 'ready') return;
            if (abandoned || this.#closed || combined.aborted)
              void withDeadline(result.binding.close(), this.limits.cleanupTimeoutMs).catch(
                () => {},
              );
            else this.#bindings.push(result.binding);
          },
          () => {},
        );
        try {
          return {
            instanceId,
            provider,
            result: await withDeadline(acquisition, this.limits.queryTimeoutMs, combined),
          };
        } catch (error) {
          abandoned = true;
          combined.throwIfAborted();
          if (error instanceof HostError && error.code === 'LIFECYCLE_TIMEOUT')
            return {
              instanceId,
              provider,
              result: {
                status: 'unavailable' as const,
                failure: { code: 'BACKEND_START_TIMEOUT', message: '数据源启动超时。' },
              },
            };
          throw error;
        }
      }),
    );
    const aliases = new Set<string>();
    try {
      combined.throwIfAborted();
      for (const result of results) {
        if (result.status === 'rejected') continue;
        const { instanceId, provider, result: binding } = result.value;
        if (binding.status === 'unavailable') {
          this.metrics.unavailableSources++;
          this.unavailable.push(instanceId);
          await this.recordResult(
            instanceId,
            'binding',
            {},
            {
              status: 'unavailable',
              content: null,
              resources: [],
              truncated: false,
              failure: binding.failure,
            },
            combined,
          );
          continue;
        }
        let terminated = false;
        const names = new Set<string>();
        for (const raw of binding.definitions ?? provider.definitions) {
          // Plugin definitions are trusted protocol, not business text. Redacting
          // schema types or tool names can break valid tools for short passwords.
          const definition = validators.toolDefinition.parse(raw);
          if (names.has(definition.name)) throw new HostError('DUPLICATE_TOOL_NAME');
          names.add(definition.name);
          const alias = 't_' + fingerprint([instanceId, definition.name]).slice(0, 24);
          if (aliases.has(alias)) throw new HostError('TOOL_ALIAS_COLLISION');
          aliases.add(alias);
          const parser = compileContract<JsonObject>(definition.inputSchema, 'tool arguments');
          this.#tools.push(
            Object.freeze({
              providerInstanceId: instanceId,
              definition: validators.toolDefinition.parse({
                ...definition,
                name: alias,
                description: this.redactor.text(
                  `[${instanceId}/${definition.name}] ${definition.description}`,
                ),
              }),
              call: async (arguments_: JsonObject, signal: AbortSignal): Promise<Evidence> => {
                if (this.#closed) throw new HostError('TURN_CLOSED');
                if (terminated) throw new HostError('BACKEND_CLOSED');
                this.signal.throwIfAborted();
                if (
                  this.metrics.calls >= this.limits.maxToolCalls ||
                  this.metrics.returnedBytes >= this.limits.maxTotalBytes
                )
                  throw new HostError('TOOL_BUDGET_EXHAUSTED');
                this.metrics.calls++;
                const start = performance.now();
                const timeout = AbortSignal.timeout(this.limits.queryTimeoutMs);
                const callSignal = AbortSignal.any([combined, signal, timeout]);
                let output: ToolQueryResult;
                try {
                  const parsed = parser.parse(arguments_);
                  output = validators.toolQueryResult.parse(
                    await withDeadline(
                      binding.binding.call(definition.name, parsed, callSignal),
                      this.limits.queryTimeoutMs,
                      callSignal,
                    ),
                  );
                } catch {
                  combined.throwIfAborted();
                  signal.throwIfAborted();
                  if (timeout.aborted) {
                    terminated = true;
                    await withDeadline(binding.binding.close(), this.limits.cleanupTimeoutMs).catch(
                      () => {},
                    );
                  }
                  output = {
                    status: 'error',
                    content: null,
                    resources: [],
                    truncated: false,
                    failure: {
                      code: timeout.aborted ? 'QUERY_TIMEOUT' : 'QUERY_FAILED',
                      message: '工具调用失败或参数无效。',
                      ...(timeout.aborted ? { remoteStatus: 'unknown' as const } : {}),
                    },
                  };
                } finally {
                  this.metrics.queryMilliseconds += performance.now() - start;
                }
                if (this.#closed) throw new HostError('TURN_CLOSED');
                return this.recordResult(instanceId, definition.name, arguments_, output, combined);
              },
            }),
          );
        }
      }
      if (results.some((result) => result.status === 'rejected'))
        throw new HostError('TOOL_BINDING_FAILED');
    } catch (error) {
      await this.close().catch(() => {});
      throw error;
    }
  }

  get tools(): readonly BoundDiagnosticTool[] {
    return Object.freeze([...this.#tools]);
  }
  async recordEngineEvidence(
    observation: EngineObservation,
    signal: AbortSignal,
  ): Promise<Evidence> {
    if (this.#closed) throw new HostError('TURN_CLOSED');
    const combined = AbortSignal.any([this.signal, this.#abort.signal, signal]);
    combined.throwIfAborted();
    if (
      this.metrics.calls >= this.limits.maxToolCalls ||
      this.metrics.returnedBytes >= this.limits.maxTotalBytes
    )
      throw new HostError('TOOL_BUDGET_EXHAUSTED');
    this.metrics.calls++;
    return this.recordResult(
      this.request.scope.target.engine.instanceId,
      observation.toolName,
      observation.parameters,
      observation.result,
      combined,
    );
  }
  private async recordResult(
    instanceId: string,
    name: string,
    parameters: JsonObject,
    raw: ToolQueryResult,
    signal: AbortSignal,
  ): Promise<Evidence> {
    signal.throwIfAborted();
    const validated = validators.toolQueryResult.parse(raw);
    const result = validators.toolQueryResult.parse({
      ...validated,
      content: this.redactor.value(validated.content),
      resources: this.redactor.value(validated.resources),
      ...(validated.failure
        ? {
            failure: {
              ...validated.failure,
              message: this.redactor.text(validated.failure.message),
            },
          }
        : {}),
    });
    const safeParameters = this.redactor.value(parameters);
    const bytes = Buffer.byteLength(JSON.stringify({ ...result, parameters: safeParameters }));
    if (
      bytes > this.limits.maxResultBytes ||
      this.metrics.returnedBytes + bytes > this.limits.maxTotalBytes
    ) {
      this.metrics.returnedBytes = this.limits.maxTotalBytes;
      return this.evidence(
        instanceId,
        name,
        {},
        {
          status: 'error',
          content: null,
          resources: [],
          truncated: true,
          failure: { code: 'RESULT_BUDGET_EXHAUSTED', message: '结果含元数据超过预算。' },
        },
        signal,
      );
    }
    this.metrics.returnedBytes += bytes;
    return this.evidence(instanceId, name, safeParameters, result, signal);
  }
  private async evidence(
    instanceId: string,
    name: string,
    parameters: JsonObject,
    result: ToolQueryResult,
    signal: AbortSignal,
  ): Promise<Evidence> {
    const evidence = validators.evidence.parse({
      ...result,
      id: randomUUID(),
      investigationId: this.request.investigationId,
      turnId: this.request.turnId,
      targetId: this.request.scope.target.targetId,
      providerInstanceId: instanceId,
      toolName: name,
      parameters,
      observedAt: new Date().toISOString(),
    });
    await this.store.saveEvidence(evidence, signal);
    return evidence;
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#abort.abort();
    this.#closePromise = (async () => {
      const results = await Promise.allSettled(
        this.#bindings.map((binding) =>
          withDeadline(binding.close(), this.limits.cleanupTimeoutMs),
        ),
      );
      if (results.some((result) => result.status === 'rejected'))
        throw new HostError('BACKEND_CLEANUP_UNCONFIRMED');
    })();
    return this.#closePromise;
  }
}
