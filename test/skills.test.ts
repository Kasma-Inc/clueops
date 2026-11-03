import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  writeFile,
  readFile,
  chmod,
  symlink,
  readdir,
  truncate,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { fixture, principal } from './helpers.js';
import { loadSkills, installSkills } from '../src/core/skills.js';
import { readConfiguration } from '../src/core/config.js';
import { PluginHost } from '../src/core/host.js';
import type { CompositionConfig } from '../src/core/config.js';
import type { InvestigationRequest, JsonObject } from '../src/plugin-api/index.js';
import { prepareSkillWorkspace } from '../src/plugins/codex/skills.js';

async function skill(root: string, name: string, marker = name) {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, 'references'), { recursive: true });
  await mkdir(path.join(directory, 'scripts'));
  await mkdir(path.join(directory, 'assets'));
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Investigate this target using the ${name} workflow.\n---\n${marker}_DEFERRED_BODY\nRead references/detail.md and run scripts/probe.sh when needed.\n`,
  );
  await writeFile(path.join(directory, 'references/detail.md'), marker + '_REFERENCE');
  await writeFile(path.join(directory, 'assets/config.txt'), marker + '_ASSET');
  await writeFile(
    path.join(directory, 'scripts/probe.sh'),
    `#!/bin/sh\ncat "$(dirname "$0")/../references/detail.md"\ncat "$(dirname "$0")/../assets/config.txt"\nprintf '${marker}_SCRIPT_OK\\n'\n`,
    { mode: 0o755 },
  );
  return directory;
}
async function configured(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const a = await skill(path.join(f.root, 'selected-a'), 'target-alpha', 'ALPHA');
  const b = await skill(path.join(f.root, 'selected-b'), 'target-beta', 'BETA');
  const config: CompositionConfig = {
    ...f.config,
    plugins: {
      ...f.config.plugins,
      engine: {
        module: new URL('../src/plugins/codex/index.js', import.meta.url).href,
        config: {
          apiKey: 'SYNTHETIC_SKILL_KEY',
          model: 'gpt-6',
          stateDirectory: path.join(f.root, 'codex'),
        },
      },
    },
    targets: {
      a: { engine: 'engine', tools: [], skills: ['./selected-a'] },
      b: { engine: 'engine', tools: [], skills: ['./selected-b'] },
    },
  };
  await f.writeConfig(config);
  return { ...f, a, b, skillConfig: config };
}
test('skill paths, packages and digests belong only to the selected target', async (t) => {
  const f = await configured(t);
  const config = await readConfiguration(f.configFile);
  assert.deepEqual(config.composition.targets.a!.skills, [path.join(f.root, 'selected-a')]);
  const host = await f.loadHost();
  const a = host.authorize(principal, 'a').target;
  const b = host.authorize(principal, 'b').target;
  assert.deepEqual(
    a.skills!.map((s) => s.name),
    ['target-alpha'],
  );
  assert.deepEqual(
    b.skills!.map((s) => s.name),
    ['target-beta'],
  );
  assert.ok(!JSON.stringify(a).includes('target-beta'));
  assert.ok(!JSON.stringify(a).includes('ALPHA_DEFERRED_BODY'));
  await host.close();
  await writeFile(path.join(f.a, 'references/detail.md'), 'changed-reference');
  const reloaded = await f.loadHost();
  assert.notEqual(reloaded.authorize(principal, 'a').target.revision, a.revision);
  assert.throws(() => reloaded.restore(principal, a), /TARGET_SCOPE_CHANGED/);
  assert.equal(reloaded.restore(principal, b).target.revision, b.revision);
});
test('collections, direct manifests and symlinked package roots deduplicate without merging names', async (t) => {
  const f = await fixture(t);
  const directory = await skill(path.join(f.root, 'collection'), 'alpha');
  await symlink(directory, path.join(f.root, 'linked'));
  const first = await loadSkills([
    path.join(f.root, 'collection'),
    path.join(directory, 'SKILL.md'),
    path.join(f.root, 'linked'),
  ]);
  assert.equal(first.length, 1);
  await mkdir(path.join(directory, '.git'));
  await writeFile(path.join(directory, '.git/ignored'), 'repository metadata');
  await mkdir(path.join(directory, 'node_modules'));
  await writeFile(path.join(directory, 'node_modules/ignored'), 'local dependency cache');
  assert.equal((await loadSkills([directory]))[0]!.digest, first[0]!.digest);
  const duplicate = await skill(path.join(f.root, 'other'), 'alpha');
  await assert.rejects(loadSkills([directory, duplicate]), /DUPLICATE_SKILL_NAME/);
  await mkdir(path.join(f.root, 'empty'));
  assert.deepEqual(await loadSkills([path.join(f.root, 'empty')]), []);
  await assert.rejects(loadSkills([path.join(f.root, 'missing')]), /SKILL_PATH_INVALID/);
});
test('invalid metadata, external symlinks and oversized package resources fail before plugin creation', async (t) => {
  const f = await fixture(t);
  const directory = await skill(f.root, 'bad');
  await writeFile(
    path.join(directory, 'SKILL.md'),
    '---\nname: bad\nname: duplicate\ndescription: SYNTHETIC_BAD_SECRET\n---\n',
  );
  await f.writeConfig({
    ...f.config,
    targets: { ...f.config.targets, a: { engine: 'engine', tools: [], skills: ['./bad'] } },
  });
  await assert.rejects(
    PluginHost.load(f.configFile),
    (error) =>
      String(error).includes('SKILL_MANIFEST_INVALID') &&
      !String(error).includes('SYNTHETIC_BAD_SECRET'),
  );
  assert.deepEqual(await f.events(), []);
  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: bad\ndescription: Valid\n---\n');
  await symlink(path.join(f.root, 'private/engine.yaml'), path.join(directory, 'outside'));
  await assert.rejects(loadSkills([directory]), /SKILL_RESOURCE_UNSUPPORTED/);
  const huge = await skill(f.root, 'huge');
  await writeFile(path.join(huge, 'assets/large'), '');
  await truncate(path.join(huge, 'assets/large'), 64 * 1024 * 1024 + 1);
  await assert.rejects(loadSkills([huge]), /SKILL_TOO_LARGE/);
});
test('unsupported engines reject configured skills instead of ignoring them', async (t) => {
  const f = await fixture(t);
  await skill(f.root, 'workflow');
  await f.writeConfig({
    ...f.config,
    targets: { ...f.config.targets, a: { engine: 'engine', tools: [], skills: ['./workflow'] } },
  });
  await assert.rejects(PluginHost.load(f.configFile), /ENGINE_SKILLS_UNSUPPORTED/);
});
test('nested manifests cannot become additional native skills or bypass name validation', async (t) => {
  const f = await fixture(t);
  const outer = await skill(f.root, 'outer');
  await skill(path.join(outer, 'references'), 'nested-unselected');
  await assert.rejects(loadSkills([outer]), /NESTED_SKILL_UNSUPPORTED/);
});
test('staging preserves resources and execution flags, rejects changed packages and replaces stale skills', async (t) => {
  const f = await fixture(t);
  const directory = await skill(f.root, 'workflow');
  const selected = await loadSkills([directory]);
  const installed = path.join(f.root, 'home/.agents/skills');
  await installSkills(selected, installed);
  assert.equal(
    execFileSync(path.join(installed, 'workflow/scripts/probe.sh'), { encoding: 'utf8' }),
    'workflow_REFERENCEworkflow_ASSETworkflow_SCRIPT_OK\n',
  );
  await mkdir(path.join(installed, 'stale'));
  await writeFile(path.join(installed, 'stale/SKILL.md'), 'old');
  await installSkills(selected, installed);
  assert.deepEqual(await readdir(installed), ['workflow']);
  await chmod(path.join(directory, 'scripts/probe.sh'), 0o644);
  await assert.rejects(installSkills(selected, installed), /SKILL_CONTENT_CHANGED/);
  assert.equal(
    execFileSync(path.join(installed, 'workflow/scripts/probe.sh'), { encoding: 'utf8' }),
    'workflow_REFERENCEworkflow_ASSETworkflow_SCRIPT_OK\n',
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(installSkills(selected, installed, abort.signal));
  await rm(directory, { recursive: true });
  await assert.rejects(installSkills(selected, installed), /SKILL_CONTENT_CHANGED/);
});
test('session restore refreshes the managed skill set and refuses source changes after startup', async (t) => {
  const f = await configured(t);
  const host = await f.loadHost();
  const scope = host.authorize(principal, 'a');
  const engine = host.engineFor(scope.target);
  const session = await engine.createSession({ scope, tools: [] }, new AbortController().signal);
  const handle = session.handle as JsonObject;
  const home = path.join(f.root, 'codex', String(handle.directoryId), 'home');
  await session.close();
  await mkdir(path.join(home, '.agents/skills/stale'));
  await writeFile(path.join(home, '.agents/skills/stale/SKILL.md'), 'stale');
  await mkdir(path.join(home, '.codex/skills/legacy'), { recursive: true });
  await writeFile(path.join(home, '.codex/skills/legacy/SKILL.md'), 'legacy skill');
  const resumed = await engine.resumeSession(
    handle,
    { scope, tools: [] },
    new AbortController().signal,
  );
  try {
    assert.deepEqual(await readdir(path.join(home, '.agents/skills')), ['target-alpha']);
    await assert.rejects(readFile(path.join(home, '.codex/skills/legacy/SKILL.md')), {
      code: 'ENOENT',
    });
  } finally {
    await resumed.close();
  }
  await writeFile(path.join(f.a, 'assets/config.txt'), 'changed after startup');
  await assert.rejects(
    engine.resumeSession(handle, { scope, tools: [] }, new AbortController().signal),
    /SKILL_CONTENT_CHANGED/,
  );
});
test('workspace skill cleanup rejects linked parents and cannot remove a selected source', async (t) => {
  const f = await fixture(t);
  const home = path.join(f.root, 'home');
  const work = path.join(f.root, 'work');
  const outside = path.join(f.root, 'outside');
  const source = await skill(path.join(outside, 'skills'), 'keep');
  await mkdir(work);
  await symlink(outside, path.join(work, '.agents'));
  await assert.rejects(
    prepareSkillWorkspace(home, work, [], new AbortController().signal),
    /WORKSPACE_BOUNDARY_INVALID/,
  );
  assert.ok((await readFile(path.join(source, 'SKILL.md'), 'utf8')).includes('name: keep'));
  await rm(path.join(work, '.agents'));
  const managed = await skill(path.join(work, '.agents/skills'), 'selected');
  const skills = await loadSkills([managed]);
  await assert.rejects(
    prepareSkillWorkspace(home, work, skills, new AbortController().signal),
    /SKILL_SOURCE_OVERLAP/,
  );
  assert.ok((await readFile(path.join(managed, 'SKILL.md'), 'utf8')).includes('name: selected'));
  const ancestor = await skill(f.root, 'ancestor-package');
  const ancestorSkills = await loadSkills([ancestor]);
  await assert.rejects(
    prepareSkillWorkspace(
      path.join(ancestor, 'state/home'),
      path.join(ancestor, 'state/work'),
      ancestorSkills,
      new AbortController().signal,
    ),
    /SKILL_SOURCE_OVERLAP/,
  );
  await assert.rejects(readdir(path.join(ancestor, 'state')), { code: 'ENOENT' });
  await assert.rejects(
    installSkills(ancestorSkills, path.join(ancestor, 'install/skills')),
    /SKILL_SOURCE_OVERLAP/,
  );
  await assert.rejects(readdir(path.join(ancestor, 'install')), { code: 'ENOENT' });
});
test(
  'real Codex natively discovers only selected skill metadata and loads executable resources on demand',
  { timeout: 60000 },
  async (t) => {
    const f = await configured(t);
    execFileSync('git', ['init', '--quiet', '--template=', f.root]);
    await skill(path.join(f.root, '.agents/skills'), 'parent-unselected', 'PARENT');
    let phase = '';
    let calls = 0;
    let current: InvestigationRequest;
    let installed = '';
    const api = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      if (req.url?.endsWith('input_tokens')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 }));
        return;
      }
      const input = JSON.stringify(JSON.parse(raw).input);
      const marker = phase.startsWith('a') ? 'ALPHA' : 'BETA';
      const name = phase.startsWith('a') ? 'target-alpha' : 'target-beta';
      assert.match(input, new RegExp(`file: r\\d+/${name}/SKILL\\.md`));
      assert.ok(
        input.includes('home/.agents/skills'),
        'native catalog must describe the staged root',
      );
      assert.ok(input.includes(name));
      assert.ok(!input.includes('parent-unselected'));
      assert.ok(!input.includes('work-stale'));
      assert.ok(!input.includes(phase.startsWith('a') ? 'target-beta' : 'target-alpha'));
      if (calls === 0 && phase !== 'a-resume')
        assert.ok(!input.includes(marker + '_DEFERRED_BODY'));
      if (calls > 0) {
        assert.ok(input.includes(marker + '_DEFERRED_BODY'));
        assert.ok(input.includes(marker + '_REFERENCE'));
        assert.ok(input.includes(marker + '_ASSET'));
        assert.ok(input.includes(marker + '_SCRIPT_OK'));
      }
      const n = calls++;
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const item =
        n === 0
          ? {
              id: 'read-skill',
              call_id: 'read-skill',
              type: 'function_call',
              name: 'exec_command',
              arguments: JSON.stringify({
                cmd: `cat ${quote(path.join(installed, 'SKILL.md'))}; ${quote(path.join(installed, 'scripts/probe.sh'))}`,
                max_output_tokens: 2000,
              }),
            }
          : {
              id: 'report',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  annotations: [],
                  text: JSON.stringify({
                    investigationId: current.investigationId,
                    turnId: current.turnId,
                    targetId: current.scope.target.targetId,
                    facts: [],
                    hypotheses: [],
                    recommendations: [],
                    missingEvidence: [],
                  }),
                },
              ],
            };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type: string, extra: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
      const id = phase + '-' + n;
      emit('response.created', {
        response: { id, object: 'response', status: 'in_progress', output: [] },
      });
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', {
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        },
      });
      res.end();
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      api.closeAllConnections();
      api.close();
    });
    await f.writeConfig({
      ...f.skillConfig,
      plugins: {
        ...f.skillConfig.plugins,
        engine: {
          ...f.skillConfig.plugins.engine!,
          config: {
            ...(f.skillConfig.plugins.engine!.config as JsonObject),
            baseUrl: `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`,
          },
        },
      },
    });
    const host = await f.loadHost();
    let handle: JsonObject | undefined;
    let previousWork = '';
    for (const mode of ['a-fresh', 'a-resume', 'b-fresh']) {
      phase = mode;
      calls = 0;
      const scope = host.authorize(principal, mode.startsWith('a') ? 'a' : 'b');
      current = {
        investigationId: 'skill-investigation-' + scope.target.targetId,
        turnId: mode,
        scope,
        message: {
          address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
          senderId: 'user',
          messageId: mode,
          text: 'Investigate this target error',
        },
      };
      const engine = host.engineFor(scope.target);
      if (mode === 'a-resume')
        await skill(path.join(previousWork, '.agents/skills'), 'work-stale', 'WORK_STALE');
      const session =
        mode === 'a-resume'
          ? await engine.resumeSession(handle!, { scope, tools: [] }, AbortSignal.timeout(15000))
          : await engine.createSession({ scope, tools: [] }, AbortSignal.timeout(15000));
      const currentHandle = session.handle as JsonObject;
      previousWork = path.join(f.root, 'codex', String(currentHandle.directoryId), 'work');
      installed = await realpath(
        path.join(
          f.root,
          'codex',
          String(currentHandle.directoryId),
          'home/.agents/skills',
          scope.target.skills![0]!.name,
        ),
      );
      try {
        let reports = 0;
        for await (const event of session.runTurn(current, AbortSignal.timeout(15000)))
          if (event.type === 'report') reports++;
        assert.equal(reports, 1);
        assert.equal(calls, 2);
        if (mode === 'a-fresh') handle = currentHandle;
      } finally {
        await session.close();
      }
    }
  },
);
