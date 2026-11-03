import { randomUUID } from 'node:crypto';
import reportRepairPrompt from '../generated/prompts/report-repair.js';
import { ContractError, validators } from '../plugin-api/index.js';
import type {
  AgentSession,
  ChannelMessage,
  ChannelReply,
  InvestigationReply,
  Evidence,
  InvestigationReport,
  EngineSessionOptions,
  InvestigationRequest,
  MessageHandlingResult,
  MessageReception,
  Principal,
} from '../plugin-api/index.js';
import { PluginHost } from './host.js';
import { HostError, TargetSelectionRequired } from './errors.js';
import { fingerprint, messageKey } from './identity.js';
import { InvestigationStore } from './store.js';
import { InvestigationReader } from './investigations.js';
import type { Acceptance, Delivery } from './store.js';
import { SerialQueue } from './serial.js';
import { Semaphore } from './semaphore.js';
import { ToolRound } from './tool-round.js';
import { withDeadline } from './lifecycle.js';
import { chunks, redactReport, reportText, validateReport } from './reports.js';

export class InvestigationCoordinator {
  readonly #accept = new SerialQueue();
  readonly #abort = new AbortController();
  readonly #events = new Map<string, Promise<void>>();
  readonly #wake = new Set<string>();
  readonly #active = new Map<string, AbortController>();
  readonly #sending = new Map<string, Promise<void>>();
  readonly #global: Semaphore;
  readonly #targets = new Map<string, Semaphore>();
  readonly metrics = {
    turns: 0,
    queueMilliseconds: 0,
    running: 0,
    peakRunning: 0,
    calls: 0,
    returnedBytes: 0,
    queryMilliseconds: 0,
    unavailableSources: 0,
    prunedInvestigations: 0,
  };
  #closed = false;
  #closeOperation: Promise<void> | undefined;
  #retentionTimer: ReturnType<typeof setInterval> | undefined;
  #retention: Promise<number> | undefined;
  constructor(
    readonly host: PluginHost,
    readonly store: InvestigationStore,
  ) {
    this.#global = new Semaphore(host.runtime.globalConcurrency);
  }

  async start(): Promise<void> {
    if (this.#closed) return;
    await this.reconcile();
    if (this.#closed) return;
    const investigations = new InvestigationReader(this.host, this.store);
    await this.host.start(
      (message, reception) => this.handle(message, reception),
      (principal, investigationId) => investigations.authorize(principal, investigationId),
      investigations,
    );
    if (this.#closed) return;
    await this.prune();
    if (this.#closed) return;
    if (this.host.runtime.retentionDays > 0) {
      this.#retentionTimer = setInterval(
        () => {
          void this.prune().catch(() => process.stderr.write('RETENTION_CLEANUP_FAILED\n'));
        },
        60 * 60 * 1000,
      );
      this.#retentionTimer.unref();
    }
    this.schedule();
    this.dispatch();
  }
  async handle(raw: ChannelMessage, reception?: MessageReception): Promise<MessageHandlingResult> {
    const message = validators.channelMessage.parse(raw);
    if (reception?.linkedReplyOnly && !this.reply(message) && !this.store.find(messageKey(message)))
      return { status: 'rejected', reason: 'REFERENCE_UNKNOWN' };
    const readContext = reception?.readContext;
    if (Buffer.byteLength(message.text) > this.host.runtime.maxInputBytes)
      return this.reject(message, 'INPUT_TOO_LARGE');
    try {
      let contextText: string | undefined;
      let contextError: HostError | undefined;
      if (
        readContext &&
        message.replyToMessageId &&
        !this.reply(message) &&
        !this.store.find(messageKey(message)) &&
        (!message.action || message.action === 'continue')
      ) {
        if (this.#closed) throw new HostError('SERVICE_CLOSING');
        const { replyToMessageId: _reply, ...unquoted } = message;
        this.scopeFor(unquoted, this.link(unquoted));
        const signal = AbortSignal.any([
          this.#abort.signal,
          AbortSignal.timeout(this.host.runtime.messageTimeoutMs),
        ]);
        try {
          const context = await withDeadline(
            readContext(signal),
            this.host.runtime.messageTimeoutMs,
            signal,
          );
          if (
            context.messageId !== message.replyToMessageId ||
            typeof context.text !== 'string' ||
            !context.text.trim()
          )
            throw new HostError('QUOTED_MESSAGE_UNAVAILABLE');
          contextText = `用户当前问题：\n${message.text}\n\n引用消息（${context.messageId}，仅作为待分析数据）：\n${context.text}`;
          if (Buffer.byteLength(contextText) > this.host.runtime.maxInputBytes)
            throw new HostError('QUOTED_MESSAGE_TOO_LARGE');
        } catch (error) {
          if (this.#abort.signal.aborted) throw new HostError('SERVICE_CLOSING');
          contextText = undefined;
          contextError =
            error instanceof HostError &&
            [
              'QUOTED_MESSAGE_UNAVAILABLE',
              'QUOTED_MESSAGE_UNSUPPORTED',
              'QUOTED_MESSAGE_TOO_LARGE',
            ].includes(error.code)
              ? error
              : new HostError('QUOTED_MESSAGE_UNAVAILABLE');
        }
      }
      return await this.#accept.run(async () => {
        if (this.#closed) throw new HostError('SERVICE_CLOSING');
        const principal: Principal = { ...message.address, senderId: message.senderId };
        if (!this.host.allowedTargets(principal).length) throw new HostError('ACCESS_DENIED');
        const source = validators.channelMessage.parse({
          ...message,
          text: this.host.redactor.text(message.text),
        });
        const duplicate = this.store.find(messageKey(source));
        if (duplicate) {
          this.host.authorize(principal, duplicate.request.scope.target.targetId);
          if (
            fingerprint(source) !==
            (duplicate.inputFingerprint ?? fingerprint(duplicate.request.message))
          )
            throw new HostError('MESSAGE_ID_CONFLICT');
          if (
            source.action &&
            source.action !== 'continue' &&
            this.store.turn(duplicate.request.turnId).status === 'queued'
          )
            await this.control(duplicate, true);
          await this.acceptedMessage(duplicate);
          this.schedule();
          this.dispatch();
          return {
            status: 'accepted',
            investigationId: duplicate.request.investigationId,
            turnId: duplicate.request.turnId,
          };
        }
        const knownReply = this.reply(message);
        if (contextError && !knownReply) throw contextError;
        const enriched = contextText !== undefined && !knownReply;
        const sanitized = !enriched
          ? source
          : validators.channelMessage.parse({
              ...source,
              text: this.host.redactor.text(contextText!),
            });
        const linked = this.link(message, enriched);
        const scope = this.scopeFor(message, linked);
        if (message.action && !linked) throw new HostError('EVENT_REQUIRED');
        const linkedHistory = linked ? this.history(linked.request.investigationId) : [];
        const immediateControl = message.action !== undefined && message.action !== 'continue';
        const unblocksQueued =
          message.action === 'continue' &&
          linkedHistory.some(
            (a) =>
              this.store.turn(a.request.turnId).status === 'interrupted' &&
              linkedHistory.some(
                (later) =>
                  later.sequence > a.sequence &&
                  !later.request.message.action &&
                  this.store.turn(later.request.turnId).status === 'queued',
              ),
          ) &&
          !linkedHistory.some(
            (a) =>
              a.request.message.action === 'continue' &&
              this.store.turn(a.request.turnId).status === 'queued',
          );
        if (
          !immediateControl &&
          !unblocksQueued &&
          this.store
            .acceptances()
            .filter((a) => this.store.turn(a.request.turnId).status === 'queued').length >=
            this.host.runtime.maxQueuedTurns
        )
          throw new HostError('QUEUE_FULL');
        const investigationId = linked?.request.investigationId ?? randomUUID();
        const history = this.history(investigationId);
        const acceptance = await this.store.accept({
          version: 1,
          key: messageKey(sanitized),
          acceptedAt: new Date().toISOString(),
          ...(!enriched ? {} : { inputFingerprint: fingerprint(source) }),
          sequence: history.length + 1,
          request: { investigationId, turnId: randomUUID(), scope, message: sanitized },
        });
        if (message.action && message.action !== 'continue') await this.control(acceptance);
        await this.acceptedMessage(acceptance);
        this.schedule();
        this.dispatch();
        return { status: 'accepted', investigationId, turnId: acceptance.request.turnId };
      });
    } catch (error) {
      if (error instanceof TargetSelectionRequired)
        return this.reject(
          message,
          `TARGET_REQUIRED: 请使用 /target <${error.targetIds.join('|')}> 加完整原始日志重新发送。`,
          { code: 'TARGET_REQUIRED', targets: error.targetIds },
        );
      if (
        error instanceof HostError &&
        [
          'ACCESS_DENIED',
          'TARGET_CONFLICT',
          'EVENT_NOT_FOUND',
          'REFERENCE_UNKNOWN',
          'REFERENCE_CONFLICT',
          'TARGET_SCOPE_CHANGED',
          'EVENT_REQUIRED',
          'MESSAGE_ID_CONFLICT',
          'QUEUE_FULL',
          'QUOTED_MESSAGE_UNAVAILABLE',
          'QUOTED_MESSAGE_UNSUPPORTED',
          'QUOTED_MESSAGE_TOO_LARGE',
        ].includes(error.code)
      )
        return this.reject(message, error.code);
      throw error; // Persistence failures must remain retryable at the transport boundary.
    }
  }
  private history(id: string): readonly Acceptance[] {
    return this.store
      .acceptances()
      .filter((a) => a.request.investigationId === id)
      .sort((a, b) => a.sequence - b.sequence);
  }
  private scopeFor(message: ChannelMessage, linked?: Acceptance) {
    const principal: Principal = { ...message.address, senderId: message.senderId };
    if (linked) {
      if (message.targetId && message.targetId !== linked.request.scope.target.targetId)
        throw new HostError('TARGET_CONFLICT');
      if (message.action && message.action !== 'continue') {
        this.host.authorize(principal, linked.request.scope.target.targetId);
        return { principal, target: linked.request.scope.target };
      }
      return this.host.restore(principal, linked.request.scope.target);
    }
    return this.host.authorize(principal, message.targetId);
  }
  private reply(message: ChannelMessage): Acceptance | undefined {
    let reply: Acceptance | undefined;
    if (message.replyToMessageId) {
      reply = this.store
        .acceptances()
        .find(
          (a) =>
            fingerprint(a.request.message.address) === fingerprint(message.address) &&
            a.request.message.messageId === message.replyToMessageId,
        );
      if (!reply) {
        const sent = this.store
          .deliveries()
          .find(
            (d) =>
              fingerprint(d.message.address) === fingerprint(message.address) &&
              d.receipt?.messageIds.includes(message.replyToMessageId!),
          );
        if (sent?.message.reference)
          reply = this.history(sent.message.reference.investigationId)[0];
      }
    }
    return reply;
  }
  private link(message: ChannelMessage, hasContext = false): Acceptance | undefined {
    const reply = this.reply(message);
    if (message.replyToMessageId && !reply && !message.investigationId && !hasContext)
      throw new HostError('REFERENCE_UNKNOWN');
    const explicit = message.investigationId ? this.history(message.investigationId)[0] : undefined;
    if (message.investigationId && !explicit) throw new HostError('EVENT_NOT_FOUND');
    if (reply && explicit && reply.request.investigationId !== explicit.request.investigationId)
      throw new HostError('REFERENCE_CONFLICT');
    return explicit ?? reply;
  }
  private async reject(
    message: ChannelMessage,
    reason: string,
    notice: Extract<ChannelReply, { kind: 'notice' }>['notice'] = { code: reason },
  ): Promise<MessageHandlingResult> {
    // No investigation exists; source-local refusal contains no target data unless authorized above.
    const channel = this.host.channelFor(message.address.channelInstanceId);
    const parts = channel.renderReply
      ? channel.renderReply(
          { kind: 'notice', text: this.host.redactor.text(reason), notice },
          this.host.runtime.maxMessageBytes,
        )
      : chunks(reason, this.host.runtime.maxMessageBytes).map((text) => ({ text }));
    const messages = parts.map((part, index) => {
      const output = validators.outboundMessage.parse({
        address: message.address,
        replyToMessageId: message.messageId,
        text: part.text,
        ...('payload' in part && part.payload ? { payload: part.payload } : {}),
        idempotencyKey: fingerprint(['reject', messageKey(message), reason, index]),
      });
      if (Buffer.byteLength(output.text) > this.host.runtime.maxMessageBytes)
        throw new HostError('CHANNEL_MESSAGE_TOO_LARGE');
      return output;
    });
    for (const output of messages)
      await withDeadline(channel.send(output), this.host.runtime.messageTimeoutMs).catch(() => {});
    return { status: 'rejected', reason };
  }
  private async control(command: Acceptance, recovered = false): Promise<void> {
    const message = command.request.message;
    const history = this.history(command.request.investigationId).filter(
      (a) => a.sequence < command.sequence,
    );
    let affectedTurns = 0,
      retriedMessages = 0;
    let remoteStatus: 'unknown' | undefined;
    if (message.action === 'cancel') {
      for (const a of history) {
        const status = this.store.turn(a.request.turnId).status;
        if (status === 'queued' || status === 'interrupted' || status === 'running') {
          await this.store.setTurn(a.request.turnId, 'cancelled', { failure: 'USER_CANCELLED' });
          affectedTurns++;
          if (status === 'running' || status === 'interrupted') remoteStatus = 'unknown';
        }
      }
      this.#active.get(command.request.investigationId)?.abort(new HostError('USER_CANCELLED'));
    }
    if (message.action === 'retry-delivery') {
      const turns = new Set(history.map((a) => a.request.turnId));
      for (const delivery of this.store
        .deliveries()
        .filter(
          (d) =>
            turns.has(d.message.reference?.turnId ?? '') &&
            d.status !== 'sent' &&
            !this.#sending.has(d.id),
        )) {
        await this.store.saveDelivery({ ...delivery, status: 'pending', attempts: 0 });
        retriedMessages++;
      }
    }
    const text = history
      .map((a) => `${a.sequence}: ${a.request.turnId} ${this.store.turn(a.request.turnId).status}`)
      .join('\n');
    await this.enqueue(command.request, 'status', text || '暂无已执行轮次。', {
      turns: history.map((a) => {
        const state = this.store.turn(a.request.turnId);
        return {
          sequence: a.sequence,
          turnId: a.request.turnId,
          status: state.status,
          ...(a.request.message.action ? { action: a.request.message.action } : {}),
          ...(state.failure ? { failureCode: state.failure } : {}),
        };
      }),
      effect:
        message.action === 'cancel'
          ? {
              ...(recovered ? { outcome: 'uncertain' } : { affectedTurns }),
              ...(remoteStatus ? { remoteStatus } : {}),
            }
          : message.action === 'retry-delivery'
            ? recovered
              ? { outcome: 'uncertain' }
              : { retriedMessages }
            : {},
    });
    await this.store.setTurn(command.request.turnId, 'handled');
    this.dispatch();
  }
  private async acceptedMessage(record: Acceptance): Promise<void> {
    if (record.request.message.action && record.request.message.action !== 'continue') return;
    await this.enqueue(
      record.request,
      'accepted',
      `已受理，第 ${record.sequence} 轮。追问请回复此消息，或使用 /event ${record.request.investigationId} 加问题。`,
      { sequence: record.sequence },
    );
  }
  private schedule(): void {
    if (this.#closed) return;
    for (const id of new Set(this.store.acceptances().map((a) => a.request.investigationId))) {
      if (this.#events.has(id)) {
        this.#wake.add(id);
        continue;
      }
      const pending = this.history(id).find((a) =>
        ['queued', 'interrupted'].includes(this.store.turn(a.request.turnId).status),
      );
      if (
        !pending ||
        (this.store.turn(pending.request.turnId).status === 'interrupted' &&
          !this.history(id).some(
            (a) =>
              a.sequence > pending.sequence &&
              a.request.message.action === 'continue' &&
              this.store.turn(a.request.turnId).status === 'queued',
          ))
      )
        continue;
      // Schedule after acceptance returns, without keeping the transport callback open.
      const work = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.runEvent(id))
        .catch(() => {})
        .finally(() => {
          this.#events.delete(id);
          if (this.#wake.delete(id)) this.schedule();
        });
      this.#events.set(id, work);
    }
  }
  private async runEvent(id: string): Promise<void> {
    while (!this.#closed) {
      const history = this.history(id);
      const next = history.find((a) =>
        ['queued', 'interrupted'].includes(this.store.turn(a.request.turnId).status),
      );
      if (!next) return;
      if (next.request.message.action && next.request.message.action !== 'continue') return;
      if (this.store.turn(next.request.turnId).status === 'interrupted') {
        if (
          !history.some(
            (a) =>
              a.sequence > next.sequence &&
              a.request.message.action === 'continue' &&
              this.store.turn(a.request.turnId).status === 'queued',
          )
        )
          return;
        await this.store.setTurn(next.request.turnId, 'failed', {
          failure: 'INTERRUPTED_EXPLICITLY_CONTINUED',
        });
        continue;
      }
      await this.run(next);
    }
  }
  private async run(acceptance: Acceptance): Promise<void> {
    const { request } = acceptance;
    const abort = new AbortController();
    this.#active.set(request.investigationId, abort);
    const signal = AbortSignal.any([
      this.#abort.signal,
      abort.signal,
      AbortSignal.timeout(this.host.runtime.turnTimeoutMs),
    ]);
    let releaseGlobal: (() => void) | undefined;
    let releaseTarget: (() => void) | undefined;
    let session: AgentSession | undefined;
    let round: ToolRound | undefined;
    let started = false;
    try {
      const targetId = request.scope.target.targetId;
      let semaphore = this.#targets.get(targetId);
      if (!semaphore) {
        semaphore = new Semaphore(this.host.runtime.targetConcurrency);
        this.#targets.set(targetId, semaphore);
      }
      releaseTarget = await semaphore.acquire(signal);
      releaseGlobal = await this.#global.acquire(signal);
      if (this.store.turn(request.turnId).status !== 'queued') return;
      this.host.validateTarget(request.scope.target);
      await this.store.setTurn(request.turnId, 'running');
      started = true;
      this.metrics.turns++;
      this.metrics.queueMilliseconds += Date.now() - Date.parse(acceptance.acceptedAt);
      this.metrics.running++;
      this.metrics.peakRunning = Math.max(this.metrics.peakRunning, this.metrics.running);
      await this.store.saveEvidence(
        {
          id: 'input-' + request.turnId,
          investigationId: request.investigationId,
          turnId: request.turnId,
          targetId,
          providerInstanceId: 'input',
          toolName: 'user_log',
          parameters: {},
          resources: [],
          observedAt: acceptance.acceptedAt,
          status: 'ok',
          content: request.message.text,
          truncated: false,
        },
        signal,
      );
      round = new ToolRound(request, this.store, this.host.redactor, this.host.runtime, signal);
      await round.open(this.host.toolsFor(request.scope.target));
      let report: InvestigationReport | undefined;
      const engine = this.host.engineFor(request.scope.target);
      if (!round.tools.length && !engine.supportsNativeTools) {
        report = {
          investigationId: request.investigationId,
          turnId: request.turnId,
          targetId,
          facts: [],
          hypotheses: [],
          recommendations: ['恢复数据源连接后继续调查。'],
          missingEvidence: ['所有数据源不可用，未确认根因。', ...round.unavailable],
        };
      } else {
        const history = await this.engineHistory(acceptance);
        const currentRound = round;
        const options: EngineSessionOptions = {
          scope: request.scope,
          tools: round.tools,
          ...(this.host.runtime.maxModelTokens === undefined
            ? {}
            : { budget: { maxModelTokens: this.host.runtime.maxModelTokens } }),
          history,
          recordEvidence: (observation, callSignal) =>
            currentRound.recordEngineEvidence(observation, callSignal),
        };
        const previous = this.history(request.investigationId)
          .filter((a) => a.sequence < acceptance.sequence)
          .reverse()
          .map((a) => this.store.turn(a.request.turnId))
          .find((s) => s.sessionHandle !== undefined);
        const acquiring =
          previous?.sessionHandle === undefined
            ? engine.createSession(options, signal)
            : engine.resumeSession(previous.sessionHandle, options, signal);
        // If an adapter ignores abort, release its late acquisition independently.
        void acquiring.then(
          (late) => {
            if (signal.aborted) void late.close().catch(() => {});
          },
          () => {},
        );
        session = await withDeadline(acquiring, this.host.runtime.turnTimeoutMs, signal);
        await this.store.setTurn(request.turnId, 'running', { sessionHandle: session.handle });
        for (let attempt = 0; attempt < this.host.runtime.reportAttempts; attempt++) {
          const input =
            attempt === 0
              ? request
              : {
                  ...request,
                  message: {
                    ...request.message,
                    text: reportRepairPrompt,
                  },
                };
          // A new generation makes earlier totals partial until the engine confirms usage.
          // Persist before launching so cancellation or a crash cannot leave complete=true.
          const confirmed = this.store.turn(request.turnId).usage;
          await this.store.setTurn(request.turnId, 'running', {
            usage: {
              inputTokens: confirmed?.inputTokens ?? 0,
              outputTokens: confirmed?.outputTokens ?? 0,
              complete: false,
            },
          });
          const iterator = session.runTurn(input, signal)[Symbol.asyncIterator]();
          try {
            while (true) {
              const event = await withDeadline(
                iterator.next(),
                this.host.runtime.turnTimeoutMs,
                signal,
              );
              signal.throwIfAborted();
              await this.store.setTurn(request.turnId, 'running', {
                sessionHandle: session.handle,
              });
              if (event.done) break;
              const value = validators.engineEvent.parse(event.value);
              if (value.type === 'usage')
                await this.store.setTurn(request.turnId, 'running', { usage: value.usage });
              if (value.type === 'report') {
                const all: Evidence[] = [];
                for (const a of this.history(request.investigationId))
                  all.push(...(await this.store.evidence(a.request.turnId)));
                try {
                  report = redactReport(validateReport(value.report, request, all), (text) =>
                    this.host.redactor.text(text),
                  );
                } catch {
                  report = undefined;
                }
              }
            }
          } catch (error) {
            if (!(error instanceof ContractError)) throw error;
            report = undefined;
          } finally {
            await withDeadline<unknown>(
              iterator.return?.() ?? Promise.resolve(),
              this.host.runtime.cleanupTimeoutMs,
            ).catch(() => {});
          }
          if (report) break;
        }
        if (!report) throw new HostError('REPORT_INVALID');
        if (history.truncated)
          report = validators.report.parse({
            ...report,
            missingEvidence: [...report.missingEvidence, '先前上下文超过本轮上限，未能全部提供。'],
          });
      }
      if (round.unavailable.length)
        report = validators.report.parse({
          ...report,
          missingEvidence: [
            ...report.missingEvidence,
            ...round.unavailable.map((id) => `数据源 ${id} 本轮不可用，未能完成该来源取证。`),
          ],
        });
      signal.throwIfAborted();
      // Remote resources must be closed before publishing a completed turn.
      await withDeadline(session?.close() ?? Promise.resolve(), this.host.runtime.cleanupTimeoutMs);
      session = undefined;
      await round.close();
      signal.throwIfAborted();
      await this.store.setTurn(request.turnId, 'completed', { report });
      await this.enqueue(
        request,
        'report',
        reportText(report, this.store.turn(request.turnId).usage),
        {
          report,
          ...(this.store.turn(request.turnId).usage
            ? { usage: this.store.turn(request.turnId).usage! }
            : {}),
        },
      );
      this.dispatch();
    } catch (error) {
      if (!started && !this.#closed && this.store.turn(request.turnId).status === 'queued') {
        await this.store.setTurn(request.turnId, signal.aborted ? 'cancelled' : 'failed', {
          failure: error instanceof HostError ? error.code : 'TURN_START_FAILED',
        });
        await this.failureMessage(acceptance);
        this.dispatch();
      }
      if (started && this.store.turn(request.turnId).status === 'running') {
        const status = this.#closed ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed';
        const code =
          error instanceof HostError
            ? error.code
            : signal.aborted
              ? 'TURN_CANCELLED_OR_TIMEOUT'
              : 'TURN_FAILED';
        await this.store.setTurn(request.turnId, status, {
          ...(session ? { sessionHandle: session.handle } : {}),
          failure: code,
        });
        await this.failureMessage(acceptance).catch(() => {});
        this.dispatch();
      } else if (started && session && this.store.turn(request.turnId).status === 'cancelled') {
        // Control cancellation may win the state race before this execution unwinds.
        await this.store.setTurn(request.turnId, 'cancelled', { sessionHandle: session.handle });
      }
    } finally {
      await Promise.allSettled([
        withDeadline(session?.close() ?? Promise.resolve(), this.host.runtime.cleanupTimeoutMs),
        round?.close() ?? Promise.resolve(),
      ]);
      if (round)
        for (const key of [
          'calls',
          'returnedBytes',
          'queryMilliseconds',
          'unavailableSources',
        ] as const)
          this.metrics[key] += round.metrics[key];
      if (started) this.metrics.running--;
      releaseGlobal?.();
      releaseTarget?.();
      this.#active.delete(request.investigationId);
    }
  }
  private async engineHistory(
    current: Acceptance,
  ): Promise<NonNullable<EngineSessionOptions['history']>> {
    const inputs: Array<{ turnId: string; text: string }> = [];
    const evidence: Evidence[] = [];
    let bytes = 64;
    let truncated = false;
    const previous = this.history(current.request.investigationId).filter(
      (a) => a.sequence < current.sequence,
    );
    const add = (value: unknown) => {
      const size = Buffer.byteLength(JSON.stringify(value)) + 1;
      if (bytes + size > this.host.runtime.maxTotalBytes) {
        truncated = true;
        return false;
      }
      bytes += size;
      return true;
    };
    // Preserve the original trigger first, even if later evidence needs to be omitted.
    for (const record of previous) {
      const input = { turnId: record.request.turnId, text: record.request.message.text };
      if (add(input)) inputs.push(input);
    }
    for (const record of [current, ...[...previous].reverse()])
      for (const item of await this.store.evidence(record.request.turnId))
        if (add(item)) evidence.push(item);
    return { inputs, evidence, truncated };
  }
  private async enqueue(
    request: InvestigationRequest,
    kind: InvestigationReply['kind'],
    text: string,
    details: Omit<InvestigationReply, 'kind' | 'reference' | 'targetId' | 'text'> = {},
  ): Promise<void> {
    const planId = fingerprint([request.turnId, kind]);
    let plan = this.store.output(planId);
    if (!plan) {
      const reference = { investigationId: request.investigationId, turnId: request.turnId };
      let channel;
      try {
        channel = this.host.channelFor(request.message.address.channelInstanceId);
      } catch (error) {
        // Persist a generic delivery plan even without the adapter, so handled controls
        // keep their exact result and can be delivered later without repeating effects.
        if (!(error instanceof HostError) || error.code !== 'CHANNEL_NOT_FOUND') throw error;
      }
      const prefix = `事件 ${request.investigationId}\n轮次 ${request.turnId}\n`;
      const safeReport = details.report
        ? redactReport(details.report, (value) => this.host.redactor.text(value))
        : undefined;
      const reply: InvestigationReply = {
        ...details,
        kind,
        reference,
        targetId: request.scope.target.targetId,
        // Encode citation IDs after redacting prose, as with the structured report.
        text: safeReport ? reportText(safeReport, details.usage) : this.host.redactor.text(text),
        ...(safeReport ? { report: safeReport } : {}),
        ...(request.message.action ? { action: request.message.action } : {}),
      };
      const parts = channel?.renderReply
        ? channel.renderReply(reply, this.host.runtime.maxMessageBytes)
        : chunks(
            reply.text,
            Math.max(4, this.host.runtime.maxMessageBytes - Buffer.byteLength(prefix) - 32),
          ).map((part, index, all) => ({ text: prefix + `[${index + 1}/${all.length}]\n` + part }));
      plan = await this.store.saveOutput({
        version: 1,
        id: planId,
        messages: parts.map((part, index) => {
          // Trusted renderers encode already-redacted business data. Replacing strings
          // inside their protocol payload would corrupt tags, versions and other constants.
          const message = validators.outboundMessage.parse({
            ...part,
            address: request.message.address,
            replyToMessageId: request.message.messageId,
            reference,
            idempotencyKey: fingerprint([request.turnId, kind, index]),
          });
          if (Buffer.byteLength(message.text) > this.host.runtime.maxMessageBytes)
            throw new HostError('CHANNEL_MESSAGE_TOO_LARGE');
          return message;
        }),
      });
    }
    for (const message of plan.messages) {
      const id = message.idempotencyKey;
      if (this.store.deliveries().some((d) => d.id === id)) continue;
      await this.store.saveDelivery({
        version: 1,
        id,
        status: 'pending',
        attempts: 0,
        updatedAt: new Date().toISOString(),
        message,
      });
    }
  }
  private dispatch(): void {
    if (this.#closed) return;
    for (const delivery of this.store.deliveries()) {
      if (
        delivery.status === 'sent' ||
        delivery.status === 'failed' ||
        delivery.attempts >= this.host.runtime.deliveryAttempts ||
        this.#sending.has(delivery.id)
      )
        continue;
      const work = this.deliver(delivery)
        .catch(() => {})
        .finally(() => this.#sending.delete(delivery.id));
      this.#sending.set(delivery.id, work);
    }
  }
  private async deliver(initial: Delivery): Promise<void> {
    let delivery = initial;
    while (!this.#closed && delivery.attempts < this.host.runtime.deliveryAttempts) {
      try {
        const request = this.store
          .acceptances()
          .find((a) => a.request.turnId === delivery.message.reference?.turnId)!.request;
        let channel;
        try {
          channel = this.host.channelFor(delivery.message.address.channelInstanceId);
        } catch (error) {
          if (error instanceof HostError && error.code === 'CHANNEL_NOT_FOUND') return;
          throw error;
        }
        // Delivery remains bound to its original recipient. Current target grants,
        // not execution scope revisions or a retrier's identity, decide whether it may send.
        this.host.authorize(request.scope.principal, request.scope.target.targetId);
        delivery = await this.store.saveDelivery({
          ...delivery,
          status: 'sending',
          attempts: delivery.attempts + 1,
        });
        const receipt = validators.deliveryReceipt.parse(
          await withDeadline(
            channel.send(delivery.message),
            this.host.runtime.messageTimeoutMs,
            this.#abort.signal,
          ),
        );
        await this.store.saveDelivery({ ...delivery, status: 'sent', receipt });
        return;
      } catch (error) {
        if (
          error instanceof HostError &&
          ['ACCESS_DENIED', 'TARGET_SCOPE_CHANGED'].includes(error.code)
        ) {
          await this.store.saveDelivery({ ...delivery, status: 'failed', failure: error.code });
          return;
        }
        // A send error can occur after the platform accepted the message.
        delivery = await this.store.saveDelivery({
          ...delivery,
          status: 'unknown',
          failure: 'DELIVERY_RECEIPT_UNKNOWN',
        });
      }
    }
  }
  private async reconcile(): Promise<void> {
    for (const a of this.store.acceptances())
      if (
        a.request.message.action &&
        a.request.message.action !== 'continue' &&
        this.store.turn(a.request.turnId).status === 'queued'
      ) {
        await this.control(a, true);
      }
    for (const a of this.store.acceptances()) {
      await this.acceptedMessage(a);
      const state = this.store.turn(a.request.turnId);
      if (state.status === 'completed' && state.report)
        await this.enqueue(a.request, 'report', reportText(state.report, state.usage), {
          report: state.report,
          ...(state.usage ? { usage: state.usage } : {}),
        });
      if (state.status === 'failed' || state.status === 'cancelled') await this.failureMessage(a);
      if (state.status === 'interrupted')
        await this.enqueue(
          a.request,
          'interrupted',
          '服务重启后本轮状态不确定。后续输入已暂停。请使用 /continue <事件编号> 明确续接；不会自动重跑原轮。',
          {
            failure: { status: 'interrupted', code: state.failure ?? 'SERVICE_RESTARTED' },
            ...(state.usage ? { usage: state.usage } : {}),
          },
        );
    }
  }
  private async failureMessage(a: Acceptance): Promise<void> {
    const state = this.store.turn(a.request.turnId);
    await this.enqueue(
      a.request,
      'failure',
      `本轮 ${state.status}: ${state.failure ?? 'UNKNOWN'}。已保存的证据可供续接；取消不保证远端查询已终止。`,
      {
        failure: { status: state.status, code: state.failure ?? 'UNKNOWN' },
        ...(state.usage ? { usage: state.usage } : {}),
      },
    );
  }
  async idle(): Promise<void> {
    await this.#accept.idle();
    while (this.#events.size || this.#sending.size) {
      await Promise.all([...this.#events.values(), ...this.#sending.values()]);
    }
  }
  prune(now = Date.now()): Promise<number> {
    if (this.#closed) return Promise.resolve(0);
    this.#retention ??= (async () => {
      const investigations = await this.#accept.run(async () => {
        if (this.#closed) return [];
        const protectedIds = new Set(this.#events.keys());
        for (const delivery of this.store.deliveries())
          if (this.#sending.has(delivery.id) && delivery.message.reference)
            protectedIds.add(delivery.message.reference.investigationId);
        return this.store.prune(
          this.host.runtime.retentionDays === 0
            ? Number.NEGATIVE_INFINITY
            : now - this.host.runtime.retentionDays * 24 * 60 * 60 * 1000,
          protectedIds,
        );
      });
      // Plugin-owned files and native CLI cleanup must not hold the acceptance/store queues.
      if (investigations.length) {
        try {
          await this.host.pruneInvestigations(investigations);
        } catch {
          process.stderr.write('RETENTION_PLUGIN_CLEANUP_FAILED\n');
          return 0; // The durable plans retain plugin references for the next check.
        }
        await this.store.finishPruning(investigations.map((item) => item.investigationId));
        this.metrics.prunedInvestigations += investigations.length;
      }
      return investigations.length;
    })().finally(() => {
      this.#retention = undefined;
    });
    return this.#retention;
  }
  close(): Promise<void> {
    if (this.#closeOperation) return this.#closeOperation;
    this.#closed = true;
    clearInterval(this.#retentionTimer);
    this.#abort.abort();
    this.#closeOperation = (async () => {
      try {
        await this.#retention?.catch(() => {});
        await this.host.close(() => this.idle());
      } finally {
        await this.store.close();
      }
    })();
    return this.#closeOperation;
  }
}
