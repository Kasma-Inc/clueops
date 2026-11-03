import { mkdtemp, mkdir, copyFile, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { stringify } from 'yaml';
import type {
  CompositionConfig,
  PluginConfig,
  PluginDeclaration,
  ServiceConfig,
} from '../src/core/config.js';
import type { Principal } from '../src/plugin-api/index.js';
import { PluginHost } from '../src/core/index.js';

export const principal: Principal = {
  channelInstanceId: 'chat',
  tenantId: 'tenant',
  conversationId: 'room',
  senderId: 'user',
};

export async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-host-test-'));
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    try {
      for (const close of cleanup.reverse()) await close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(path.join(root, 'private'));
  await copyFile(
    new URL('../examples/demo/plugins/fixture.mjs', import.meta.url),
    path.join(root, 'plugin.mjs'),
  );
  const configFile = path.join(root, 'agent.yaml');
  const config: CompositionConfig = {
    version: 1,
    plugins: Object.fromEntries(
      ['engine', 'a-tools', 'b-tools', 'chat'].map((id) => [
        id,
        { module: './plugin.mjs', configFile: './private/' + id + '.yaml' },
      ]),
    ),
    targets: {
      a: { engine: 'engine', tools: ['a-tools'] },
      b: { engine: 'engine', tools: ['b-tools'] },
    },
    routes: [
      {
        channel: 'chat',
        tenant: 'tenant',
        conversation: 'room',
        allowedSenders: ['user'],
        targets: ['a', 'b'],
      },
    ],
  };
  async function writeConfig(value: unknown = config) {
    // Tests compose internal identities, then write the public global/target file format.
    const original = value as CompositionConfig;
    const directory = path.join(root, 'targets');
    await mkdir(directory, { recursive: true });
    const plugin = (id: string): PluginDeclaration => {
      const entry: PluginConfig = original.plugins[id] ?? { module: './missing.mjs', config: {} };
      return {
        plugin: entry.module.startsWith('.') ? path.resolve(root, entry.module) : entry.module,
        ...(entry.configFile
          ? { configFile: path.resolve(root, entry.configFile) }
          : { config: entry.config ?? {} }),
        ...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
      };
    };
    const channels = new Set(original.routes.map((r) => r.channel));
    const sharedTools = Object.fromEntries(
      Object.keys(original.plugins)
        .filter((id) => id !== 'engine' && !channels.has(id))
        .map((id) => [id, plugin(id)]),
    );
    for (const [name, target] of Object.entries(original.targets)) {
      await writeFile(
        path.join(directory, name + '.yaml'),
        stringify({
          ...(target.engine !== 'engine' ? { agent: plugin(target.engine) } : {}),
          tools: target.tools.map((id) => ({ name: id, use: id })),
          knowledge: (target.knowledge ?? []).map((p) => path.resolve(root, p)),
          ...(target.skills ? { skills: target.skills.map((p) => path.resolve(root, p)) } : {}),
        }),
      );
    }
    const {
      version: _v,
      plugins: _p,
      targets: _t,
      routes: _r,
      runtime: _runtime,
      lifecycleTimeoutMs: _lifecycle,
      ...unknown
    } = original;
    const service: ServiceConfig = {
      version: original.version,
      agent: plugin('engine'),
      sharedTools,
      targets: Object.fromEntries(
        Object.keys(original.targets).map((name) => [name, './targets/' + name + '.yaml']),
      ),
      channels: Object.fromEntries(
        [...channels].map((id) => [
          id,
          {
            ...plugin(id),
            routes: original.routes
              .filter((r) => r.channel === id)
              .map(({ channel: _channel, ...route }) => route),
          },
        ]),
      ),
      ...(original.runtime ? { runtime: original.runtime } : {}),
      ...(original.lifecycleTimeoutMs !== undefined
        ? { lifecycleTimeoutMs: original.lifecycleTimeoutMs }
        : {}),
      ...unknown,
    };
    await writeFile(configFile, stringify(service), { mode: 0o600 });
  }
  async function writePrivate(id: string, overrides: Record<string, unknown> = {}) {
    await writeFile(
      path.join(root, 'private', id + '.yaml'),
      stringify({
        resourceId: id,
        credential: 'TEST_SECRET_' + id,
        eventsFile: '../events.log',
        ...overrides,
      }),
      { mode: 0o600 },
    );
  }
  for (const id of Object.keys(config.plugins)) await writePrivate(id);
  await writeConfig();
  return {
    root,
    configFile,
    config,
    writeConfig,
    writePrivate,
    async loadHost() {
      const host = await PluginHost.load(configFile);
      cleanup.push(() => host.close());
      return host;
    },
    async events() {
      return (await readFile(path.join(root, 'events.log'), 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean);
    },
  };
}
