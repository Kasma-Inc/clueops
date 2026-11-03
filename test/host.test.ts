import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PluginHost, HostError, TargetSelectionRequired } from '../src/core/index.js';
import { fixture, principal } from './helpers.js';

test('external ESM instances provide identical local tool names without cross-target selection', async (t) => {
  const f = await fixture(t);
  const host = await f.loadHost();
  const a = host.authorize(principal, 'a');
  const b = host.authorize(principal, 'b');
  for (const scope of [a, b]) {
    const [tool] = host.toolsFor(scope.target);
    assert.ok(tool);
    const signal = new AbortController().signal;
    const bound = await tool.provider.bind({
      investigationId: 'i',
      turnId: 't',
      targetId: scope.target.targetId,
      scopeRevision: scope.target.revision,
      signal,
    });
    assert.equal(bound.status, 'ready');
    if (bound.status === 'ready') {
      assert.equal((bound.definitions ?? tool.provider.definitions)[0]!.name, 'read_evidence');
      assert.deepEqual((await bound.binding.call('read_evidence', {}, signal)).content, {
        resourceId: scope.target.targetId + '-tools',
      });
      await bound.binding.close();
    }
    assert.deepEqual(
      scope.target.tools.map((tool) => tool.instanceId),
      [scope.target.targetId + '-tools'],
    );
  }
  const serialized = JSON.stringify(a);
  assert.ok(!serialized.includes('TEST_SECRET_'));
  assert.ok(!serialized.includes('b-tools'));
  assert.ok(!serialized.includes('configFile'));
  assert.equal(Object.isFrozen(a.target.tools[0]?.resources), true);
  assert.equal(Object.isFrozen(host.toolsFor(a.target)[0]?.provider.definitions), true);
});

test('tenant, group and current sender gate selection; ambiguous targets never default', async (t) => {
  const f = await fixture(t);
  const host = await f.loadHost();
  assert.throws(
    () => host.authorize(principal),
    (error) => error instanceof TargetSelectionRequired && error.targetIds.join(',') === 'a,b',
  );
  for (const changed of [
    { tenantId: 'other' },
    { senderId: 'other' },
    { conversationId: 'other' },
    { channelInstanceId: 'other' },
  ]) {
    assert.throws(() => host.authorize({ ...principal, ...changed }, 'a'), {
      code: 'ACCESS_DENIED',
    });
  }
  assert.throws(() => host.authorize(principal, 'missing'), { code: 'ACCESS_DENIED' });
});

test('restoring ignores credential rotation but rejects changed resource identities and grants', async (t) => {
  const f = await fixture(t);
  const old = await PluginHost.load(f.configFile);
  const saved = old.authorize(principal, 'a').target;
  await old.close();
  await f.writePrivate('a-tools', { credential: 'ROTATED_SECRET' });
  const rotated = await PluginHost.load(f.configFile);
  assert.deepEqual(rotated.restore(principal, saved).target, saved);
  assert.throws(() => rotated.restore({ ...principal, senderId: 'revoked' }, saved), {
    code: 'ACCESS_DENIED',
  });
  await rotated.close();
  for (const changed of [{ resourceId: 'different-cluster' }, { namespaces: ['new-namespace'] }]) {
    await f.writePrivate('a-tools', changed);
    const host = await PluginHost.load(f.configFile);
    assert.throws(() => host.restore(principal, saved), { code: 'TARGET_SCOPE_CHANGED' });
    await host.close();
  }
});

test('shared data sources are explicit and snapshots cannot redirect capability lookups', async (t) => {
  const f = await fixture(t);
  await f.writeConfig({
    ...f.config,
    targets: { ...f.config.targets, b: { engine: 'engine', tools: ['a-tools'] } },
  });
  const host = await f.loadHost();
  const a = host.authorize(principal, 'a').target;
  const b = host.authorize(principal, 'b').target;
  assert.deepEqual(a.tools, b.tools);
  const forged = { ...a, tools: [{ ...a.tools[0]!, instanceId: 'b-tools' }] };
  assert.deepEqual(
    host.toolsFor(forged).map((tool) => tool.instanceId),
    ['a-tools'],
  );
});

test('all configuration and references are validated before creating instances', async (t) => {
  const f = await fixture(t);
  await f.writeConfig({ ...f.config, targets: { a: { engine: 'missing', tools: ['a-tools'] } } });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'PLUGIN_LOAD_FAILED' });
  assert.deepEqual(await f.events(), []);
  await f.writeConfig({ ...f.config, routes: [{ ...f.config.routes[0], targets: ['missing'] }] });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'TARGET_REFERENCE_INVALID' });
  assert.deepEqual(await f.events(), []);
});

test('startup rejects missing modules, incompatible API versions and capability mismatches', async (t) => {
  const f = await fixture(t);
  const source = await readFile(path.join(f.root, 'plugin.mjs'), 'utf8');
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      engine: { ...f.config.plugins.engine!, module: './missing.mjs' },
    },
  });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'PLUGIN_LOAD_FAILED' });
  await f.writeConfig();
  await writeFile(path.join(f.root, 'bad.mjs'), source.replace('apiVersion: 1', 'apiVersion: 99'));
  await f.writeConfig({
    ...f.config,
    plugins: { ...f.config.plugins, engine: { ...f.config.plugins.engine!, module: './bad.mjs' } },
  });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'PLUGIN_CONTRACT_INVALID' });
  await writeFile(
    path.join(f.root, 'tools-only.mjs'),
    source.replace("capabilities: ['engine', 'tools', 'channel']", "capabilities: ['tools']"),
  );
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      engine: { ...f.config.plugins.engine!, module: './tools-only.mjs' },
    },
  });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'PLUGIN_REFERENCE_INVALID' });
});

test('disabled plugins are not imported and cannot satisfy active target references', async (t) => {
  const f = await fixture(t);
  const plugins = {
    ...f.config.plugins,
    unused: { module: './absent.mjs', configFile: './absent.yaml', enabled: false },
  };
  await f.writeConfig({ ...f.config, plugins });
  const host = await PluginHost.load(f.configFile);
  await host.close();
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      'a-tools': { ...f.config.plugins['a-tools']!, enabled: false },
    },
  });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'PLUGIN_REFERENCE_INVALID' });
});

test('installed ESM packages use import exports instead of require-only resolution', async (t) => {
  const f = await fixture(t);
  const name = 'incident-fixture-' + randomUUID();
  const directory = path.resolve('node_modules', name);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    path.join(directory, 'package.json'),
    JSON.stringify({ name, type: 'module', exports: { import: './plugin.mjs' } }),
  );
  await writeFile(
    path.join(directory, 'plugin.mjs'),
    await readFile(path.join(f.root, 'plugin.mjs')),
  );
  await f.writeConfig({
    ...f.config,
    plugins: { ...f.config.plugins, engine: { ...f.config.plugins.engine!, module: name } },
  });
  const host = await PluginHost.load(f.configFile);
  await host.close();
});

test('class-backed external plugins retain the create method receiver', async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.root, 'class-plugin.mjs'),
    `
    import base from './plugin.mjs';
    class ExternalPlugin {
      manifest = base.manifest;
      #factory = base.create.bind(base);
      create(config, context) { return this.#factory(config, context); }
    }
    export default new ExternalPlugin();
  `,
  );
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      engine: { ...f.config.plugins.engine!, module: './class-plugin.mjs' },
    },
  });
  const host = await f.loadHost();
  assert.equal(host.authorize(principal, 'a').target.engine.instanceId, 'engine');
});

test('plugin creation and local tool collisions fail safely and roll back created instances', async (t) => {
  const f = await fixture(t);
  await f.writePrivate('b-tools', { duplicateTools: true });
  await assert.rejects(
    PluginHost.load(f.configFile),
    (error) =>
      error instanceof HostError &&
      error.code === 'PLUGIN_INITIALIZATION_FAILED' &&
      !String(error).includes('TEST_SECRET'),
  );
  assert.deepEqual(
    (await f.events()).filter((event) => event.endsWith(':dispose')),
    ['b-tools:dispose', 'a-tools:dispose', 'engine:dispose'],
  );
});

test('creation failure never exposes private exception values', async (t) => {
  const f = await fixture(t);
  await f.writePrivate('chat', { failCreate: true });
  await assert.rejects(
    PluginHost.load(f.configFile),
    (error) => error instanceof HostError && !String(error.stack).includes('TEST_SECRET'),
  );
  assert.deepEqual(
    (await f.events()).filter((event) => event.endsWith(':dispose')),
    ['b-tools:dispose', 'a-tools:dispose', 'engine:dispose'],
  );
});

test('channels start after creation; shutdown stops reception before draining and disposing', async (t) => {
  const f = await fixture(t);
  const host = await PluginHost.load(f.configFile);
  await host.start(async () => ({ status: 'accepted', investigationId: 'i', turnId: 't' }));
  const closed = host.close(async () => {
    await writeFile(path.join(f.root, 'at-drain.json'), JSON.stringify(await f.events()));
  });
  assert.equal(host.close(), closed);
  await closed;
  const atDrain = JSON.parse(
    await readFile(path.join(f.root, 'at-drain.json'), 'utf8'),
  ) as string[];
  assert.deepEqual(atDrain, [
    'engine:create',
    'a-tools:create',
    'b-tools:create',
    'chat:create',
    'chat:start',
    'chat:stop',
  ]);
  assert.deepEqual((await f.events()).slice(-4), [
    'chat:dispose',
    'b-tools:dispose',
    'a-tools:dispose',
    'engine:dispose',
  ]);
  assert.throws(() => host.authorize(principal, 'a'), { code: 'HOST_CLOSED' });
});

test('failed channel start and disposal errors still release other resources', async (t) => {
  const f = await fixture(t);
  await f.writePrivate('chat', { failStart: true, failDispose: true });
  const host = await PluginHost.load(f.configFile);
  await assert.rejects(
    host.start(async () => ({ status: 'accepted', investigationId: 'i', turnId: 't' })),
    { code: 'CHANNEL_START_FAILED' },
  );
  assert.deepEqual((await f.events()).slice(-5), [
    'chat:stop',
    'chat:dispose',
    'b-tools:dispose',
    'a-tools:dispose',
    'engine:dispose',
  ]);
});
