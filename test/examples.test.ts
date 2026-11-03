import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PluginHost } from '../src/core/index.js';

test('documented configuration loads and scopes the executable fixture', async () => {
  const host = await PluginHost.load(
    fileURLToPath(new URL('../examples/demo/config.yaml', import.meta.url)),
  );
  try {
    const scope = host.authorize(
      {
        channelInstanceId: 'chat',
        tenantId: 'example-tenant',
        conversationId: 'example-room',
        senderId: 'example-user',
      },
      'cluster-a',
    );
    assert.deepEqual(
      scope.target.tools.map((tool) => tool.resources.resourceId),
      ['synthetic-cluster-a'],
    );
    assert.ok(!JSON.stringify(scope).includes('EXAMPLE_ONLY'));
    assert.ok(!JSON.stringify(scope).includes('synthetic-cluster-b'));
  } finally {
    await host.close();
  }
});

test('private configurations are ignored while public examples remain reviewable', async () => {
  const run = promisify(execFile);
  const { stdout } = await run('git', [
    'check-ignore',
    '--no-index',
    'private/probe.yaml',
    '.private/probe.yaml',
  ]);
  assert.deepEqual(stdout.trim().split('\n'), ['private/probe.yaml', '.private/probe.yaml']);
  await assert.rejects(
    run('git', ['check-ignore', '--no-index', 'examples/demo/config.yaml']),
    (error) => (error as { code?: number }).code === 1,
  );
});
