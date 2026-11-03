import type { ChannelManagementAccess } from './management.js';

export type JsonValue = null | boolean | number | string | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonSchema = boolean | JsonObject;

export interface ChannelAddress {
  readonly channelInstanceId: string;
  readonly tenantId: string;
  readonly conversationId: string;
}

export interface Principal extends ChannelAddress {
  readonly senderId: string;
}

export interface ChannelMessage {
  readonly address: ChannelAddress;
  readonly senderId: string;
  readonly messageId: string;
  readonly text: string;
  readonly targetId?: string;
  readonly investigationId?: string;
  readonly replyToMessageId?: string;
  readonly action?: 'continue' | 'cancel' | 'status' | 'retry-delivery';
}

/** The plugin must describe resource identity and access policy here, never credentials. */
export interface PluginScope {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly apiVersion: 1;
  readonly resources: JsonObject;
}

export interface TargetSnapshot {
  readonly targetId: string;
  readonly revision: string;
  readonly engine: PluginScope;
  readonly tools: readonly PluginScope[];
  readonly knowledge: readonly string[];
  readonly skills?: readonly SkillDescriptor[];
}

/** A target-selected, content-addressed local Agent Skills package. */
export interface SkillDescriptor {
  readonly name: string;
  readonly description: string;
  readonly directory: string;
  readonly digest: string;
}

export interface InvestigationScope {
  readonly target: TargetSnapshot;
  readonly principal: Principal;
}

export interface InvestigationRequest {
  readonly investigationId: string;
  readonly turnId: string;
  readonly scope: InvestigationScope;
  readonly message: ChannelMessage;
}

export interface ToolFailure {
  readonly code: string;
  readonly message: string;
  readonly remoteStatus?: 'stopped' | 'unknown';
}

export interface Evidence {
  readonly id: string;
  readonly investigationId: string;
  readonly turnId: string;
  readonly targetId: string;
  readonly providerInstanceId: string;
  readonly toolName: string;
  readonly parameters: JsonObject;
  readonly resources: readonly JsonObject[];
  readonly observedAt: string;
  readonly timeRange?: { readonly from?: string; readonly to?: string };
  readonly status: 'ok' | 'error' | 'unavailable';
  readonly content: JsonValue;
  readonly truncated: boolean;
  readonly failure?: ToolFailure;
}

export interface ReportClaim {
  readonly text: string;
  readonly evidenceIds: readonly string[];
}

export interface InvestigationReport {
  readonly investigationId: string;
  readonly turnId: string;
  readonly targetId: string;
  readonly facts: readonly ReportClaim[];
  readonly hypotheses: readonly ReportClaim[];
  readonly recommendations: readonly string[];
  readonly missingEvidence: readonly string[];
}

/** Confirmed cumulative usage for this host turn, including report repair attempts. */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** False when any usage cannot be attributed or confirmed. Never an estimate. */
  readonly complete: boolean;
}

export type EngineEvent =
  | { readonly type: 'progress'; readonly message: string }
  | { readonly type: 'usage'; readonly usage: ModelUsage }
  | { readonly type: 'report'; readonly report: InvestigationReport };

export interface EngineSessionOptions {
  readonly scope: InvestigationScope;
  readonly budget?: { readonly maxModelTokens: number };
  readonly history?: {
    readonly inputs: readonly { readonly turnId: string; readonly text: string }[];
    readonly evidence: readonly Evidence[];
    readonly truncated: boolean;
  };
  /** Already authorized and metered; the engine adapts these to its own tool interface. */
  readonly tools: readonly BoundDiagnosticTool[];
  /** Persist observations from native engine tools under the host-owned turn identity. */
  readonly recordEvidence?: (
    observation: EngineObservation,
    signal: AbortSignal,
  ) => Promise<Evidence>;
}

export interface EngineObservation {
  readonly toolName: string;
  readonly parameters: JsonObject;
  readonly result: ToolQueryResult;
}

export interface BoundDiagnosticTool {
  readonly providerInstanceId: string;
  readonly definition: ToolDefinition;
  call(arguments_: JsonObject, signal: AbortSignal): Promise<Evidence>;
}

export interface AgentSession {
  readonly handle: JsonValue;
  runTurn(request: InvestigationRequest, signal: AbortSignal): AsyncIterable<EngineEvent>;
  close(): Promise<void>;
}

export interface AgentEngine {
  /** Can investigate with its own tools when no configured MCP provider is available. */
  readonly supportsNativeTools?: boolean;
  readonly supportsSkills?: boolean;
  createSession(options: EngineSessionOptions, signal: AbortSignal): Promise<AgentSession>;
  resumeSession(
    handle: JsonValue,
    options: EngineSessionOptions,
    signal: AbortSignal,
  ): Promise<AgentSession>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly readOnly: boolean;
}

export interface ToolBindingContext {
  readonly investigationId: string;
  readonly turnId: string;
  readonly targetId: string;
  readonly scopeRevision: string;
  readonly signal: AbortSignal;
}

export interface ToolQueryResult {
  readonly status: 'ok' | 'error' | 'unavailable';
  readonly content: JsonValue;
  readonly resources: readonly JsonObject[];
  readonly truncated: boolean;
  readonly failure?: ToolFailure;
  readonly timeRange?: { readonly from?: string; readonly to?: string };
}

export interface ToolBinding {
  call(name: string, arguments_: JsonObject, signal: AbortSignal): Promise<ToolQueryResult>;
  close(): Promise<void>;
}

export type ToolBindingResult =
  | {
      readonly status: 'ready';
      readonly binding: ToolBinding;
      readonly definitions?: readonly ToolDefinition[];
    }
  | { readonly status: 'unavailable'; readonly failure: ToolFailure };

export interface ToolProvider {
  readonly definitions: readonly ToolDefinition[];
  bind(context: ToolBindingContext): Promise<ToolBindingResult>;
}

export interface DeliveryReceipt {
  readonly address: ChannelAddress;
  readonly messageIds: readonly string[];
}

export interface OutboundMessage {
  readonly address: ChannelAddress;
  /** Reply to the input that triggered this output; channels without reply support may ignore it. */
  readonly replyToMessageId?: string;
  /** Absent for a refusal/target-selection reply before an investigation exists. */
  readonly reference?: InvestigationReference;
  readonly text: string;
  /** Channel-owned presentation, saved with the delivery plan; Core never interprets it. */
  readonly payload?: JsonObject;
  readonly idempotencyKey: string;
}

export interface InvestigationReference {
  readonly investigationId: string;
  readonly turnId: string;
}

export interface AcceptanceResult extends InvestigationReference {
  readonly status: 'accepted';
}
export type MessageHandlingResult =
  AcceptanceResult | { readonly status: 'rejected'; readonly reason: string };

/** Accepted requires durability; resolved rejection is terminal; thrown errors request retry. */
export type MessageHandler = (
  message: ChannelMessage,
  reception?: MessageReception,
) => Promise<MessageHandlingResult>;

/** Lazily read one explicitly quoted message; the host calls this only after authorization. */
export type MessageContextReader = (
  signal: AbortSignal,
) => Promise<{ readonly messageId: string; readonly text: string }>;

export interface MessageReception {
  readonly readContext?: MessageContextReader;
  /** Unaddressed replies only continue a known investigation; ignore all others silently. */
  readonly linkedReplyOnly?: boolean;
}

export type InvestigationTurnStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'handled';

export interface InvestigationReply {
  readonly kind: 'accepted' | 'status' | 'report' | 'failure' | 'interrupted';
  readonly reference: InvestigationReference;
  readonly targetId: string;
  readonly text: string;
  readonly report?: InvestigationReport;
  readonly usage?: ModelUsage;
  readonly action?: ChannelMessage['action'];
  readonly sequence?: number;
  readonly turns?: readonly {
    readonly sequence: number;
    readonly turnId: string;
    readonly status: InvestigationTurnStatus;
    readonly action?: ChannelMessage['action'];
    readonly failureCode?: string;
  }[];
  readonly effect?: {
    readonly affectedTurns?: number;
    readonly retriedMessages?: number;
    readonly remoteStatus?: 'unknown';
    /** A recovered command may already have applied part of its effect before interruption. */
    readonly outcome?: 'uncertain';
  };
  readonly failure?: { readonly status: InvestigationTurnStatus; readonly code: string };
}

/** Source-local guidance without an investigation association; targets are already authorized. */
export interface ChannelNoticeReply {
  readonly kind: 'notice';
  readonly text: string;
  readonly notice: { readonly code: string; readonly targets?: readonly string[] };
}

export type ChannelReply = InvestigationReply | ChannelNoticeReply;

export interface RenderedMessage {
  readonly text: string;
  readonly payload?: JsonObject;
}

export interface MessageChannel {
  /** Pure and synchronous; business text/report is redacted. Host checks chunks and saves investigation plans. */
  renderReply?(reply: ChannelReply, maxTextBytes: number): readonly RenderedMessage[];
  /** Cooperate with cancellation; never register reception after signal abortion. */
  start(
    handler: MessageHandler,
    signal: AbortSignal,
    readAccess?: ChannelReadAccess,
  ): Promise<void>;
  /** Idempotent; must also cancel a partially completed start. */
  stop(): Promise<void>;
  send(message: OutboundMessage): Promise<DeliveryReceipt>;
  update(receipt: DeliveryReceipt, message: OutboundMessage): Promise<DeliveryReceipt>;
}

/** Read-only authorization against the current principal, source and target scope. */
export interface ChannelReadAccess {
  authorizeInvestigation(principal: Principal, investigationId: string): void;
  readonly management?: ChannelManagementAccess;
}

export type CapabilityKind = 'engine' | 'tools' | 'channel';

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly capabilities: readonly CapabilityKind[];
  readonly configSchema: JsonSchema;
  /** Paths relative to the module, not the host process cwd. */
  readonly knowledge?: readonly string[];
}

export interface PluginContext {
  readonly instanceId: string;
  readonly configFile: string;
  /** Host-owned private persistence directory; not part of resource identity. */
  readonly stateDirectory?: string;
  /** Resolve references relative to the declaration, or to an explicit configFile. */
  resolvePath(path: string): string;
  /** Register private values for host-side input/result/log redaction. */
  registerSecrets?(values: readonly string[]): void;
}

export interface PluginInstance {
  readonly scope: JsonObject;
  readonly engine?: AgentEngine;
  readonly tools?: ToolProvider;
  readonly channel?: MessageChannel;
  /** Idempotently release acquired resources. Channels are stopped first. */
  dispose(): Promise<void>;
}

export interface PluginDefinition<Config = JsonValue> {
  readonly manifest: PluginManifest;
  create(config: Config, context: PluginContext): Promise<PluginInstance>;
}

export function definePlugin<Config>(
  definition: PluginDefinition<Config>,
): PluginDefinition<Config> {
  return Object.freeze(definition);
}
