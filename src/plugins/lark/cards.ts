import type {
  ChannelReply,
  InvestigationReply,
  JsonObject,
  RenderedMessage,
} from '../../plugin-api/index.js';
import { chunks } from '../../core/reports.js';
import { HostError } from '../../core/errors.js';
import { larkHelp } from './help.js';
import {
  actionLabels,
  escapeText as escape,
  failureCopy,
  noticeCopy,
  replyCopy,
  stateLabels,
} from './copy.js';

type Section = { kind: 'body' | 'details' | 'help' | 'hint' | 'diagnostics'; text: string };

function diagnostic(code: string): string {
  return `诊断代码：\`${escape(code).replaceAll('\\_', '_')}\``;
}

function sections(reply: InvestigationReply): Section[] {
  const aliases = new Map<string, string>();
  const report = reply.report;
  const body: string[] = [];
  if (report) {
    const claims = (items: typeof report.facts) =>
      items
        .map((claim) => {
          const references = claim.evidenceIds.map((id) => {
            if (!aliases.has(id)) aliases.set(id, `E${aliases.size + 1}`);
            return aliases.get(id)!;
          });
          return `• ${escape(claim.text)}${references.length ? `  \`${references.join(' · ')}\`` : ''}`;
        })
        .join('\n');
    for (const [title, content] of [
      ['已确认事实', claims(report.facts)],
      ['疑似原因', claims(report.hypotheses)],
      ['处理建议', report.recommendations.map((text) => `• ${escape(text)}`).join('\n')],
      ['待补充证据', report.missingEvidence.map((text) => `• ${escape(text)}`).join('\n')],
    ])
      if (content) body.push(`**${title}**\n${content}`);
  } else {
    body.push(replyCopy(reply).body);
  }
  const details = [
    `调查编号：${reply.reference.investigationId}`,
    `轮次编号：${reply.reference.turnId}`,
    ...(reply.sequence ? [`请求序号：${reply.sequence}`] : []),
    ...(reply.failure ? [diagnostic(reply.failure.code)] : []),
    ...(reply.turns ?? []).map(
      (turn) =>
        `${turn.action ? actionLabels[turn.action] : `第 ${turn.sequence} 轮排查`}：${stateLabels[turn.status]}\n轮次编号：${turn.turnId}${turn.failureCode ? `\n原因：${failureCopy(turn.failureCode, turn.status).title}\n${diagnostic(turn.failureCode)}` : ''}`,
    ),
    ...(reply.usage
      ? [
          `Token 用量：输入 ${reply.usage.inputTokens.toLocaleString('en-US')} · 输出 ${reply.usage.outputTokens.toLocaleString('en-US')}${reply.usage.complete ? '' : '（未完整确认）'}`,
        ]
      : []),
    ...[...aliases].map(([id, alias]) => `${alias}：${escape(id)}`),
  ];
  return [
    { kind: 'body', text: body.join('\n\n') || '本轮暂未确认可报告的结论。' },
    { kind: 'details', text: details.join('\n') },
    { kind: 'help', text: larkHelp(reply.reference) },
    { kind: 'hint', text: '回复此卡片并 @机器人，可继续追问。' },
  ];
}

function panel(title: string, content: string): JsonObject {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: title },
    },
    elements: [{ tag: 'markdown', content }],
  };
}

/** Pure pagination. The exact card is persisted, including folded metadata and help. */
export function renderLarkReply(
  reply: ChannelReply,
  maxTextBytes: number,
): readonly RenderedMessage[] {
  const copy = reply.kind === 'notice' ? noticeCopy(reply) : replyCopy(reply);
  const content: Section[] =
    reply.kind === 'notice'
      ? [
          { kind: 'body', text: copy.body },
          ...(reply.notice.code === 'TARGET_REQUIRED'
            ? []
            : [{ kind: 'diagnostics' as const, text: diagnostic(reply.notice.code) }]),
        ]
      : sections(reply);
  for (let budget = Math.min(maxTextBytes, 6000); budget >= 4; budget = Math.floor(budget / 2)) {
    const pages: Section[][] = [[]];
    let used = 0;
    for (const section of content)
      for (const text of chunks(section.text, budget)) {
        const size = Buffer.byteLength(text);
        if (used && used + 2 + size > budget) {
          pages.push([]);
          used = 0;
        }
        pages[pages.length - 1]!.push({ ...section, text });
        used += (used ? 2 : 0) + size;
      }
    const result = pages.map((page, index) => {
      const title = `${copy.title}${reply.kind === 'notice' ? '' : ` · ${reply.targetId} · ${reply.reference.investigationId.slice(0, 8)}`}${pages.length > 1 ? ` · ${index + 1}/${pages.length}` : ''}`;
      const elements = page.map((section): JsonObject => {
        if (section.kind === 'details') return panel('调查详情', section.text);
        if (section.kind === 'help') return panel('操作指引', section.text);
        if (section.kind === 'diagnostics') return panel('诊断信息', section.text);
        return {
          tag: 'markdown',
          content: section.text,
          ...(section.kind === 'hint' ? { text_size: 'notation' } : {}),
        };
      });
      return {
        text: page.map((section) => section.text).join('\n\n'),
        payload: {
          schema: '2.0',
          config: { update_multi: true },
          header: {
            template: copy.template,
            title: { tag: 'plain_text', content: title },
          },
          body: { elements },
        },
      };
    });
    // Include JSON-string encoding overhead, UUID and destination in the request budget.
    if (
      result.every(
        (message) =>
          Buffer.byteLength(
            JSON.stringify({
              receive_id: 'x'.repeat(128),
              msg_type: 'interactive',
              uuid: 'x'.repeat(48),
              content: JSON.stringify(message.payload),
            }),
          ) <= 28000,
      )
    )
      return result;
  }
  throw new HostError('LARK_CARD_TOO_LARGE');
}
