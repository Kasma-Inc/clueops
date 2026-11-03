import type {
  InvestigationReadAccess,
  InvestigationQuery,
  InvestigationSummary,
  InvestigationPage,
  InvestigationDetail,
  EvidencePage,
  TargetOverview,
  Principal,
} from '../plugin-api/index.js';
import { HostError } from './errors.js';
import type { PluginHost } from './host.js';
import type { Acceptance, InvestigationStore } from './store.js';
import { redactReport } from './reports.js';

/** Reads existing durable state; never exposes plugin configuration or session handles. */
export class InvestigationReader implements InvestigationReadAccess {
  constructor(
    private readonly host: PluginHost,
    private readonly store: InvestigationStore,
  ) {}

  private history(id: string): readonly Acceptance[] {
    return this.store.acceptances().filter((a) => a.request.investigationId === id);
  }

  authorize(principal: Principal, investigationId: string): void {
    this.authorizeFirst(principal, this.history(investigationId)[0]);
  }

  private authorizeFirst(principal: Principal, first: Acceptance | undefined): void {
    if (!first) throw new HostError('ACCESS_DENIED');
    this.host.authorize(principal, first.request.scope.target.targetId);
  }

  private summary(history: readonly Acceptance[], principal: Principal): InvestigationSummary {
    const first = history[0]!;
    const diagnostic = history.filter(
      (a) => !a.request.message.action || a.request.message.action === 'continue',
    );
    const latest = diagnostic.at(-1) ?? first;
    return {
      investigationId: first.request.investigationId,
      targetId: first.request.scope.target.targetId,
      title: this.host.redactor.text(first.request.message.text).slice(0, 240),
      sourceChannel: first.request.message.address.channelInstanceId,
      canContinue:
        this.host.authorize(principal, first.request.scope.target.targetId).target.revision ===
        first.request.scope.target.revision,
      status: this.store.turn(latest.request.turnId).status,
      createdAt: first.acceptedAt,
      updatedAt: history.reduce((date, a) => {
        const updated = this.store.turn(a.request.turnId).updatedAt;
        return updated > date ? updated : date;
      }, first.acceptedAt),
      turnCount: diagnostic.length,
    };
  }

  listInvestigations(principal: Principal, query: InvestigationQuery): InvestigationPage {
    const grouped = new Map<string, Acceptance[]>();
    for (const a of this.store.acceptances()) {
      const id = a.request.investigationId;
      const history = grouped.get(id) ?? [];
      history.push(a);
      grouped.set(id, history);
    }
    const visible = [...grouped.entries()]
      .flatMap(([id, history]) => {
        try {
          this.authorizeFirst(principal, history[0]);
        } catch (error) {
          if (error instanceof HostError && error.code === 'ACCESS_DENIED') return [];
          throw error;
        }
        const latest = history.at(-1)!;
        const cursor = latest.acceptedAt + '|' + id;
        const summary = this.summary(history, principal);
        if (
          (query.before !== undefined && cursor >= query.before) ||
          (query.targetId && summary.targetId !== query.targetId) ||
          (query.status && summary.status !== query.status) ||
          (query.search &&
            ![summary.title, summary.investigationId, summary.targetId]
              .join(' ')
              .toLowerCase()
              .includes(query.search.toLowerCase()))
        )
          return [];
        return [{ summary, cursor }];
      })
      .sort((a, b) => (a.cursor < b.cursor ? 1 : a.cursor > b.cursor ? -1 : 0));
    const page = visible.slice(0, query.limit);
    return {
      investigations: page.map((entry) => entry.summary),
      nextBefore: visible.length > page.length ? page.at(-1)!.cursor : null,
    };
  }

  async getInvestigation(
    principal: Principal,
    investigationId: string,
    query: { readonly before?: number; readonly limit: number },
  ): Promise<InvestigationDetail> {
    this.authorize(principal, investigationId);
    const history = this.history(investigationId);
    const matching = history.filter((a) => query.before === undefined || a.sequence < query.before);
    const page = matching.slice(-query.limit);
    const turns = await Promise.all(
      page.map(async (a) => {
        const state = this.store.turn(a.request.turnId);
        return {
          turnId: a.request.turnId,
          sequence: a.sequence,
          sourceChannel: a.request.message.address.channelInstanceId,
          text: this.host.redactor.text(a.request.message.text),
          ...(a.request.message.action ? { action: a.request.message.action } : {}),
          acceptedAt: a.acceptedAt,
          updatedAt: state.updatedAt,
          status: state.status,
          ...(state.report
            ? { report: redactReport(state.report, (text) => this.host.redactor.text(text)) }
            : {}),
          ...(state.usage ? { usage: state.usage } : {}),
          ...(state.failure ? { failure: this.host.redactor.text(state.failure) } : {}),
          evidenceCount: (await this.store.evidence(a.request.turnId)).length,
        };
      }),
    );
    return {
      investigation: this.summary(history, principal),
      turns,
      nextBefore: matching.length > page.length ? page[0]!.sequence : null,
    };
  }

  async listEvidence(
    principal: Principal,
    investigationId: string,
    turnId: string,
    offset: number,
    limit: number,
  ): Promise<EvidencePage> {
    this.authorize(principal, investigationId);
    if (!this.history(investigationId).some((a) => a.request.turnId === turnId))
      throw new HostError('ACCESS_DENIED');
    const all = [...(await this.store.evidence(turnId))].sort((a, b) => {
      const left = a.observedAt + '|' + a.id;
      const right = b.observedAt + '|' + b.id;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const page = all.slice(offset, offset + limit);
    return {
      evidence: page.map((evidence) => {
        const { content, ...metadata } = evidence;
        const safe = this.host.redactor.value(content);
        const preview = typeof safe === 'string' ? safe : JSON.stringify(safe, null, 2);
        return {
          ...metadata,
          parameters: this.host.redactor.value(metadata.parameters),
          resources: metadata.resources.map((resource) => this.host.redactor.value(resource)),
          ...(metadata.failure
            ? {
                failure: {
                  ...metadata.failure,
                  message: this.host.redactor.text(metadata.failure.message),
                },
              }
            : {}),
          contentPreview: preview.slice(0, 12000),
          previewTruncated: preview.length > 12000,
        };
      }),
      nextOffset: offset + page.length < all.length ? offset + page.length : null,
    };
  }

  listTargets(principal: Principal): readonly TargetOverview[] {
    return this.host.allowedTargets(principal).map((id) => {
      const target = this.host.authorize(principal, id).target;
      // Plugin scopes are public resource identities, not raw connection configuration.
      return {
        targetId: target.targetId,
        revision: target.revision,
        engine: { ...target.engine, resources: this.host.redactor.value(target.engine.resources) },
        tools: target.tools.map((tool) => ({
          ...tool,
          resources: this.host.redactor.value(tool.resources),
        })),
        knowledgeCount: target.knowledge.length,
        skills: (target.skills ?? []).map(({ name, description }) => ({
          name: this.host.redactor.text(name),
          description: this.host.redactor.text(description),
        })),
      };
    });
  }
}
