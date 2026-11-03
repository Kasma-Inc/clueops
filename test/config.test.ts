import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PluginHost, HostError } from '../src/core/index.js';
import { fixture, principal } from './helpers.js';
import type { ChannelMessage, MessageHandlingResult } from '../src/plugin-api/index.js';

test('YAML duplicates, aliases, unknown tags and invalid scalar types fail without echoing secrets', async (t) => {
  const f = await fixture(t);
  for (const content of [
    'password: TEST_SECRET\npassword: TEST_SECRET_TWO\n',
    'x: &x [*x]\n',
    'x: !private TEST_SECRET\n',
    'x: .inf\n',
    '---\nx: 1\n---\nx: 2\n',
  ]) {
    await writeFile(f.configFile, content);
    await assert.rejects(
      PluginHost.load(f.configFile),
      (error) => error instanceof HostError && !String(error.stack).includes('TEST_SECRET'),
    );
  }
  await f.writeConfig({ ...f.config, routes: [{ ...f.config.routes[0], allowedSenders: [123] }] });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'CONFIG_INVALID' });
  await f.writeConfig({ ...f.config, typo: true });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'CONFIG_INVALID' });
  assert.deepEqual(await f.events(), []);
});

test('private configuration schema errors and missing references never trigger default connections', async (t) => {
  const f = await fixture(t);
  await f.writePrivate('chat', { resourceId: 5 });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'PLUGIN_CONFIG_INVALID' });
  assert.deepEqual(await f.events(), []);
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      engine: { ...f.config.plugins.engine!, configFile: './missing-private.yaml' },
    },
  });
  await assert.rejects(PluginHost.load(f.configFile), { code: 'CONFIG_READ_FAILED' });
  assert.deepEqual(await f.events(), []);
});

test('relative modules, private files and nested file references are independent of process cwd', async (t) => {
  const f = await fixture(t);
  const executable = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const tsx = import.meta.resolve('tsx');
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ['--import', tsx, executable, '--check-config', '--config', f.configFile],
    { cwd: path.dirname(f.root) },
  );
  assert.equal(stderr, '');
  assert.equal((JSON.parse(stdout) as { status: string }).status, 'valid');
  assert.ok(!stdout.includes('TEST_SECRET'));
  assert.deepEqual((await f.events()).slice(-4), [
    'chat:dispose',
    'b-tools:dispose',
    'a-tools:dispose',
    'engine:dispose',
  ]);
});

test('knowledge is selected from the target and its plugins only, with declaration-relative paths', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'a-knowledge'));
  await mkdir(path.join(f.root, 'b-knowledge'));
  const source = await readFile(path.join(f.root, 'plugin.mjs'), 'utf8');
  await writeFile(
    path.join(f.root, 'a-plugin.mjs'),
    source.replace(
      "id: 'synthetic-fixture'",
      "knowledge: ['./a-knowledge'], id: 'synthetic-fixture'",
    ),
  );
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      'a-tools': { ...f.config.plugins['a-tools']!, module: './a-plugin.mjs' },
    },
    targets: {
      ...f.config.targets,
      b: { engine: 'engine', tools: ['b-tools'], knowledge: ['./b-knowledge'] },
    },
  });
  const host = await f.loadHost();
  assert.ok(host.authorize(principal, 'a').target.knowledge[0]?.endsWith('/a-knowledge'));
  assert.ok(!JSON.stringify(host.authorize(principal, 'a')).includes('b-knowledge'));
  assert.ok(host.authorize(principal, 'b').target.knowledge[0]?.endsWith('/b-knowledge'));
});

test('close during channel startup cancels registration and never starts the next channel', async (t) => {
  const f = await fixture(t);
  await f.writePrivate('chat2');
  await writeFile(
    path.join(f.root, 'delayed.mjs'),
    `
    import base from './plugin.mjs';
    export let release;
    const gate = new Promise(resolve => { release = resolve; });
    export default { ...base, async create(config, context) {
      const instance = await base.create(config, context);
      return { ...instance, channel: { ...instance.channel,
        async start(handler, signal) { await gate; await instance.channel.start(handler, signal); }
      } };
    } };
  `,
  );
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      chat: { ...f.config.plugins.chat!, module: './delayed.mjs' },
      chat2: { module: './plugin.mjs', configFile: './private/chat2.yaml' },
    },
    routes: [...f.config.routes, { ...f.config.routes[0], channel: 'chat2' }],
  });
  const host = await PluginHost.load(f.configFile);
  const control = (await import(pathToFileURL(path.join(f.root, 'delayed.mjs')).href)) as {
    release(): void;
  };
  const starting = host.start(async () => ({
    status: 'accepted',
    investigationId: 'i',
    turnId: 't',
  }));
  const closing = host.close();
  assert.ok(!(await f.events()).some((event) => event.endsWith(':dispose')));
  control.release();
  await Promise.all([starting, closing]);
  const events = await f.events();
  assert.ok(!events.includes('chat2:start'));
  assert.ok(events.lastIndexOf('chat:stop') > events.indexOf('chat:start'));
  assert.ok(events.indexOf('chat:dispose') > events.indexOf('chat:stop'));
});

test('channel callbacks validate payloads, bind source identity and return terminal refusals', async (t) => {
  const f = await fixture(t);
  const moduleFile = path.join(f.root, 'receiving.mjs');
  await writeFile(
    moduleFile,
    `
    import base from './plugin.mjs';
    export let receive;
    export default { ...base, async create(config, context) {
      const instance = await base.create(config, context);
      return { ...instance, channel: { ...instance.channel,
        async start(handler, signal) { receive = handler; await instance.channel.start(handler, signal); }
      } };
    } };
  `,
  );
  await f.writeConfig({
    ...f.config,
    plugins: {
      ...f.config.plugins,
      chat: { ...f.config.plugins.chat!, module: './receiving.mjs' },
    },
  });
  const host = await f.loadHost();
  const receiver = (await import(pathToFileURL(moduleFile).href)) as {
    receive(message: unknown): Promise<MessageHandlingResult>;
  };
  let count = 0;
  let fail = false;
  await host.start(async (message) => {
    count++;
    assert.equal(Object.isFrozen(message.address), true);
    if (fail) throw new Error('PRIVATE_EXCEPTION_CONTENT');
    return { status: 'rejected', reason: 'TARGET_REQUIRED' };
  });
  const message: ChannelMessage = {
    address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
    senderId: 'user',
    messageId: 'm',
    text: 'log',
  };
  await assert.rejects(receiver.receive({ ...message, text: 3 }), {
    code: 'CHANNEL_MESSAGE_INVALID',
  });
  await assert.rejects(
    receiver.receive({ ...message, address: { ...message.address, channelInstanceId: 'other' } }),
    { code: 'CHANNEL_SOURCE_MISMATCH' },
  );
  assert.equal(count, 0);
  assert.deepEqual(await receiver.receive(message), {
    status: 'rejected',
    reason: 'TARGET_REQUIRED',
  });
  fail = true;
  await assert.rejects(
    receiver.receive(message),
    (error) =>
      error instanceof HostError &&
      error.code === 'CHANNEL_HANDLER_FAILED' &&
      !String(error.stack).includes('PRIVATE_EXCEPTION_CONTENT'),
  );
});

test('pending startup cannot block other cleanup; a late start is stopped and disposed again', async (t) => {
  const f = await fixture(t);
  const moduleFile = path.join(f.root, 'late-start.mjs');
  await writeFile(
    moduleFile,
    `
    import base from './plugin.mjs';
    export let release, receive;
    let lateDisposed;
    export const lateCleanup = new Promise(resolve => { lateDisposed = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    export default { ...base, async create(config, context) {
      const instance = await base.create(config, context);
      let finished = false;
      return { ...instance, channel: { ...instance.channel,
        async start(handler) {
          receive = handler;
          await gate; // Intentionally violates cooperative cancellation to exercise host fallback.
          await instance.channel.start(handler, new AbortController().signal);
          finished = true;
        }
      }, async dispose() {
        await instance.dispose();
        if (finished) lateDisposed();
      } };
    } };
  `,
  );
  await f.writeConfig({
    ...f.config,
    lifecycleTimeoutMs: 25,
    plugins: {
      ...f.config.plugins,
      chat: { ...f.config.plugins.chat!, module: './late-start.mjs' },
    },
  });
  const host = await PluginHost.load(f.configFile);
  const late = (await import(pathToFileURL(moduleFile).href)) as {
    release(): void;
    receive(message: unknown): Promise<unknown>;
    lateCleanup: Promise<void>;
  };
  const starting = host.start(async () => ({ status: 'rejected', reason: 'NO_INVESTIGATION' }));
  const closing = assert.rejects(host.close(), { code: 'SHUTDOWN_FAILED' });
  await Promise.all([starting, closing]);
  const beforeRelease = await f.events();
  assert.ok(beforeRelease.includes('chat:stop'));
  assert.deepEqual(beforeRelease.slice(-4), [
    'chat:dispose',
    'b-tools:dispose',
    'a-tools:dispose',
    'engine:dispose',
  ]);
  late.release();
  await late.lateCleanup;
  const afterRelease = await f.events();
  assert.deepEqual(afterRelease.slice(-3), ['chat:start', 'chat:stop', 'chat:dispose']);
  await assert.rejects(late.receive({}), { code: 'HOST_CLOSED' });
});
