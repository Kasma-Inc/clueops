import type {
  Evidence,
  InvestigationReport,
  InvestigationTurnStatus,
  ModelUsage,
  PluginScope,
  Principal,
} from './contracts.js';

export interface InvestigationQuery {
  readonly before?: string;
  readonly limit: number;
  readonly search?: string;
  readonly targetId?: string;
  readonly status?: InvestigationTurnStatus;
}
export interface InvestigationSummary {
  readonly investigationId: string;
  readonly targetId: string;
  readonly title: string;
  readonly status: InvestigationTurnStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turnCount: number;
}
export interface InvestigationPage {
  readonly investigations: readonly InvestigationSummary[];
  readonly nextBefore: string | null;
}
export interface InvestigationTurn {
  readonly turnId: string;
  readonly sequence: number;
  readonly text: string;
  readonly action?: string;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly status: InvestigationTurnStatus;
  readonly report?: InvestigationReport;
  readonly usage?: ModelUsage;
  readonly failure?: string;
  readonly evidenceCount: number;
}
export interface InvestigationDetail {
  readonly investigation: InvestigationSummary;
  readonly turns: readonly InvestigationTurn[];
  readonly nextBefore: number | null;
}
export interface EvidencePreview extends Omit<Evidence, 'content'> {
  readonly contentPreview: string;
  readonly previewTruncated: boolean;
}
export interface EvidencePage {
  readonly evidence: readonly EvidencePreview[];
  readonly nextOffset: number | null;
}
export interface TargetOverview {
  readonly targetId: string;
  readonly revision: string;
  readonly engine: PluginScope;
  readonly tools: readonly PluginScope[];
  readonly knowledgeCount: number;
  readonly skills: readonly { readonly name: string; readonly description: string }[];
}

/** Host-owned read model. Each operation must recheck the supplied principal's current scope. */
export interface ChannelManagementAccess {
  listInvestigations(principal: Principal, query: InvestigationQuery): InvestigationPage;
  getInvestigation(
    principal: Principal,
    investigationId: string,
    query: { readonly before?: number; readonly limit: number },
  ): Promise<InvestigationDetail>;
  listEvidence(
    principal: Principal,
    investigationId: string,
    turnId: string,
    offset: number,
    limit: number,
  ): Promise<EvidencePage>;
  listTargets(principal: Principal): readonly TargetOverview[];
}
