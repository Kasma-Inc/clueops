import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import github from '../../src/plugins/github/index.js';
import type { JsonObject } from '../../src/plugin-api/index.js';
const project = path.resolve(import.meta.dirname, '../..');

test('official read-only GitHub catalog relays tag/branch/default refs and native queries without host access rules', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-github-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { token: 'SYNTHETIC_TOKEN' };
  const context = {
    instanceId: 'github-a',
    configFile: path.join(root, 'plugin.yaml'),
    resolvePath: (s: string) => path.resolve(root, s),
  };
  const bindingContext = {
    investigationId: 'i',
    turnId: 't',
    targetId: 'a',
    scopeRevision: 'a'.repeat(64),
    signal: AbortSignal.timeout(20000),
  };
  const real = await github.create(config, context);
  const catalog = await real.tools!.bind(bindingContext);
  assert.equal(catalog.status, 'ready');
  if (catalog.status !== 'ready') return;
  await catalog.binding.close();
  assert.ok(catalog.definitions!.every((tool) => tool.readOnly));
  assert.ok(
    catalog.definitions!.some((tool) => tool.name === 'list_branches'),
    'relay includes native read tools outside the former local list',
  );
  assert.ok(!catalog.definitions!.some((tool) => tool.name === 'create_issue'));
  await writeFile(path.join(root, 'catalog.json'), JSON.stringify(catalog.definitions));
  const records = path.join(root, 'records.jsonl');
  const scripted = await github.create(
    {
      ...config,
      backend: {
        command: process.execPath,
        args: [
          path.join(project, 'test/fixtures/mcp-server.mjs'),
          path.join(root, 'catalog.json'),
          records,
        ],
      },
    },
    context,
  );
  assert.deepEqual(scripted.scope, { repositoryAccess: 'token' });
  const connected = await scripted.tools!.bind(bindingContext);
  assert.equal(connected.status, 'ready');
  if (connected.status !== 'ready') return;
  t.after(() => connected.binding.close());
  const call = (name: string, args: JsonObject) =>
    connected.binding.call(name, args, new AbortController().signal);
  const file = {
    owner: 'Kasma-Inc',
    repo: 'ofnil-agentic-rag',
    path: 'src/ofnil_kms/edu/workflows/grading/sub_workflow/evaluation/executors/llm_reviewer.py',
  };
  const cases: [string, JsonObject][] = [
    ['get_file_contents', { ...file, ref: 'refs/tags/v0.5.11' }],
    ['get_file_contents', { ...file, ref: 'refs/heads/feature/evaluation' }],
    ['get_file_contents', { ...file, sha: 'b'.repeat(40) }],
    ['get_file_contents', { ...file, ref: 'refs/tags/v0.5.11', sha: 'c'.repeat(40) }],
    ['get_file_contents', { ...file }],
    [
      'get_file_contents',
      { owner: 'another-org', repo: 'service', path: 'src/foo%20bar.ts', ref: 'main' },
    ],
    [
      'search_code',
      {
        query: '"Failed to load evaluation result" "llm_reviewer" repo:Kasma-Inc/ofnil-agentic-rag',
      },
    ],
    ['search_code', { query: 'timeout OR error org:another-org language:Python path:src' }],
    ['get_commit', { owner: file.owner, repo: file.repo, sha: 'refs/tags/v0.5.11' }],
    ['list_branches', { owner: file.owner, repo: file.repo }],
  ];
  for (const [name, args] of cases) {
    const result = await call(name, args);
    assert.equal(result.status, 'ok', `${name}: ${JSON.stringify(result)}`);
    if (args.ref !== undefined || args.sha !== undefined)
      assert.equal(result.resources[0]!.requestedRef, args.sha ?? args.ref);
  }
  const forwarded = (await readFile(records, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    forwarded.map((row) => [row.name, row.arguments]),
    cases,
    'parameters must not be rewritten',
  );
  assert.ok(!JSON.stringify(forwarded).includes(config.token));
  assert.equal(
    (await call('create_issue', { owner: file.owner, repo: file.repo })).failure?.code,
    'TOOL_NOT_ALLOWED',
  );
  for (const query of ['authentication_failure', 'rate_limit']) {
    const result = await call('search_code', { query });
    assert.equal(result.status, 'error');
    assert.equal(result.failure?.code, 'UPSTREAM_TOOL_FAILED');
  }
});
