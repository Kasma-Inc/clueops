import path from 'node:path';
import { validators } from '../plugin-api/index.js';
import type {
  AgentEngine,
  ChannelReadAccess,
  ChannelManagementAccess,
  InvestigationScope,
  MessageHandler,
  PluginScope,
  Principal,
  TargetSnapshot,
  SkillDescriptor,
  ToolProvider,
} from '../plugin-api/index.js';
import { readConfiguration } from './config.js';
import type { Configuration } from './config.js';
import { HostError, TargetSelectionRequired } from './errors.js';
import { knowledgePaths, loadPlugins } from './plugins.js';
import type { LoadedPlugin } from './plugins.js';
import { withDeadline } from './lifecycle.js';
import { loadSkills } from './skills.js';
import { Redactor } from './redaction.js';
import { runtimeDefaults } from './runtime-config.js';
import type { RuntimeSettings } from './runtime-config.js';
import { fingerprint } from './identity.js';

export class PluginHost {
  readonly #configuration: Configuration;
  readonly #plugins: ReadonlyMap<string, LoadedPlugin>;
  readonly #targets: ReadonlyMap<string, TargetSnapshot>;
  readonly redactor: Redactor;
  #phase: 'prepared' | 'starting' | 'started' | 'closing' | 'closed' = 'prepared';
  #started: string[] = [];
  #closePromise: Promise<void> | undefined;
  #startOperation: Promise<void> | undefined;
  readonly #startAbort = new AbortController();
  readonly #pendingStarts = new Map<string, Promise<void>>();
  readonly #lateStarts = new Set<string>();
  #resolveClosed: () => void = () => {};
  readonly #closed = new Promise<void>((resolve) => {
    this.#resolveClosed = resolve;
  });

  private constructor(
    configuration: Configuration,
    plugins: ReadonlyMap<string, LoadedPlugin>,
    targets: ReadonlyMap<string, TargetSnapshot>,
    redactor: Redactor,
  ) {
    this.#configuration = configuration;
    this.#plugins = plugins;
    this.#targets = targets;
    this.redactor = redactor;
  }

  static async load(
    configFile: string,
    catalog: Readonly<Record<string, string>> = {},
  ): Promise<PluginHost> {
    const configuration = await readConfiguration(configFile, catalog);
    // Validate knowledge paths before any plugin creation acquires resources.
    const targetKnowledge = new Map<string, readonly string[]>();
    const targetSkills = new Map<string, readonly SkillDescriptor[]>();
    for (const [targetId, target] of Object.entries(configuration.composition.targets)) {
      targetKnowledge.set(
        targetId,
        await knowledgePaths(target.knowledge ?? [], configuration.directory),
      );
      targetSkills.set(targetId, await loadSkills(target.skills ?? []));
    }
    const redactor = new Redactor();
    const plugins = await loadPlugins(configuration, redactor);
    const targets = new Map<string, TargetSnapshot>();
    try {
      for (const [targetId, target] of Object.entries(configuration.composition.targets)) {
        const engine = plugins.get(target.engine)!;
        const skills = targetSkills.get(targetId)!;
        if (skills.length && !engine.instance.engine?.supportsSkills)
          throw new HostError('ENGINE_SKILLS_UNSUPPORTED', target.engine);
        const tools = target.tools
          .map((id) => plugins.get(id)!)
          .sort((a, b) =>
            a.scope.instanceId < b.scope.instanceId
              ? -1
              : a.scope.instanceId > b.scope.instanceId
                ? 1
                : 0,
          );
        const knowledge = [
          ...new Set([
            ...(targetKnowledge.get(targetId) ?? []),
            ...engine.knowledge,
            ...tools.flatMap((item) => item.knowledge),
          ]),
        ].sort();
        const identity = {
          targetId,
          engine: engine.scope,
          tools: tools.map((item) => item.scope),
          knowledge,
          ...(skills.length ? { skills } : {}),
        };
        const revision = fingerprint(identity);
        targets.set(targetId, validators.targetSnapshot.parse({ ...identity, revision }));
      }
      return new PluginHost(configuration, plugins, targets, redactor);
    } catch (error) {
      for (const plugin of [...plugins.values()].reverse()) {
        try {
          await withDeadline(
            plugin.instance.dispose(),
            configuration.composition.lifecycleTimeoutMs ?? 10000,
          );
        } catch {
          /* Keep cleaning. */
        }
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.#phase === 'closed' || this.#phase === 'closing') throw new HostError('HOST_CLOSED');
  }

  describePlugins(): readonly PluginScope[] {
    this.assertOpen();
    return Object.freeze([...this.#plugins.values()].map((item) => item.scope));
  }

  get runtime(): RuntimeSettings {
    const settings = { ...runtimeDefaults, ...this.#configuration.composition.runtime };
    return Object.freeze({
      ...settings,
      stateDirectory: path.resolve(this.#configuration.directory, settings.stateDirectory),
    });
  }
  channelFor(instanceId: string) {
    this.assertOpen();
    const channel = this.#plugins.get(instanceId)?.instance.channel;
    if (!channel) throw new HostError('CHANNEL_NOT_FOUND');
    return channel;
  }

  allowedTargets(principal: Principal): readonly string[] {
    this.assertOpen();
    // Validate caller identity, including the tenant, before matching routes.
    validators.principal.parse(principal);
    const targets = new Set<string>();
    for (const route of this.#configuration.composition.routes) {
      if (
        route.channel === principal.channelInstanceId &&
        (route.tenant === undefined || route.tenant === principal.tenantId) &&
        (route.conversation === undefined || route.conversation === principal.conversationId) &&
        (route.allowedSenders === undefined || route.allowedSenders.includes(principal.senderId))
      ) {
        for (const id of route.targets) targets.add(id);
      }
    }
    return Object.freeze([...targets].sort());
  }

  authorize(principal: Principal, targetId?: string): InvestigationScope {
    const allowed = this.allowedTargets(principal);
    if (!allowed.length || (targetId !== undefined && !allowed.includes(targetId)))
      throw new HostError('ACCESS_DENIED');
    if (targetId === undefined && allowed.length !== 1) throw new TargetSelectionRequired(allowed);
    return validators.investigationScope.parse({
      target: this.#targets.get(targetId ?? allowed[0]!),
      principal,
    });
  }

  restore(principal: Principal, previous: TargetSnapshot): InvestigationScope {
    const saved = validators.targetSnapshot.parse(previous);
    const current = this.authorize(principal, saved.targetId);
    if (current.target.revision !== saved.revision)
      throw new HostError('TARGET_SCOPE_CHANGED', saved.targetId);
    return current;
  }

  private currentTarget(snapshot_: TargetSnapshot): TargetSnapshot {
    this.assertOpen();
    const current = this.#targets.get(snapshot_.targetId);
    if (!current || current.revision !== snapshot_.revision)
      throw new HostError('TARGET_SCOPE_CHANGED');
    return current;
  }

  engineFor(target: TargetSnapshot): AgentEngine {
    return this.#plugins.get(this.currentTarget(target).engine.instanceId)!.instance.engine!;
  }

  toolsFor(
    target: TargetSnapshot,
  ): readonly { readonly instanceId: string; readonly provider: ToolProvider }[] {
    return Object.freeze(
      this.currentTarget(target).tools.map((scope) => ({
        instanceId: scope.instanceId,
        provider: this.#plugins.get(scope.instanceId)!.provider!,
      })),
    );
  }

  private readPrincipal(incoming: Principal, id: string): Principal {
    this.assertOpen();
    const principal = validators.principal.parse(incoming);
    if (principal.channelInstanceId !== id) throw new HostError('CHANNEL_SOURCE_MISMATCH', id);
    return principal;
  }

  async start(
    handler: MessageHandler,
    authorizeRead?: ChannelReadAccess['authorizeInvestigation'],
    management?: ChannelManagementAccess,
  ): Promise<void> {
    if (this.#phase !== 'prepared') throw new HostError('HOST_STATE_INVALID');
    this.#phase = 'starting';
    this.#startOperation = (async () => {
      for (const id of new Set(
        this.#configuration.composition.routes.map((route) => route.channel),
      )) {
        if (this.#phase !== 'starting') return;
        this.#started.push(id);
        try {
          const operation = this.#plugins.get(id)!.instance.channel!.start(
            async (incoming, reception) => {
              this.assertOpen();
              let message;
              try {
                message = validators.channelMessage.parse(incoming);
              } catch {
                throw new HostError('CHANNEL_MESSAGE_INVALID', id);
              }
              if (message.address.channelInstanceId !== id)
                throw new HostError('CHANNEL_SOURCE_MISMATCH', id);
              try {
                return validators.messageHandlingResult.parse(await handler(message, reception));
              } catch {
                throw new HostError('CHANNEL_HANDLER_FAILED', id);
              }
            },
            this.#startAbort.signal,
            authorizeRead
              ? {
                  ...(management
                    ? {
                        management: {
                          listInvestigations: (incoming, query) =>
                            management.listInvestigations(this.readPrincipal(incoming, id), query),
                          getInvestigation: (incoming, investigationId, query) =>
                            management.getInvestigation(
                              this.readPrincipal(incoming, id),
                              investigationId,
                              query,
                            ),
                          listEvidence: (incoming, investigationId, turnId, offset, limit) =>
                            management.listEvidence(
                              this.readPrincipal(incoming, id),
                              investigationId,
                              turnId,
                              offset,
                              limit,
                            ),
                          listTargets: (incoming) =>
                            management.listTargets(this.readPrincipal(incoming, id)),
                        } satisfies ChannelManagementAccess,
                      }
                    : {}),
                  authorizeInvestigation: (incoming, investigationId) => {
                    authorizeRead(this.readPrincipal(incoming, id), investigationId);
                  },
                }
              : undefined,
          );
          this.#pendingStarts.set(id, operation);
          void operation.then(
            () => this.startSettled(id),
            () => this.startSettled(id),
          );
          await withDeadline(operation, this.timeout, this.#startAbort.signal);
        } catch {
          if (this.#closePromise !== undefined) return;
          this.#startAbort.abort();
          throw new HostError('CHANNEL_START_FAILED', id);
        }
      }
      if (this.#phase === 'starting') this.#phase = 'started';
    })();
    try {
      await this.#startOperation;
    } catch (error) {
      try {
        await this.close();
      } catch {
        /* Preserve a sanitized startup error. */
      }
      throw error;
    }
  }

  close(drain: () => Promise<void> = async () => {}): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#phase = 'closing';
    this.#startAbort.abort();
    this.#closePromise = this.shutdown(drain);
    return this.#closePromise;
  }

  private async shutdown(drain: () => Promise<void>): Promise<void> {
    const failed: string[] = [];
    const starting = [...this.#pendingStarts.keys()];
    for (const id of [...this.#started].reverse()) {
      try {
        await withDeadline(this.#plugins.get(id)!.instance.channel!.stop(), this.timeout);
      } catch {
        failed.push(id);
      }
    }
    try {
      await this.#startOperation;
    } catch {
      /* Stop even a partially started channel. */
    }
    try {
      await withDeadline(Promise.allSettled(this.#pendingStarts.values()), this.timeout);
    } catch {
      for (const id of this.#pendingStarts.keys()) {
        this.#lateStarts.add(id);
        failed.push(id);
      }
    }
    // A start that finished while stopping may have registered reception after the first stop.
    for (const id of starting) {
      if (this.#lateStarts.has(id)) continue;
      try {
        await withDeadline(this.#plugins.get(id)!.instance.channel!.stop(), this.timeout);
      } catch {
        failed.push(id);
      }
    }
    try {
      await withDeadline(drain(), this.timeout);
    } catch {
      failed.push('investigations');
    }
    for (const [id, plugin] of [...this.#plugins].reverse()) {
      try {
        await withDeadline(plugin.instance.dispose(), this.timeout);
      } catch {
        failed.push(id);
      }
    }
    this.#phase = 'closed';
    this.#resolveClosed();
    if (failed.length) throw new HostError('SHUTDOWN_FAILED', failed.join(','));
  }

  private get timeout(): number {
    return this.#configuration.composition.lifecycleTimeoutMs ?? 10000;
  }

  private async startSettled(id: string): Promise<void> {
    this.#pendingStarts.delete(id);
    if (!this.#lateStarts.has(id)) return;
    await this.#closed;
    const plugin = this.#plugins.get(id)!;
    // A non-cooperating late start must be stopped again after it actually completes.
    try {
      await withDeadline(plugin.instance.channel!.stop(), this.timeout);
    } catch {
      /* Host already reported uncertain cleanup. */
    }
    try {
      await withDeadline(plugin.instance.dispose(), this.timeout);
    } catch {
      /* Continue best-effort late cleanup. */
    }
    this.#lateStarts.delete(id);
  }
}
