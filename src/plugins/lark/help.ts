import type { InvestigationReference } from '../../plugin-api/index.js';

export function larkHelp(reference: InvestigationReference): string {
  const id = reference.investigationId;
  return `在本群 @机器人后发送相应指令：
补充问题：/event ${id} 你的问题
查看进展：/status ${id}
取消排查：/cancel ${id}
继续排查：/continue ${id}
重试发送：/retry-delivery ${id}
继续排查时可在指令后补充信息；重试发送只会重发已有消息。`;
}
