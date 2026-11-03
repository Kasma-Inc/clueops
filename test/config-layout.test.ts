import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { fixture, principal } from './helpers.js';
import { readConfiguration, targetInstanceId } from '../src/core/config.js';
import type { ServiceConfig, TargetFile } from '../src/core/config.js';
import { PluginHost } from '../src/core/host.js';
import { builtinPlugins } from '../src/plugins/catalog.js';
import { credential } from '../src/plugins/shared.js';

const inline = (resourceId: string, base = '.') => ({
  plugin: 'fixture',
  config: { resourceId, credential: 'SYNTHETIC_' + resourceId, eventsFile: base + '/events.log' },
});
async function layout(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const root: ServiceConfig = {
    version: 1,
    plugins: { fixture: './plugin.mjs' },
    agent: inline('engine'),
    targets: { a: './targets/a.yaml', b: './targets/b.yaml' },
    channels: {
      chat: {
        ...inline('chat'),
        routes: [
          { tenant: 'tenant', conversation: 'room', allowedSenders: ['user'], targets: ['a', 'b'] },
        ],
      },
    },
  };
  const a: TargetFile = {
    tools: [
      { name: 'db', ...inline('database-a', '..') },
      { name: 'other', ...inline('second-a', '..') },
    ],
  };
  const b: TargetFile = { tools: [{ name: 'db', ...inline('database-b', '..') }] };
  async function write(
    config: ServiceConfig = root,
    first: TargetFile = a,
    second: TargetFile = b,
  ) {
    await mkdir(path.join(f.root, 'targets'), { recursive: true });
    await writeFile(f.configFile, stringify(config));
    await writeFile(path.join(f.root, 'targets/a.yaml'), stringify(first));
    await writeFile(path.join(f.root, 'targets/b.yaml'), stringify(second));
  }
  await write();
  return { ...f, service: root, a, b, write };
}
test('target-local tool sets and repeated plugin instances stay distinct and stable across reorder/credential rotation', async (t) => {
  const f = await layout(t);
  const host = await f.loadHost();
  const a = host.authorize(principal, 'a').target;
  const b = host.authorize(principal, 'b').target;
  assert.equal(a.tools.length, 2);
  assert.equal(b.tools.length, 1);
  assert.ok(a.tools.every((p) => !b.tools.some((q) => p.instanceId === q.instanceId)));
  assert.ok(!JSON.stringify(a).includes('SYNTHETIC'));
  assert.equal(
    a.tools.find((p) => p.instanceId === targetInstanceId('a', 'db'))!.resources.resourceId,
    'database-a',
  );
  await host.close();
  await f.write(
    { ...f.service, targets: { b: './targets/b.yaml', a: './targets/a.yaml' } },
    {
      tools: [
        f.a.tools[1]!,
        {
          name: 'db',
          ...inline('database-a', '..'),
          config: { resourceId: 'database-a', credential: 'ROTATED', eventsFile: '../events.log' },
        },
      ],
    },
  );
  const rotated = await f.loadHost();
  assert.equal(rotated.restore(principal, a).target.revision, a.revision);
});
test('explicit sharing is the only way targets gain a global tool; relative declaration files define all paths', async (t) => {
  const f = await layout(t);
  await mkdir(path.join(f.root, 'targets/knowledge'));
  await writeFile(path.join(f.root, 'targets/knowledge/skill.md'), 'synthetic');
  await f.write(
    { ...f.service, sharedTools: { common: inline('shared') } },
    { tools: [{ name: 'shared', use: 'common' }], knowledge: ['./knowledge'] },
    f.b,
  );
  const config = await readConfiguration(f.configFile);
  assert.equal(config.composition.targets.a!.knowledge![0], path.join(f.root, 'targets/knowledge'));
  assert.equal(
    config.composition.plugins[targetInstanceId('b', 'db')]!.sourceFile,
    path.join(f.root, 'targets/b.yaml'),
  );
  const host = await f.loadHost();
  assert.deepEqual(
    host.authorize(principal, 'a').target.tools.map((p) => p.instanceId),
    ['common'],
  );
  assert.ok(!host.authorize(principal, 'b').target.tools.some((p) => p.instanceId === 'common'));
  await f.write(f.service, { tools: [{ name: 'missing', use: 'absent' }] });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'SHARED_TOOL_NOT_FOUND' });
});
test('invalid target files, mixed config forms and old entry format fail before creating resources', async (t) => {
  const f = await layout(t);
  await writeFile(path.join(f.root, 'targets/a.yaml'), 'tools: {}\ntools: {}');
  await assert.rejects(PluginHost.load(f.configFile), { code: 'CONFIG_PARSE_FAILED' });
  await f.write();
  await writeFile(
    path.join(f.root, 'targets/a.yaml'),
    stringify({ tools: [{ name: 'a', ...inline('a'), configFile: '../private/a-tools.yaml' }] }),
  );
  await assert.rejects(PluginHost.load(f.configFile), { code: 'TARGET_CONFIG_INVALID' });
  await writeFile(f.configFile, stringify(f.config));
  await assert.rejects(PluginHost.load(f.configFile), { code: 'CONFIG_INVALID' });
  assert.deepEqual(await f.events(), []);
});
test('built-in names, inline secrets and default private engine state load without per-plugin files', async (t) => {
  const f = await layout(t);
  await f.write(
    {
      version: 1,
      runtime: { stateDirectory: './state' },
      agent: { plugin: 'codex', config: { model: 'test-model', apiKey: 'SYNTHETIC_API_KEY' } },
      targets: f.service.targets,
      channels: {
        chat: {
          plugin: 'lark',
          config: {
            appId: 'cli_0123456789abcdef',
            appSecret: 'SYNTHETIC_LARK_SECRET',
            tenantId: 'tenant',
            botOpenId: 'bot',
          },
          routes: f.service.channels.chat!.routes!,
        },
      },
    },
    { tools: [] },
    { tools: [] },
  );
  const host = await PluginHost.load(f.configFile, builtinPlugins);
  try {
    const scope = host.authorize(principal, 'a');
    assert.ok(!JSON.stringify(scope).includes('SYNTHETIC'));
    assert.equal(
      host.redactor.text('SYNTHETIC_API_KEY SYNTHETIC_LARK_SECRET'),
      '[REDACTED] [REDACTED]',
    );
    const session = await host
      .engineFor(scope.target)
      .createSession({ scope, tools: [] }, new AbortController().signal);
    await session.close();
    assert.equal((await readdir(path.join(f.root, 'state/plugins/engine'))).length, 1);
  } finally {
    await host.close();
  }
});
test('credentials require exactly one inline value or file and retain declaration-relative lookup', async (t) => {
  const f = await layout(t);
  await writeFile(path.join(f.root, 'targets/password'), 'FILE_SECRET\n');
  const context = {
    instanceId: 'test',
    configFile: path.join(f.root, 'targets/a.yaml'),
    resolvePath: (entry: string) => path.resolve(f.root, 'targets', entry),
  };
  assert.equal(await credential(' INLINE_SECRET ', undefined, context), ' INLINE_SECRET ');
  assert.equal(await credential(undefined, './password', context), 'FILE_SECRET');
  await assert.rejects(credential('x', './password', context), /CREDENTIAL_CHOICE_INVALID/);
  await assert.rejects(credential(undefined, undefined, context), /CREDENTIAL_CHOICE_INVALID/);
});

test('tool instance names are unique within a target and inline validation errors identify their declaration', async (t) => {
  const f = await layout(t);
  await f.write(f.service, {
    tools: [
      { name: 'db', ...inline('one') },
      { name: 'db', ...inline('two') },
    ],
  });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'DUPLICATE_TOOL_NAME' });
  await f.write(f.service, {
    tools: [
      {
        name: 'db',
        plugin: 'fixture',
        config: { resourceId: 5, credential: 'PRIVATE_VALIDATION_VALUE' },
      },
    ],
  });
  await assert.rejects(
    PluginHost.load(f.configFile),
    (error) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PLUGIN_CONFIG_INVALID' &&
      String(error).includes('a.yaml#tools.db') &&
      !String(error).includes('PRIVATE_VALIDATION_VALUE'),
  );
  assert.deepEqual(await f.events(), []);
});
test('target engine overrides and direct relative custom modules need no global vendor fields', async (t) => {
  const f = await layout(t);
  await f.write(f.service, {
    agent: { ...inline('a-engine', '..'), plugin: '../plugin.mjs' },
    tools: [{ name: 'local', ...inline('local', '..'), plugin: '../plugin.mjs' }],
  });
  const host = await f.loadHost();
  assert.equal(host.authorize(principal, 'a').target.engine.resources.resourceId, 'a-engine');
  assert.equal(host.authorize(principal, 'b').target.engine.resources.resourceId, 'engine');
});
test('built-in credential alternatives are schema-checked before opening a credential file', async (t) => {
  const f = await layout(t);
  await f.write({
    ...f.service,
    agent: {
      plugin: 'codex',
      config: { model: 'test', apiKey: 'PRIVATE_VALIDATION_VALUE', apiKeyFile: './absent' },
    },
  });
  await assert.rejects(
    PluginHost.load(f.configFile, builtinPlugins),
    (error) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PLUGIN_CONFIG_INVALID' &&
      !String(error).includes('PRIVATE_VALIDATION_VALUE'),
  );
});

test('model budget is a single optional global setting and rejects invalid or agent-local limits', async (t) => {
  const f = await layout(t);
  assert.equal((await f.loadHost()).runtime.maxModelTokens, undefined);
  await f.write({ ...f.service, runtime: { maxModelTokens: 123456 } });
  assert.equal((await f.loadHost()).runtime.maxModelTokens, 123456);
  for (const maxModelTokens of [0, -1, null, 1.5]) {
    await f.write({ ...f.service, runtime: { maxModelTokens } } as unknown as ServiceConfig);
    await assert.rejects(f.loadHost());
  }
  await f.write({
    ...f.service,
    agent: {
      plugin: 'codex',
      config: { model: 'test', apiKey: 'SYNTHETIC_ONLY_KEY', maxModelTokens: 100 },
    },
  });
  await assert.rejects(PluginHost.load(f.configFile, builtinPlugins));
});

test('channel policies are optional while target selection and explicit filters stay authoritative', async (t) => {
  const f = await layout(t);
  const { routes: _routes, ...channel } = f.service.channels.chat!;
  const anyUser = {
    ...principal,
    tenantId: 'other-tenant',
    conversationId: 'other-room',
    senderId: 'other-user',
  };
  await f.write({ ...f.service, channels: { chat: channel } });
  let host = await f.loadHost();
  assert.deepEqual(host.allowedTargets(anyUser), ['a', 'b']);
  assert.throws(() => host.authorize(anyUser), { code: 'TARGET_SELECTION_REQUIRED' });
  const a = host.authorize(anyUser, 'a').target;
  assert.ok(
    a.tools.every(
      (tool) =>
        !host
          .authorize(anyUser, 'b')
          .target.tools.some((other) => other.instanceId === tool.instanceId),
    ),
  );
  assert.deepEqual(host.allowedTargets({ ...anyUser, channelInstanceId: 'unknown' }), []);
  await host.close();
  for (const [policy, expected] of [
    [{ targets: ['a'] }, ['a']],
    [{ tenant: 'tenant' }, []],
    [{ conversation: 'room' }, []],
    [{ allowedSenders: ['user'] }, []],
    [{ allowedSenders: [] }, []],
    [{ targets: [] }, []],
  ] as const) {
    await f.write({ ...f.service, channels: { chat: { ...channel, routes: [policy] } } });
    host = await f.loadHost();
    assert.deepEqual(host.allowedTargets(anyUser), expected);
    await host.close();
  }
  for (const declaration of [
    { ...channel, routes: [] },
    { ...channel, enabled: false, routes: [{ targets: ['a'] }] },
  ]) {
    await f.write({ ...f.service, channels: { chat: declaration } });
    host = await f.loadHost();
    assert.deepEqual(host.allowedTargets(anyUser), []);
    await host.start(async () => ({ status: 'accepted', investigationId: 'i', turnId: 't' }));
    await host.close();
  }
});
