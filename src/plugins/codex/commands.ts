import type { CommandExecutionItem } from '@openai/codex-sdk';
import type {
  BoundDiagnosticTool,
  EngineSessionOptions,
  Evidence,
} from '../../plugin-api/index.js';
import { objectSchema } from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';

/** Captures SDK observations; it never accepts command output supplied by the model. */
export class CommandEvidence {
  readonly #records: Evidence[] = [];
  #pending: Promise<void> = Promise.resolve();
  readonly tool: BoundDiagnosticTool | undefined;

  constructor(
    instanceId: string,
    private readonly record: EngineSessionOptions['recordEvidence'],
  ) {
    if (record)
      this.tool = {
        providerInstanceId: instanceId,
        definition: {
          name: 'local_command_evidence',
          description:
            '读取本轮已捕获的实际本地/SSH命令证据及编号。默认返回最新命令；index为从0开始的命令索引。此工具不执行命令，不接受自报输出。',
          readOnly: true,
          inputSchema: objectSchema({ index: { type: 'integer', minimum: 0 } }, []),
        },
        call: async (args, signal) => {
          await this.#pending;
          signal.throwIfAborted();
          const index = args.index ?? this.#records.length - 1;
          if (!Number.isInteger(index) || typeof index !== 'number' || !this.#records[index])
            throw new HostError('COMMAND_EVIDENCE_NOT_FOUND');
          const source = this.#records[index]!;
          // Reading captured output is also budgeted; its source remains the actual SDK record.
          return record(
            {
              toolName: 'command_evidence',
              parameters: { sourceEvidenceId: source.id },
              result: {
                status: source.status,
                content: source.content,
                resources: source.resources,
                truncated: source.truncated,
                ...(source.failure ? { failure: source.failure } : {}),
                ...(source.timeRange ? { timeRange: source.timeRange } : {}),
              },
            },
            signal,
          );
        },
      };
  }

  async observe(item: CommandExecutionItem, signal: AbortSignal): Promise<void> {
    if (!this.record) return;
    const record = this.record;
    const work = this.#pending.then(async () => {
      signal.throwIfAborted();
      // Pinned CLI capture has no structured truncation flag. A full-size capture with
      // its omission line cannot be treated as complete evidence (even with exitCode 0).
      const incomplete =
        Buffer.byteLength(item.aggregated_output) >= 1024 * 1024 &&
        /(?:^|\n)\.\.\. \d+ bytes omitted \.\.\.(?:\r?\n|$)/.test(item.aggregated_output);
      const ok = item.status === 'completed' && item.exit_code === 0 && !incomplete;
      const evidence = await record(
        {
          toolName: 'command_execution',
          parameters: { command: item.command },
          result: {
            status: ok ? 'ok' : 'error',
            content: {
              output: item.aggregated_output,
              exitCode: item.exit_code ?? null,
              outputCoverage: 'sdk-captured',
            },
            resources: [{ execution: 'local', timeRange: 'unknown' }],
            truncated: incomplete,
            ...(!ok
              ? {
                  failure: {
                    code: incomplete ? 'LOCAL_COMMAND_OUTPUT_INCOMPLETE' : 'LOCAL_COMMAND_FAILED',
                    message: incomplete
                      ? 'SDK捕获的命令输出含省略标记，完整性无法确认。'
                      : '本地命令未成功；SSH等远程动作的状态可能未知。',
                    remoteStatus: 'unknown' as const,
                  },
                }
              : {}),
          },
        },
        signal,
      );
      this.#records.push(evidence);
    });
    this.#pending = work;
    await work;
  }
}
