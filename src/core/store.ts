import {
  open,
  mkdir,
  realpath,
  stat,
  readdir,
  readFile,
  rename,
  unlink,
  link,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  compileContract,
  objectSchema,
  schemas,
  snapshot,
  validators,
} from '../plugin-api/index.js';
import type {
  ContractValidator,
  DeliveryReceipt,
  Evidence,
  InvestigationReport,
  InvestigationRequest,
  JsonValue,
  ModelUsage,
  OutboundMessage,
  InvestigationTurnStatus,
} from '../plugin-api/index.js';
import { HostError } from './errors.js';
import { fingerprint, messageKey } from './identity.js';
import { SerialQueue } from './serial.js';

const native = createRequire(import.meta.url)('fs-native-extensions') as {
  tryLock(fd: number): boolean;
  unlock(fd: number): void;
};
const text = { type: 'string', minLength: 1 } as const;
const date = { type: 'string', format: 'date-time' } as const;
export interface Acceptance {
  readonly version: 1;
  readonly key: string;
  readonly sequence: number;
  readonly acceptedAt: string;
  /** Original input before externally read context was appended. Absent in older records. */
  readonly inputFingerprint?: string;
  readonly request: InvestigationRequest;
}
export type TurnStatus = InvestigationTurnStatus;
export interface TurnState {
  readonly version: 1;
  readonly turnId: string;
  readonly status: TurnStatus;
  readonly updatedAt: string;
  readonly sessionHandle?: JsonValue;
  readonly report?: InvestigationReport;
  readonly usage?: ModelUsage;
  readonly failure?: string;
}
export interface Delivery {
  readonly version: 1;
  readonly id: string;
  readonly message: OutboundMessage;
  readonly status: 'pending' | 'sending' | 'sent' | 'unknown' | 'failed';
  readonly attempts: number;
  readonly updatedAt: string;
  readonly receipt?: DeliveryReceipt;
  readonly failure?: string;
}
export interface OutputPlan {
  readonly version: 1;
  readonly id: string;
  readonly messages: readonly OutboundMessage[];
}
export interface ExpiredInvestigation {
  readonly investigationId: string;
  readonly sessions: readonly {
    readonly instanceId: string;
    readonly pluginId: string;
    readonly handle: JsonValue;
  }[];
}
interface PrunePlan extends ExpiredInvestigation {
  readonly version: 1;
  readonly accepted: readonly string[];
  readonly turns: readonly string[];
  readonly evidence: readonly string[];
  readonly deliveries: readonly string[];
  readonly outputs: readonly string[];
}
const recordKinds = ['accepted', 'turns', 'evidence', 'deliveries', 'outputs'] as const;
const pruneValidator = compileContract<PrunePlan>(
  objectSchema({
    version: { const: 1 },
    investigationId: text,
    ...Object.fromEntries(recordKinds.map((kind) => [kind, { type: 'array', items: text }])),
    sessions: {
      type: 'array',
      items: objectSchema({ instanceId: text, pluginId: text, handle: {} }),
    },
  }),
  'prune plan',
);
const outputValidator = compileContract<OutputPlan>(
  objectSchema({
    version: { const: 1 },
    id: text,
    messages: { type: 'array', minItems: 1, items: schemas.outboundMessage },
  }),
  'output plan',
);
const acceptanceValidator = compileContract<Acceptance>(
  objectSchema(
    {
      version: { const: 1 },
      key: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      sequence: { type: 'integer', minimum: 1 },
      acceptedAt: date,
      inputFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      request: schemas.investigationRequest,
    },
    ['version', 'key', 'sequence', 'acceptedAt', 'request'],
  ),
  'acceptance',
);
const stateValidator = compileContract<TurnState>(
  objectSchema(
    {
      version: { const: 1 },
      turnId: text,
      status: {
        enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'handled'],
      },
      updatedAt: date,
      sessionHandle: {},
      report: schemas.report,
      usage: schemas.modelUsage,
      failure: text,
    },
    ['version', 'turnId', 'status', 'updatedAt'],
  ),
  'turn state',
);
const deliveryValidator = compileContract<Delivery>(
  objectSchema(
    {
      version: { const: 1 },
      id: text,
      message: schemas.outboundMessage,
      status: { enum: ['pending', 'sending', 'sent', 'unknown', 'failed'] },
      attempts: { type: 'integer', minimum: 0 },
      updatedAt: date,
      receipt: schemas.deliveryReceipt,
      failure: text,
    },
    ['version', 'id', 'message', 'status', 'attempts', 'updatedAt'],
  ),
  'delivery',
);

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function durableDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
    await syncDirectory(path.dirname(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await durableDirectory(path.dirname(directory));
      await durableDirectory(directory);
    } else if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !(await stat(directory)).isDirectory()
    )
      throw error;
  }
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
export type CommitPhase =
  | 'temp-synced'
  | 'published'
  | 'directory-synced'
  | 'prune-planned'
  | 'prune-file-deleted'
  | 'prune-deleted';

/** The immutable acceptance file is the commit; every other view is recoverable. */
export class InvestigationStore {
  readonly #queue = new SerialQueue();
  readonly #acceptances = new Map<string, Acceptance>();
  readonly #states = new Map<string, TurnState>();
  readonly #deliveries = new Map<string, Delivery>();
  readonly #evidence = new Map<string, Evidence>();
  readonly #outputs = new Map<string, OutputPlan>();
  readonly #pruning = new Map<string, PrunePlan>();
  #closing = false;
  #poisoned = false;
  private constructor(
    readonly directory: string,
    private readonly lock: FileHandle,
    private readonly commitProbe?: (phase: CommitPhase) => Promise<void>,
  ) {}

  static async open(
    directory: string,
    options: { commitProbe?: (phase: CommitPhase) => Promise<void> } = {},
  ): Promise<InvestigationStore> {
    await durableDirectory(path.resolve(directory));
    const root = await realpath(directory);
    const lock = await open(path.join(root, '.writer'), 'a+', 0o600);
    try {
      if (!native.tryLock(lock.fd)) throw new HostError('STATE_DIRECTORY_LOCKED');
      const store = new InvestigationStore(root, lock, options.commitProbe);
      for (const name of [...recordKinds, 'pruning']) await durableDirectory(path.join(root, name));
      // Verify required no-clobber and directory-sync operations on the actual state volume.
      const probe = path.join(root, '.probe-' + randomUUID());
      const handle = await open(probe, 'wx', 0o600);
      await handle.writeFile('probe');
      await handle.sync();
      await handle.close();
      try {
        await link(probe, probe + '.link');
        await syncDirectory(root);
      } finally {
        await unlink(probe);
        await unlink(probe + '.link').catch(() => {});
      }
      // Finish committed deletions before validating references or reconstructing queued turns.
      for (const file of await store.files('pruning', true)) {
        const plan = await store.parse(file, pruneValidator);
        if (file !== store.file('pruning', plan.investigationId))
          throw new HostError('STATE_CORRUPT');
        store.#pruning.set(plan.investigationId, plan);
        await store.removeRecords(plan);
      }
      await store.recover();
      return store;
    } catch (error) {
      await lock.close();
      throw error;
    }
  }

  private check(): void {
    if (this.#closing || this.#poisoned) throw new HostError('STORE_UNAVAILABLE');
  }
  private file(kind: string, id: string): string {
    return path.join(this.directory, kind, fingerprint(id) + '.json');
  }
  private async parse<T>(file: string, validator: ContractValidator<T>): Promise<T> {
    try {
      return validator.parse(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      throw new HostError('STATE_CORRUPT', path.basename(file));
    }
  }
  private async files(kind: string, cleanup = false): Promise<string[]> {
    const directory = path.join(this.directory, kind);
    const files = await readdir(directory);
    // Abandoned staging files never constitute acceptance.
    if (cleanup)
      for (const file of files.filter((name) => name.endsWith('.tmp')))
        await unlink(path.join(directory, file));
    return files
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => path.join(directory, name));
  }
  private async recover(): Promise<void> {
    const sequences = new Set<string>();
    for (const file of await this.files('accepted', true)) {
      const record = await this.parse(file, acceptanceValidator);
      const { request } = record;
      const ordinal = request.investigationId + ':' + record.sequence;
      const principal = request.scope.principal;
      if (
        record.key !== messageKey(request.message) ||
        file !== this.file('accepted', record.key) ||
        this.#states.has(request.turnId) ||
        sequences.has(ordinal) ||
        principal.senderId !== request.message.senderId ||
        fingerprint(request.message.address) !==
          fingerprint({
            channelInstanceId: principal.channelInstanceId,
            tenantId: principal.tenantId,
            conversationId: principal.conversationId,
          })
      )
        throw new HostError('STATE_CORRUPT');
      sequences.add(ordinal);
      this.#acceptances.set(record.key, record);
      this.#states.set(
        request.turnId,
        snapshot({
          version: 1,
          turnId: request.turnId,
          status: 'queued',
          updatedAt: record.acceptedAt,
        }),
      );
    }
    for (const eventId of new Set(
      [...this.#acceptances.values()].map((a) => a.request.investigationId),
    )) {
      const records = [...this.#acceptances.values()]
        .filter((a) => a.request.investigationId === eventId)
        .sort((a, b) => a.sequence - b.sequence);
      const first = records[0]!;
      if (
        records.some(
          (a, index) =>
            a.sequence !== index + 1 ||
            fingerprint(a.request.scope.target) !== fingerprint(first.request.scope.target),
        )
      )
        throw new HostError('STATE_CORRUPT');
    }
    await syncDirectory(path.join(this.directory, 'accepted'));
    for (const file of await this.files('turns', true)) {
      const state = await this.parse(file, stateValidator);
      if (!this.#states.has(state.turnId) || file !== this.file('turns', state.turnId))
        throw new HostError('STATE_CORRUPT');
      const request = [...this.#acceptances.values()].find(
        (a) => a.request.turnId === state.turnId,
      )!.request;
      if (
        (state.status === 'completed' && !state.report) ||
        (state.report &&
          (state.report.turnId !== state.turnId ||
            state.report.investigationId !== request.investigationId ||
            state.report.targetId !== request.scope.target.targetId))
      )
        throw new HostError('STATE_CORRUPT');
      this.#states.set(state.turnId, state);
    }
    for (const file of await this.files('evidence', true)) {
      const evidence = await this.parse(file, validators.evidence);
      const acceptance = [...this.#acceptances.values()].find(
        (a) => a.request.turnId === evidence.turnId,
      );
      if (
        file !== this.file('evidence', evidence.id) ||
        !acceptance ||
        acceptance.request.investigationId !== evidence.investigationId ||
        acceptance.request.scope.target.targetId !== evidence.targetId
      )
        throw new HostError('STATE_CORRUPT');
      this.#evidence.set(evidence.id, evidence);
    }
    for (const file of await this.files('deliveries', true)) {
      const delivery = await this.parse(file, deliveryValidator);
      if (
        delivery.id !== delivery.message.idempotencyKey ||
        file !== this.file('deliveries', delivery.id) ||
        (delivery.status === 'sent' && !delivery.receipt) ||
        (delivery.receipt &&
          fingerprint(delivery.receipt.address) !== fingerprint(delivery.message.address))
      )
        throw new HostError('STATE_CORRUPT');
      this.checkOutbound(delivery.message);
      this.#deliveries.set(delivery.id, delivery);
    }
    for (const file of await this.files('outputs', true)) {
      const output = await this.parse(file, outputValidator);
      if (file !== this.file('outputs', output.id)) throw new HostError('STATE_CORRUPT');
      for (const message of output.messages) this.checkOutbound(message);
      this.#outputs.set(output.id, output);
    }
    // Running cannot be distinguished from a crash after a remote request was accepted.
    for (const state of this.#states.values()) {
      if (state.status === 'running')
        await this.setTurn(state.turnId, 'interrupted', { failure: 'SERVICE_RESTARTED' });
    }
    for (const delivery of this.#deliveries.values()) {
      if (delivery.status === 'sending')
        await this.saveDelivery({
          ...delivery,
          status: 'unknown',
          failure: 'RECEIPT_UNKNOWN_AFTER_RESTART',
        });
    }
  }

  private async publish(
    file: string,
    value: unknown,
    immutable: boolean,
    probe = false,
  ): Promise<boolean> {
    try {
      return await this.publishValue(file, value, immutable, probe);
    } catch (error) {
      this.#poisoned = true;
      throw error;
    }
  }
  private async publishValue(
    file: string,
    value: unknown,
    immutable: boolean,
    probe = false,
  ): Promise<boolean> {
    const directory = path.dirname(file);
    await durableDirectory(directory);
    const temp = path.join(directory, randomUUID() + '.tmp');
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      if (probe) await this.commitProbe?.('temp-synced');
      try {
        if (immutable) await link(temp, file);
        else await rename(temp, file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !immutable) throw error;
        await syncDirectory(directory);
        return false;
      }
      if (probe) await this.commitProbe?.('published');
      await syncDirectory(directory);
      if (probe) await this.commitProbe?.('directory-synced');
      return true;
    } finally {
      await unlink(temp).catch((error) => {
        if (!missing(error)) throw error;
      });
    }
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    this.check();
    return this.#queue.run(async () => {
      if (this.#poisoned) throw new HostError('STORE_UNAVAILABLE');
      return work();
    });
  }

  acceptances(): readonly Acceptance[] {
    return Object.freeze([...this.#acceptances.values()].sort((a, b) => a.sequence - b.sequence));
  }
  find(key: string): Acceptance | undefined {
    return this.#acceptances.get(key);
  }
  turn(turnId: string): TurnState {
    const state = this.#states.get(turnId);
    if (!state) throw new HostError('TURN_NOT_FOUND');
    return state;
  }
  deliveries(): readonly Delivery[] {
    return Object.freeze([...this.#deliveries.values()]);
  }
  output(id: string): OutputPlan | undefined {
    return this.#outputs.get(id);
  }
  async saveOutput(input: OutputPlan): Promise<OutputPlan> {
    const plan = outputValidator.parse(input);
    for (const message of plan.messages) this.checkOutbound(message);
    return this.mutate(async () => {
      const previous = this.#outputs.get(plan.id);
      if (previous) return previous;
      await this.publish(this.file('outputs', plan.id), plan, true);
      this.#outputs.set(plan.id, plan);
      return plan;
    });
  }
  private checkOutbound(message: OutboundMessage): void {
    if (!message.reference) throw new HostError('DELIVERY_SCOPE_INVALID');
    const request = [...this.#acceptances.values()].find(
      (a) => a.request.turnId === message.reference!.turnId,
    )?.request;
    if (
      !request ||
      request.investigationId !== message.reference.investigationId ||
      fingerprint(request.message.address) !== fingerprint(message.address)
    )
      throw new HostError('DELIVERY_SCOPE_INVALID');
  }

  async accept(input: Acceptance): Promise<Acceptance> {
    const record = acceptanceValidator.parse(input);
    if (record.key !== messageKey(record.request.message))
      throw new HostError('ACCEPTANCE_KEY_INVALID');
    return this.mutate(async () => {
      if ([...this.#pruning.values()].some((plan) => plan.accepted.includes(record.key)))
        throw new HostError('MESSAGE_ID_CONFLICT');
      const original = this.#acceptances.get(record.key);
      if (original) {
        if (
          original.request.scope.target.targetId !== record.request.scope.target.targetId ||
          (original.inputFingerprint ?? fingerprint(original.request.message)) !==
            (record.inputFingerprint ?? fingerprint(record.request.message))
        )
          throw new HostError('MESSAGE_ID_CONFLICT');
        return original;
      }
      const principal = record.request.scope.principal;
      const address = {
        channelInstanceId: principal.channelInstanceId,
        tenantId: principal.tenantId,
        conversationId: principal.conversationId,
      };
      const history = [...this.#acceptances.values()].filter(
        (a) => a.request.investigationId === record.request.investigationId,
      );
      if (
        this.#states.has(record.request.turnId) ||
        record.sequence !== history.length + 1 ||
        principal.senderId !== record.request.message.senderId ||
        fingerprint(address) !== fingerprint(record.request.message.address) ||
        history.some(
          (a) => fingerprint(a.request.scope.target) !== fingerprint(record.request.scope.target),
        )
      )
        throw new HostError('ACCEPTANCE_CONFLICT');
      const created = await this.publish(this.file('accepted', record.key), record, true, true);
      const committed = created
        ? record
        : await this.parse(this.file('accepted', record.key), acceptanceValidator);
      if (
        committed.request.scope.target.targetId !== record.request.scope.target.targetId ||
        (committed.inputFingerprint ?? fingerprint(committed.request.message)) !==
          (record.inputFingerprint ?? fingerprint(record.request.message))
      )
        throw new HostError('MESSAGE_ID_CONFLICT');
      this.#acceptances.set(committed.key, committed);
      if (!this.#states.has(committed.request.turnId))
        this.#states.set(
          committed.request.turnId,
          snapshot({
            version: 1,
            turnId: committed.request.turnId,
            status: 'queued',
            updatedAt: committed.acceptedAt,
          }),
        );
      return committed;
    });
  }
  async setTurn(
    turnId: string,
    status: TurnStatus,
    patch: {
      sessionHandle?: JsonValue;
      report?: InvestigationReport;
      usage?: ModelUsage;
      failure?: string;
    } = {},
  ): Promise<TurnState> {
    return this.mutate(async () => {
      const old = this.turn(turnId);
      const allowed: Record<TurnStatus, readonly TurnStatus[]> = {
        queued: ['queued', 'running', 'cancelled', 'failed', 'handled'],
        running: ['running', 'completed', 'failed', 'cancelled', 'interrupted'],
        interrupted: ['interrupted', 'failed', 'cancelled'],
        completed: ['completed'],
        failed: ['failed'],
        cancelled: ['cancelled'],
        handled: ['handled'],
      };
      if (!allowed[old.status].includes(status)) throw new HostError('TURN_TRANSITION_INVALID');
      const next = stateValidator.parse({
        ...old,
        ...patch,
        status,
        updatedAt: new Date().toISOString(),
      });
      if (status === 'completed' && !next.report) throw new HostError('REPORT_REQUIRED');
      if (next.report) {
        const request = [...this.#acceptances.values()].find(
          (a) => a.request.turnId === turnId,
        )?.request;
        if (
          !request ||
          next.report.investigationId !== request.investigationId ||
          next.report.turnId !== turnId ||
          next.report.targetId !== request.scope.target.targetId
        )
          throw new HostError('REPORT_SCOPE_INVALID');
      }
      await this.publish(this.file('turns', turnId), next, false);
      this.#states.set(turnId, next);
      return next;
    });
  }
  async saveEvidence(input: Evidence, signal: AbortSignal): Promise<void> {
    const evidence = validators.evidence.parse(input);
    signal.throwIfAborted();
    if (this.turn(evidence.turnId).status !== 'running') throw new HostError('TURN_NOT_RUNNING');
    await this.mutate(async () => {
      signal.throwIfAborted();
      if (this.turn(evidence.turnId).status !== 'running') throw new HostError('TURN_NOT_RUNNING');
      const acceptance = [...this.#acceptances.values()].find(
        (a) => a.request.turnId === evidence.turnId,
      );
      if (
        !acceptance ||
        acceptance.request.investigationId !== evidence.investigationId ||
        acceptance.request.scope.target.targetId !== evidence.targetId
      )
        throw new HostError('EVIDENCE_SCOPE_INVALID');
      const old = this.#evidence.get(evidence.id);
      if (old && fingerprint(old) !== fingerprint(evidence))
        throw new HostError('EVIDENCE_ID_CONFLICT');
      await this.publish(this.file('evidence', evidence.id), evidence, true);
      this.#evidence.set(evidence.id, evidence);
    });
  }
  async evidence(turnId: string): Promise<readonly Evidence[]> {
    return Object.freeze(
      [...this.#evidence.values()].filter((evidence) => evidence.turnId === turnId),
    );
  }
  async saveDelivery(input: Delivery): Promise<Delivery> {
    const delivery = deliveryValidator.parse({ ...input, updatedAt: new Date().toISOString() });
    if (delivery.id !== delivery.message.idempotencyKey) throw new HostError('DELIVERY_ID_INVALID');
    if (
      (delivery.status === 'sent' && !delivery.receipt) ||
      (delivery.receipt &&
        fingerprint(delivery.receipt.address) !== fingerprint(delivery.message.address))
    )
      throw new HostError('DELIVERY_RECEIPT_INVALID');
    this.checkOutbound(delivery.message);
    return this.mutate(async () => {
      const old = this.#deliveries.get(delivery.id);
      if (
        old &&
        (fingerprint(old.message) !== fingerprint(delivery.message) ||
          (old.status === 'sent' &&
            (delivery.status !== 'sent' ||
              !delivery.receipt ||
              fingerprint(old.receipt) !== fingerprint(delivery.receipt))))
      )
        throw new HostError('DELIVERY_ID_CONFLICT');
      await this.publish(this.file('deliveries', delivery.id), delivery, false);
      this.#deliveries.set(delivery.id, delivery);
      return delivery;
    });
  }
  /** Delete whole inactive investigations, with a small durable plan for interrupted cleanup. */
  async prune(
    cutoff: number,
    protectedIds: ReadonlySet<string>,
  ): Promise<readonly ExpiredInvestigation[]> {
    return this.mutate(async () => {
      const grouped = new Map<string, Acceptance[]>();
      for (const a of this.#acceptances.values()) {
        const id = a.request.investigationId;
        const history = grouped.get(id) ?? [];
        history.push(a);
        grouped.set(id, history);
      }
      for (const [id, history] of grouped) {
        if (protectedIds.has(id) || this.#pruning.has(id)) continue;
        const states = history.map((a) => this.turn(a.request.turnId));
        const deliveries = [...this.#deliveries.values()].filter(
          (d) => d.message.reference?.investigationId === id,
        );
        if (
          states.some((s) => ['queued', 'running', 'interrupted'].includes(s.status)) ||
          deliveries.some((d) => d.status !== 'sent') ||
          Math.max(
            ...history.map((a) => Date.parse(a.acceptedAt)),
            ...states.map((s) => Date.parse(s.updatedAt)),
            ...deliveries.map((d) => Date.parse(d.updatedAt)),
          ) >= cutoff
        )
          continue;
        const plan: PrunePlan = {
          version: 1,
          investigationId: id,
          accepted: history.map((a) => a.key),
          turns: states.map((s) => s.turnId),
          evidence: [...this.#evidence.values()]
            .filter((e) => e.investigationId === id)
            .map((e) => e.id),
          deliveries: deliveries.map((d) => d.id),
          outputs: [...this.#outputs.values()]
            .filter((o) => o.messages.some((m) => m.reference?.investigationId === id))
            .map((o) => o.id),
          sessions: history.flatMap((a) => {
            const handle = this.turn(a.request.turnId).sessionHandle;
            return handle === undefined
              ? []
              : [
                  {
                    instanceId: a.request.scope.target.engine.instanceId,
                    pluginId: a.request.scope.target.engine.pluginId,
                    handle,
                  },
                ];
          }),
        };
        await this.publish(this.file('pruning', id), plan, true);
        this.#pruning.set(id, plan);
        await this.commitProbe?.('prune-planned');
      }
      const plans = [...this.#pruning.values()];
      for (const plan of plans) {
        await this.removeRecords(plan);
        for (const key of plan.accepted) this.#acceptances.delete(key);
        for (const key of plan.turns) this.#states.delete(key);
        for (const key of plan.evidence) this.#evidence.delete(key);
        for (const key of plan.deliveries) this.#deliveries.delete(key);
        for (const key of plan.outputs) this.#outputs.delete(key);
        await this.commitProbe?.('prune-deleted');
      }
      return plans;
    });
  }
  async finishPruning(investigationIds: readonly string[]): Promise<void> {
    await this.mutate(async () => {
      for (const id of investigationIds) {
        await unlink(this.file('pruning', id)).catch((error) => {
          if (!missing(error)) throw error;
        });
        await syncDirectory(path.join(this.directory, 'pruning'));
        this.#pruning.delete(id);
      }
    });
  }
  private async removeRecords(plan: PrunePlan): Promise<void> {
    try {
      for (const kind of recordKinds) {
        for (const id of plan[kind]) {
          await unlink(this.file(kind, id)).catch((error) => {
            if (!missing(error)) throw error;
          });
          await this.commitProbe?.('prune-file-deleted');
        }
        await syncDirectory(path.join(this.directory, kind));
      }
    } catch (error) {
      this.#poisoned = true;
      throw error;
    }
  }
  async close(): Promise<void> {
    if (this.#closing) {
      await this.#queue.idle();
      return;
    }
    this.#closing = true;
    await this.#queue.idle();
    try {
      native.unlock(this.lock.fd);
    } finally {
      await this.lock.close();
    }
  }
}
