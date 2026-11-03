import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture } from './helpers.js';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

test(
  'SIGTERM cancels a channel that is still starting and waits for cleanup',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const begun = path.join(f.root, 'start-begun');
    const gate = path.join(f.root, 'start-gate');
    const aborted = path.join(f.root, 'start-aborted');
    const registered = path.join(f.root, 'registered');
    await writeFile(
      path.join(f.root, 'delayed.mjs'),
      `
    import base from './plugin.mjs';
    import { access, writeFile } from 'node:fs/promises';
    export default { ...base, async create(config, context) {
      const instance = await base.create(config, context);
      const start = instance.channel.start.bind(instance.channel);
      instance.channel.start = async (handler, signal) => {
        await writeFile(${JSON.stringify(begun)}, 'begun');
        while (!signal.aborted && !(await access(${JSON.stringify(gate)}).then(() => true, () => false)))
          await new Promise(resolve => setTimeout(resolve, 5));
        if (signal.aborted) await writeFile(${JSON.stringify(aborted)}, 'aborted');
        signal.throwIfAborted();
        await writeFile(${JSON.stringify(registered)}, 'registered');
        return start(handler, signal);
      };
      return instance;
    } };
  `,
    );
    await f.writeConfig({
      ...f.config,
      plugins: {
        ...f.config.plugins,
        chat: { ...f.config.plugins.chat!, module: './delayed.mjs' },
      },
    });
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        new URL('../src/index.ts', import.meta.url).pathname,
        '--config',
        f.configFile,
      ],
      { cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    const exited = once(child, 'exit');
    let output = '',
      error = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      error += String(chunk);
    });
    while (
      !(await access(begun).then(
        () => true,
        () => false,
      ))
    ) {
      assert.equal(child.exitCode, null, error);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    child.kill('SIGTERM');
    for (
      let attempt = 0;
      attempt < 20 &&
      !(await access(aborted).then(
        () => true,
        () => false,
      ));
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(gate, 'release');
    const [code] = await exited;
    assert.equal(code, 0, error);
    assert.equal(await readFile(aborted, 'utf8'), 'aborted');
    await assert.rejects(access(registered));
    assert.ok(!output.includes('"status":"running"'));
    assert.ok(output.includes('"stopped"'));
    assert.ok((await f.events()).includes('chat:dispose'));
  },
);
test(
  'daemon stays ready with an idle channel and drains on SIGTERM',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        new URL('../src/index.ts', import.meta.url).pathname,
        '--config',
        f.configFile,
      ],
      { cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      error += String(chunk);
    });
    while (!output.includes('"running"')) {
      await once(child.stdout, 'data');
    }
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, error);
    assert.ok(output.includes('"stopped"'));
    assert.ok(!error.includes('unsettled'));
  },
);
