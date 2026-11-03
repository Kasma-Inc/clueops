import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify, parse } from 'yaml';
import { PluginHost } from '../../src/core/host.js';
import { builtinPlugins } from '../../src/plugins/catalog.js';
test('complete live templates load all built-ins using inline credentials and default deployment paths', async (t) => {
  let host: PluginHost | undefined;
  t.after(async () => {
    await host?.close();
  });
  const root = await mkdtemp(path.join(tmpdir(), 'incident-live-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.resolve(import.meta.dirname, '../..');
  const directory = path.join(root, 'private');
  await cp(path.join(project, 'examples/live'), directory, { recursive: true });
  await symlink(path.join(project, 'examples'), path.join(root, 'examples'));
  await mkdir(path.join(directory, 'credentials'));
  for (const [id, suffix] of [
    ['prod-a', 'A'],
    ['prod-b', 'B'],
  ] as const)
    await writeFile(
      path.join(directory, 'credentials', id + '.kubeconfig'),
      stringify({
        apiVersion: 'v1',
        kind: 'Config',
        'current-context': 'same',
        contexts: [
          { name: 'REPLACE_CONTEXT_' + suffix, context: { cluster: 'same', user: 'same' } },
        ],
        clusters: [{ name: 'same', cluster: { server: 'https://' + id + '.invalid' } }],
        users: [{ name: 'same', user: { token: 'SYNTHETIC_' + suffix } }],
      }),
    );
  await writeFile(path.join(directory, 'credentials/postgres-ca.pem'), 'SYNTHETIC_CA_PLACEHOLDER');
  const file = path.join(directory, 'config.yaml');
  const global = parse(await readFile(file, 'utf8'));
  global.agent.config.apiKey = 'SYNTHETIC_MODEL_KEY';
  global.channels.lark.config.appSecret = 'SYNTHETIC_LARK_SECRET';
  global.targets['prod-b'] = './targets/prod-b.yaml';
  await writeFile(file, stringify(global));
  host = await PluginHost.load(file, builtinPlugins);
  const principal = {
    channelInstanceId: 'lark',
    tenantId: 'REPLACE_TENANT_KEY',
    conversationId: 'REPLACE_CHAT_ID',
    senderId: 'REPLACE_USER_OPEN_ID',
  };
  const a = host.authorize(principal, 'prod-a');
  const b = host.authorize(principal, 'prod-b');
  assert.equal(a.target.tools.length, 3);
  assert.equal(b.target.tools.length, 1);
  assert.ok(
    a.target.tools.every((p) => !b.target.tools.some((q) => q.instanceId === p.instanceId)),
  );
  assert.ok(!JSON.stringify(a).includes('SYNTHETIC'));
  assert.ok(!JSON.stringify(a).includes('prod-b.invalid'));
  assert.equal(
    host.redactor.text(
      'SYNTHETIC_MODEL_KEY SYNTHETIC_LARK_SECRET REPLACE_DATABASE_PASSWORD REPLACE_GITHUB_TOKEN',
    ),
    '[REDACTED] [REDACTED] [REDACTED] [REDACTED]',
  );
});
