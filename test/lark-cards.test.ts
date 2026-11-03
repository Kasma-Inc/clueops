import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ChannelReply,
  JsonObject,
  JsonValue,
  RenderedMessage,
} from '../src/plugin-api/index.js';
import { renderLarkReply } from '../src/plugins/lark/cards.js';
import { Redactor } from '../src/core/redaction.js';

const reference = {
  investigationId: '67f01128-c66f-4fc8-8d01-9fc4f18bef52',
  turnId: 'e7cc5332-52c1-42b1-b92c-5bf41901dfe5',
};
const evidenceId = '3df4e526-33f1-4806-811c-1c89d0092fa3';
const reply: ChannelReply = {
  kind: 'report',
  targetId: 'dev',
  reference,
  text: 'Plain report for other channels',
  report: {
    ...reference,
    targetId: 'dev',
    facts: [{ text: 'SSH 连接与命令执行验证成功，退出码为 0。', evidenceIds: [evidenceId] }],
    hypotheses: [],
    recommendations: [],
    missingEvidence: [],
  },
  usage: { inputTokens: 34459, outputTokens: 389, complete: true },
};

function elements(message: RenderedMessage): JsonObject[] {
  return (message.payload!.body as JsonObject).elements as JsonObject[];
}
function textContent(value: JsonValue): string {
  if (Array.isArray(value)) return value.map(textContent).join('');
  if (typeof value !== 'object' || value === null) return '';
  const object = value as JsonObject;
  return typeof object.content === 'string'
    ? object.content
    : Object.values(object).map(textContent).join('');
}

function visibleText(message: RenderedMessage): string {
  return textContent(elements(message).filter((element) => element.tag !== 'collapsible_panel'));
}

test('all notices offer Chinese guidance and hide diagnostic codes, with target lists only when supplied', () => {
  const codes = [
    'TARGET_REQUIRED',
    'ACCESS_DENIED',
    'TARGET_CONFLICT',
    'EVENT_NOT_FOUND',
    'REFERENCE_UNKNOWN',
    'REFERENCE_CONFLICT',
    'TARGET_SCOPE_CHANGED',
    'EVENT_REQUIRED',
    'MESSAGE_ID_CONFLICT',
    'QUEUE_FULL',
    'INPUT_TOO_LARGE',
    'NEW_INTERNAL_CODE',
  ];
  for (const code of codes) {
    const messages = renderLarkReply(
      {
        kind: 'notice',
        text: 'INTERNAL RAW MESSAGE',
        notice: { code, ...(code === 'TARGET_REQUIRED' ? { targets: ['dev', 'prod'] } : {}) },
      },
      3500,
    );
    const visible = messages.map(visibleText).join('');
    assert.ok(!visible.includes(code));
    assert.ok(!visible.includes('INTERNAL RAW MESSAGE'));
    if (code === 'TARGET_REQUIRED') {
      assert.ok(visible.includes('/target dev 描述问题或粘贴日志'));
      assert.ok(visible.includes('/target prod 描述问题或粘贴日志'));
      assert.ok(visible.includes('新消息'));
      assert.ok(!visible.includes('<dev|prod>'));
    } else {
      assert.ok(!visible.includes('/target dev'));
      assert.ok(JSON.stringify(messages).includes(code));
    }
  }
});

test('investigation lifecycle copy uses structured state and actual control effects', () => {
  const base = {
    reference,
    targetId: 'dev',
    text: 'RAW failed e7cc5332-52c1-42b1-b92c-5bf41901dfe5',
  };
  const status = renderLarkReply(
    {
      ...base,
      kind: 'status',
      action: 'status',
      turns: [
        { sequence: 1, turnId: 'one', status: 'completed' },
        { sequence: 2, turnId: 'control', status: 'handled', action: 'status' },
        { sequence: 3, turnId: 'three', status: 'queued' },
        { sequence: 4, turnId: 'four', status: 'running' },
        { sequence: 5, turnId: 'five', status: 'interrupted' },
      ],
    },
    3500,
  )
    .map(visibleText)
    .join('');
  assert.ok(
    status.includes('已完成') &&
      status.includes('等待排查') &&
      status.includes('正在排查') &&
      status.includes('等待续接'),
  );
  assert.ok(!status.includes('RAW') && !status.includes('e7cc5332') && !status.includes('handled'));
  const emptyStatus = renderLarkReply({ ...base, kind: 'status', turns: [] }, 3500)
    .map(visibleText)
    .join('');
  assert.ok(emptyStatus.includes('暂无排查记录') && !emptyStatus.includes('RAW'));
  const cancel = renderLarkReply(
    {
      ...base,
      kind: 'status',
      action: 'cancel',
      effect: { affectedTurns: 2, remoteStatus: 'unknown' },
    },
    3500,
  )
    .map(visibleText)
    .join('');
  assert.ok(cancel.includes('取消 2 个') && cancel.includes('状态仍待确认'));
  const retry = renderLarkReply(
    { ...base, kind: 'status', action: 'retry-delivery', effect: { retriedMessages: 3 } },
    3500,
  )
    .map(visibleText)
    .join('');
  assert.ok(retry.includes('重试 3 条') && retry.includes('不会重新执行排查'));
  const codes = [
    'REPORT_INVALID',
    'CODEX_REPORT_INVALID',
    'MODEL_TOKEN_BUDGET_EXHAUSTED',
    'MODEL_USAGE_UNKNOWN',
    'MODEL_USAGE_INVALID',
    'TOOL_BUDGET_EXHAUSTED',
    'RESULT_BUDGET_EXHAUSTED',
    'TOOL_BINDING_FAILED',
    'BACKEND_CLEANUP_UNCONFIRMED',
    'CODEX_TURN_FAILED',
    'CODEX_RUNTIME_FAILED',
    'TURN_START_FAILED',
    'LIFECYCLE_TIMEOUT',
    'TURN_CANCELLED_OR_TIMEOUT',
    'LIFECYCLE_CANCELLED',
    'USER_CANCELLED',
    'UNRECOGNIZED_FAILURE',
  ];
  for (const code of codes) {
    const messages = renderLarkReply(
      {
        ...base,
        kind: 'failure',
        failure: { status: code === 'USER_CANCELLED' ? 'cancelled' : 'failed', code },
      },
      3500,
    );
    const visible = messages.map(visibleText).join('');
    assert.ok(!visible.includes('RAW') && !visible.includes(code));
    assert.ok(JSON.stringify(messages).includes(code));
    assert.match(visible, /继续|确认|联系|重试|稍后|缩小|保留/);
  }
  for (const kind of ['accepted', 'interrupted'] as const) {
    const visible = renderLarkReply({ ...base, kind }, 3500)
      .map(visibleText)
      .join('');
    assert.ok(!visible.includes('RAW'));
    assert.ok(visible.includes(kind === 'accepted' ? '排查队列' : '服务重启'));
  }
});

test('compact report hides empty sections and keeps full identities, usage and evidence behind folded panels', () => {
  const messages = renderLarkReply(reply, 3500);
  assert.equal(messages.length, 1);
  const message = messages[0]!;
  assert.deepEqual(
    new Redactor().value(message.payload),
    message.payload,
    'safe presentation fields survive host redaction',
  );
  const visible = elements(message).filter((element) => element.tag !== 'collapsible_panel');
  const body = textContent(visible);
  assert.match(body, /已确认事实/);
  assert.match(body, /SSH 连接与命令执行验证成功/);
  assert.match(body, /E1/);
  assert.match(body, /回复此卡片并 @机器人/);
  assert.ok(!body.includes(reference.investigationId));
  assert.ok(!body.includes(evidenceId));
  assert.ok(!body.includes('Token'));
  for (const empty of ['暂无', '疑似原因', '处理建议', '待补充证据'])
    assert.ok(!body.includes(empty));
  const panels = elements(message).filter((element) => element.tag === 'collapsible_panel');
  assert.equal(panels.length, 2);
  assert.ok(panels.every((panel) => panel.expanded === false));
  const detail = textContent(panels[0]!);
  assert.ok(detail.includes(`E1：${evidenceId}`));
  assert.ok(detail.includes(reference.turnId));
  assert.match(detail, /输入 34,459 · 输出 389/);
  assert.equal((message.payload!.header as JsonObject).template, 'blue');
});

test('model strings cannot inject card markup, mentions, images or disguised links', () => {
  const injected = '<at id=all></at> [click](https://example.invalid) **fake heading** <img src=x>';
  const messages = renderLarkReply(
    {
      ...reply,
      report: { ...reply.report!, facts: [{ text: injected, evidenceIds: [evidenceId] }] },
    },
    3500,
  );
  const content = textContent(messages[0]!.payload!);
  assert.ok(!content.includes('<at'));
  assert.ok(!content.includes('<img'));
  assert.ok(!content.includes('[click]'));
  assert.ok(!content.includes('**fake heading**'));
  assert.ok(content.includes('&lt;at'));
  assert.ok(content.includes(evidenceId));
});

test('long reports and metadata paginate without losing text, duplicating commands or exceeding encoded request budgets', () => {
  const facts = Array.from({ length: 90 }, (_, index) => ({
    text: `事实${index} ` + '长日志🙂\\\u0001'.repeat(40),
    evidenceIds: [`evidence-${index}`],
  }));
  for (const limit of [256, 3500, 16777216]) {
    const messages = renderLarkReply({ ...reply, report: { ...reply.report!, facts } }, limit);
    assert.ok(messages.length > 1);
    const text = messages.map((message) => message.text).join('');
    for (let index = 0; index < 90; index++) {
      assert.equal(text.split(`事实${index} `).length - 1, 1);
      assert.equal(
        [...text.matchAll(/E(\d+)：evidence-(\d+)/g)].filter(
          (match) => match[1] === String(index + 1) && match[2] === String(index),
        ).length,
        1,
      );
    }
    for (const action of ['event', 'status', 'cancel', 'continue', 'retry-delivery'])
      assert.equal(
        messages.filter((message) =>
          message.text.includes(`/${action} ${reference.investigationId}`),
        ).length,
        1,
      );
    assert.equal(text.split('回复此卡片并 @机器人').length - 1, 1);
    for (const [index, message] of messages.entries()) {
      assert.ok(Buffer.byteLength(message.text) <= limit);
      assert.ok(textContent(message.payload!).includes(message.text.split('\n\n')[0]!));
      const title = (message.payload!.header as JsonObject).title as JsonObject;
      assert.ok((title.content as string).endsWith(`${index + 1}/${messages.length}`));
      const request = {
        receive_id: 'x'.repeat(128),
        msg_type: 'interactive',
        uuid: 'x'.repeat(48),
        content: JSON.stringify(message.payload),
      };
      assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 28000);
    }
  }
});
