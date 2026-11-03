import { validators } from '../plugin-api/index.js';
import type {
  Evidence,
  InvestigationReport,
  InvestigationRequest,
  ModelUsage,
} from '../plugin-api/index.js';
import { HostError } from './errors.js';

export function validateReport(
  value: unknown,
  request: InvestigationRequest,
  evidence: readonly Evidence[],
): InvestigationReport {
  const report = validators.report.parse(value);
  if (
    report.investigationId !== request.investigationId ||
    report.turnId !== request.turnId ||
    report.targetId !== request.scope.target.targetId
  )
    throw new HostError('REPORT_SCOPE_INVALID');
  const own = new Map(
    evidence
      .filter((e) => e.investigationId === report.investigationId && e.targetId === report.targetId)
      .map((e) => [e.id, e]),
  );
  for (const claim of [...report.facts, ...report.hypotheses]) {
    if (claim.evidenceIds.some((id) => !own.has(id)))
      throw new HostError('REPORT_REFERENCE_INVALID');
  }
  for (const fact of report.facts) {
    if (!fact.evidenceIds.length || fact.evidenceIds.some((id) => own.get(id)!.status !== 'ok'))
      throw new HostError('REPORT_FACT_UNSUPPORTED');
  }
  return report;
}

/** Redact report prose while preserving its already-validated identity and references. */
export function redactReport(
  report: InvestigationReport,
  redact: (text: string) => string,
): InvestigationReport {
  return {
    ...report,
    facts: report.facts.map((claim) => ({ ...claim, text: redact(claim.text) })),
    hypotheses: report.hypotheses.map((claim) => ({ ...claim, text: redact(claim.text) })),
    recommendations: report.recommendations.map(redact),
    missingEvidence: report.missingEvidence.map(redact),
  };
}

export function reportText(report: InvestigationReport, usage?: ModelUsage): string {
  const claims = (items: InvestigationReport['facts']) =>
    items
      .map((c) => `• ${c.text}${c.evidenceIds.length ? ` [${c.evidenceIds.join(', ')}]` : ''}`)
      .join('\n') || '暂无';
  return [
    `事实\n${claims(report.facts)}`,
    `疑似原因\n${claims(report.hypotheses)}`,
    `建议\n${report.recommendations.join('\n') || '暂无'}`,
    `缺失信息\n${report.missingEvidence.join('\n') || '暂无'}`,
    ...(usage
      ? [
          `Token 用量：输入 ${usage.inputTokens}，输出 ${usage.outputTokens}${usage.complete ? '' : '（用量未完整确认）'}`,
        ]
      : []),
  ].join('\n\n');
}

/** Prefer complete lines within the byte limit; split oversized lines only at Unicode code points. */
export function chunks(text: string, bytes: number): string[] {
  if (bytes < 4) throw new HostError('MESSAGE_LIMIT_TOO_SMALL');
  const output: string[] = [];
  let current = '';
  let length = 0;
  let lineBreak = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    while (length + size > bytes) {
      const end = lineBreak || current.length;
      output.push(current.slice(0, end));
      current = current.slice(end);
      length = Buffer.byteLength(current);
      lineBreak = 0;
    }
    current += char;
    length += size;
    if (char === '\n') lineBreak = current.length;
  }
  if (current) output.push(current);
  return output;
}
