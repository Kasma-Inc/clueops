import type {
  ChannelNoticeReply,
  InvestigationReply,
  InvestigationTurnStatus,
} from '../../plugin-api/index.js';

export function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]#]/g, '\\$&');
}

export const stateLabels: Record<InvestigationTurnStatus, string> = {
  queued: '等待排查',
  running: '正在排查',
  completed: '已完成',
  failed: '未完成',
  cancelled: '已取消',
  interrupted: '等待续接',
  handled: '已处理',
};
export const actionLabels = {
  status: '查看进展',
  cancel: '取消排查',
  continue: '继续排查',
  'retry-delivery': '重试发送',
} as const;

const notices: Record<string, readonly [string, string]> = {
  QUOTED_MESSAGE_UNAVAILABLE: [
    '暂时无法读取引用消息',
    '原消息可能已撤回，或机器人缺少消息读取权限。请确认应用权限并重新引用，或复制原文后发送。',
  ],
  QUOTED_MESSAGE_UNSUPPORTED: [
    '这条引用暂不支持读取',
    '目前支持文本、富文本和消息卡片。请将图片或文件中的相关内容复制为文字，再发送给机器人。',
  ],
  QUOTED_MESSAGE_TOO_LARGE: [
    '引用内容有点长',
    '原文与当前问题合并后超过输入上限。请复制报错附近的关键日志，再发起排查。',
  ],
  ACCESS_DENIED: [
    '暂时无法执行此操作',
    '当前账号或群聊没有这次操作所需的权限。请联系维护人员确认访问配置。',
  ],
  TARGET_CONFLICT: [
    '调查环境不一致',
    '追问会沿用原来的排障环境。请回复原调查卡片；如需检查其他环境，请另发一条新请求。',
  ],
  EVENT_NOT_FOUND: ['未找到这次调查', '请确认调查编号，或直接回复机器人之前发出的调查卡片。'],
  REFERENCE_UNKNOWN: [
    '需要关联一次调查',
    '被回复的消息暂时无法关联到调查。请回复对应的调查卡片，或使用 /event 调查编号 你的问题。',
  ],
  REFERENCE_CONFLICT: [
    '调查引用不一致',
    '回复的卡片和正文里的调查编号指向不同调查。请保留一种关联方式后重发。',
  ],
  TARGET_SCOPE_CHANGED: [
    '环境配置已更新',
    '原调查的连接或授权范围已变化。请重新选择环境发起排查，使用当前配置。',
  ],
  EVENT_REQUIRED: [
    '请先指定调查',
    '查看状态、取消和继续等操作需要关联调查。请回复对应的调查卡片，或在指令中补充调查编号。',
  ],
  MESSAGE_ID_CONFLICT: [
    '请发送一条新消息',
    '这条消息的内容与之前受理的记录不同。请重新发送问题，以便单独记录。',
  ],
  QUEUE_FULL: [
    '当前排查任务较多',
    '新问题暂时无法加入队列，请稍后再试。已有调查仍可查看状态或取消。',
  ],
  INPUT_TOO_LARGE: [
    '消息内容有点长',
    '请先发送问题描述和报错附近的关键日志，再通过追问补充其他信息。',
  ],
};

export function noticeCopy(reply: ChannelNoticeReply) {
  if (reply.notice.code === 'TARGET_REQUIRED') {
    const targets = reply.notice.targets ?? [];
    return {
      title: '选择排障环境',
      template: 'blue',
      body: targets.length
        ? '当前可用的环境：\n\n' +
          targets
            .map((id) => `**${escapeText(id)}**\n\`/target ${id} 描述问题或粘贴日志\``)
            .join('\n\n') +
          '\n\n请发送一条新消息，先 @机器人，再使用对应环境的指令。'
        : '当前没有可选择的环境，请联系维护人员确认访问配置。',
    };
  }
  const [title, body] = notices[reply.notice.code] ?? [
    '请求暂时无法处理',
    '请稍后重试；如果仍未恢复，请联系维护人员并提供下方诊断信息。',
  ];
  return { title, body, template: reply.notice.code === 'QUEUE_FULL' ? 'yellow' : 'grey' };
}

const failures: Record<string, readonly [string, string]> = {
  REPORT_INVALID: [
    '报告暂未生成',
    '本轮报告未能通过证据或格式校验。已有证据已保留，可补充信息后继续排查。',
  ],
  CODEX_REPORT_INVALID: ['报告暂未生成', '本轮未取得有效报告。已有证据已保留，可稍后继续排查。'],
  MODEL_TOKEN_BUDGET_EXHAUSTED: [
    '本轮已达用量上限',
    '本轮排查已达到配置的模型用量上限。已有证据已保留，可补充重点问题后继续排查。',
  ],
  MODEL_USAGE_UNKNOWN: [
    '模型用量未能确认',
    '本轮用量记录不完整，排查已停止。请确认模型服务状态后再继续。',
  ],
  MODEL_USAGE_INVALID: [
    '模型用量记录异常',
    '本轮用量记录无法核对，排查已停止。请联系维护人员检查模型服务。',
  ],
  TOOL_BUDGET_EXHAUSTED: [
    '本轮取证已达上限',
    '本轮查询次数或返回量已达到上限。已有证据已保留，可缩小问题范围后继续。',
  ],
  RESULT_BUDGET_EXHAUSTED: [
    '本轮取证已达上限',
    '返回的数据超过本轮限制。请缩小时间、资源或查询范围后继续。',
  ],
  TOOL_BINDING_FAILED: [
    '数据源暂时不可用',
    '连接当前环境的数据源时遇到问题。请确认连接状态后再继续排查。',
  ],
  BACKEND_CLEANUP_UNCONFIRMED: [
    '连接清理状态待确认',
    '工具连接尚未确认释放，本轮未标记为完成。请确认连接状态后再继续。',
  ],
  CODEX_TURN_FAILED: [
    '本轮排查暂未完成',
    '模型服务未能完成本轮请求。已有证据已保留，可稍后继续；持续失败时请联系维护人员。',
  ],
  CODEX_RUNTIME_FAILED: [
    '本轮排查暂未完成',
    '排查引擎暂时未能完成请求。请稍后再试，或联系维护人员检查服务状态。',
  ],
  TURN_START_FAILED: ['排查暂未启动', '本轮未能启动。请确认环境连接和排查引擎状态后重试。'],
  LIFECYCLE_TIMEOUT: [
    '本轮排查等待超时',
    '本轮等待执行或清理超时。已有证据已保留，可稍后继续排查。',
  ],
  TURN_CANCELLED_OR_TIMEOUT: [
    '本轮排查已停止',
    '本轮因取消或超时停止。已有证据已保留，可按需继续排查。',
  ],
  LIFECYCLE_CANCELLED: ['本轮排查已停止', '本轮因取消或超时停止。已有证据已保留，可按需继续排查。'],
};

export function failureCopy(code: string, status?: InvestigationTurnStatus) {
  if (code === 'USER_CANCELLED' || (status === 'cancelled' && code === 'UNKNOWN'))
    return {
      title: '本轮排查已取消',
      body: '本轮已停止继续排查，已有证据和报告已保留。',
      template: 'grey',
    };
  const [title, body] = failures[code] ??
    notices[code] ?? [
      '本轮排查暂未完成',
      '本轮遇到问题，已有证据已保留。可稍后继续；持续失败时请联系维护人员并提供诊断信息。',
    ];
  return { title, body, template: 'red' };
}

export function replyCopy(reply: InvestigationReply) {
  if (reply.kind === 'failure')
    return failureCopy(reply.failure?.code ?? 'UNKNOWN', reply.failure?.status);
  if (reply.kind === 'interrupted')
    return {
      title: '等待继续排查',
      body: '服务重启后，本轮执行结果未能确认，后续问题暂未执行。\n确认后可在“操作指引”中选择继续排查。',
      template: 'yellow',
    };
  if (reply.kind === 'accepted')
    return {
      title: reply.action === 'continue' ? '继续排查已受理' : '排查已受理',
      body:
        reply.action === 'continue'
          ? '已收到续接请求，将按顺序继续本次调查。'
          : '问题已加入排查队列，完成后会在本群回复结果。',
      template: 'blue',
    };
  if (reply.kind === 'status' && reply.action === 'cancel') {
    if (reply.effect?.outcome === 'uncertain')
      return {
        title: '取消请求已恢复处理',
        body: '本次请求此前的执行结果未能完整确认，已继续处理取消。请查看调查进展确认各轮状态；远端查询的结束状态仍待确认。',
        template: 'grey',
      };
    const count = reply.effect?.affectedTurns ?? 0;
    return {
      title: count ? '排查已取消' : '取消请求已处理',
      body: count
        ? `已取消 ${count} 个待处理或进行中的轮次，已有证据和报告已保留。${reply.effect?.remoteStatus === 'unknown' ? '\n远端查询的结束状态仍待确认。' : ''}`
        : '当前没有待取消的轮次，已有排查记录保持不变。',
      template: 'grey',
    };
  }
  if (reply.kind === 'status' && reply.action === 'retry-delivery') {
    if (reply.effect?.outcome === 'uncertain')
      return {
        title: '消息重试请求已恢复处理',
        body: '本次请求此前的重试数量未能完整确认，已继续处理尚未确认送达的消息。本次操作不会重新执行排查。',
        template: 'blue',
      };
    const count = reply.effect?.retriedMessages ?? 0;
    return {
      title: count ? '已安排消息重试' : '暂无待重试消息',
      body: count
        ? `已安排重试 ${count} 条未确认送达的消息，本次操作不会重新执行排查。`
        : '当前没有可以重试的消息。正在发送的消息会继续处理。',
      template: 'blue',
    };
  }
  if (reply.kind === 'status') {
    const turns = reply.turns?.filter((turn) => !turn.action || turn.action === 'continue');
    return {
      title: '调查进展',
      body: turns?.length
        ? `${turns.length > 8 ? `最近 8 轮进展（共 ${turns.length} 轮）：\n` : ''}` +
          turns
            .slice(-8)
            .map((turn) => `• 第 ${turn.sequence} 轮：${stateLabels[turn.status]}`)
            .join('\n')
        : '本次调查暂无排查记录。',
      template: 'blue',
    };
  }
  return { title: '排查结果', body: '', template: 'blue' };
}
