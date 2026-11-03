import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import kubernetes from '../src/plugins/kubernetes/index.js';
import database from '../src/plugins/database/index.js';
import github from '../src/plugins/github/index.js';
import { credential } from '../src/plugins/shared.js';
import { compileContract } from '../src/plugin-api/index.js';

test('GitHub configuration only supplies credentials and deployment settings', () => {
  const parser = compileContract(github.manifest.configSchema, 'GitHub');
  parser.parse({ tokenFile: './github.token' });
  parser.parse({ token: 'SYNTHETIC' });
  assert.throws(() =>
    parser.parse({ token: 'SYNTHETIC', repositories: [{ owner: 'org', repo: 'service' }] }),
  );
});

test('Kubernetes config only selects the connection; obsolete host access policies are rejected', () => {
  const parser = compileContract(kubernetes.manifest.configSchema, 'Kubernetes');
  const connection = { kubeconfig: './cluster.yaml', context: 'target' };
  parser.parse(connection);
  for (const policy of [
    { namespaces: ['default'] },
    { resources: [{ apiVersion: 'v1', kind: 'Pod' }] },
    { maxLogLines: 100 },
    { maxPageRows: 100 },
  ])
    assert.throws(() => parser.parse({ ...connection, ...policy }));
});

test('database password files preserve spaces and remove only one file line ending; tokens still trim', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-password-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registered: string[] = [];
  const context = {
    instanceId: 'db',
    configFile: path.join(root, 'db.yaml'),
    resolvePath: (s: string) => path.resolve(root, s),
    registerSecrets: (values: readonly string[]) => {
      registered.push(...values);
    },
  };
  for (const ending of ['', '\n', '\r\n']) {
    await writeFile(path.join(root, 'password'), ' synthetic password ' + ending);
    const plugin = await database.create(
      {
        backend: { command: process.execPath },
        source: {
          type: 'postgres',
          database: 'db',
          host: 'localhost',
          user: 'reader',
          passwordFile: './password',
        },
      },
      context,
    );
    await plugin.dispose();
    assert.equal(registered.at(-1), ' synthetic password ');
    assert.equal(await credential(undefined, './password', context), 'synthetic password');
  }
});
test('same context/user names in different files remain target-local; missing or duplicate references fail', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-config-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = {
    instanceId: 'source',
    configFile: path.join(root, 'plugin.yaml'),
    resolvePath: (s: string) => path.resolve(root, s),
  };
  const kube = (server: string) => ({
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': 'same',
    contexts: [{ name: 'same', context: { cluster: 'same', user: 'same' } }],
    clusters: [{ name: 'same', cluster: { server } }],
    users: [{ name: 'same', user: { token: 'SYNTHETIC_TOKEN_' + server } }],
  });
  await writeFile(path.join(root, 'a.yaml'), stringify(kube('https://a.invalid')));
  await writeFile(path.join(root, 'b.yaml'), stringify(kube('https://b.invalid')));
  const config = {
    backend: { command: process.execPath },
    resourceId: 'a',
    kubeconfig: './a.yaml',
    context: 'same',
  };
  const a = await kubernetes.create(config, context);
  const b = await kubernetes.create(
    { ...config, resourceId: 'b', kubeconfig: './b.yaml' },
    context,
  );
  assert.equal(a.scope.server, 'https://a.invalid');
  assert.equal(b.scope.server, 'https://b.invalid');
  assert.ok(!JSON.stringify(a.scope).includes('TOKEN'));
  await assert.rejects(kubernetes.create({ ...config, kubeconfig: './missing.yaml' }, context));
  const duplicated = kube('https://a.invalid');
  duplicated.users.push(...duplicated.users);
  await writeFile(path.join(root, 'duplicate.yaml'), stringify(duplicated));
  await assert.rejects(
    kubernetes.create({ ...config, kubeconfig: './duplicate.yaml' }, context),
    /KUBECONFIG_REFERENCE_INVALID/,
  );
  await writeFile(
    path.join(root, 'url.yaml'),
    stringify(kube('https://:EMBEDDED_PASSWORD@a.invalid')),
  );
  await assert.rejects(
    kubernetes.create({ ...config, kubeconfig: './url.yaml' }, context),
    /KUBECONFIG_SERVER_INVALID/,
  );
});
test('database source validation rejects connection credentials in addresses and unsupported pool options', async () => {
  const context = { instanceId: 'db', configFile: '/tmp/db.yaml', resolvePath: (s: string) => s };
  await assert.rejects(
    database.create(
      {
        backend: { command: process.execPath },
        resourceId: 'db',
        source: {
          type: 'postgres',
          database: 'db',
          host: 'postgres://user:SECRET@host',
          user: 'reader',
          passwordFile: './secret',
        },
      },
      context,
    ),
    /DATABASE_HOST_INVALID/,
  );
  await assert.rejects(
    database.create(
      {
        backend: { command: process.execPath },
        resourceId: 'db',
        source: { type: 'sqlite', database: 'db.sqlite' },
        poolMaxConnections: 2,
      },
      context,
    ),
    /POOL_LIMIT_REQUIRES_POSTGRES/,
  );
});
