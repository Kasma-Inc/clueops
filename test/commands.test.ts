import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandEvidence } from '../src/plugins/codex/commands.js';
import type { Evidence } from '../src/plugin-api/index.js';

test('a short command may legitimately print the CLI omission wording without being truncated', async () => {
  const captured: Evidence[] = [];
  const commands = new CommandEvidence('engine', async (observation) => {
    const evidence: Evidence = {
      ...observation.result,
      id: String(captured.length),
      investigationId: 'event',
      turnId: 'turn',
      targetId: 'dev',
      providerInstanceId: 'engine',
      toolName: observation.toolName,
      parameters: observation.parameters,
      observedAt: new Date().toISOString(),
    };
    captured.push(evidence);
    return evidence;
  });
  const signal = new AbortController().signal;
  await commands.observe(
    {
      id: 'command',
      type: 'command_execution',
      command: 'printf',
      status: 'completed',
      exit_code: 0,
      aggregated_output: 'Business output\n... 123 bytes omitted ...\nEND',
    },
    signal,
  );
  await commands.tool!.call({}, signal);
  assert.equal(captured.length, 2);
  assert.ok(captured.every((evidence) => evidence.status === 'ok' && evidence.truncated === false));
});
