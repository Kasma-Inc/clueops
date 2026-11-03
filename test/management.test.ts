import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.js';
import { PluginHost } from '../src/core/host.js';
import { InvestigationStore } from '../src/core/store.js';
import { InvestigationCoordinator } from '../src/core/coordinator.js';
import { builtinPlugins } from '../src/plugins/catalog.js';
import type { RestChannel } from '../src/plugins/rest/index.js';
import type {
  AcceptanceResult,
  EvidencePage,
  InvestigationDetail,
  InvestigationPage,
  TargetOverview,
  ChannelOverview,
} from '../src/plugin-api/index.js';

const token = 'MANAGEMENT_SYNTHETIC_TOKEN';
const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const identity = { tenantId: 'tenant', conversationId: 'room', senderId: 'user' };

async function setup(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  await copyFile(
    new URL('./fixtures/investigation-plugin.mjs', import.meta.url),
    path.join(f.root, 'plugin.mjs'),
  );
  await f.writePrivate('a-tools', { resultBytes: 16000 });
  let config = {
    ...f.config,
    runtime: { stateDirectory: path.join(f.root, 'state') },
    plugins: {
      ...f.config.plugins,
      chat: { module: builtinPlugins.rest!, config: { ...identity, token, port: 0, admin: true } },
      other: { module: builtinPlugins.rest!, config: { ...identity, token, port: 0, admin: true } },
      plain: { module: builtinPlugins.rest!, config: { ...identity, token, port: 0 } },
    },
    routes: [
      ...f.config.routes,
      ...['other', 'plain'].map((channel) => ({
        channel,
        tenant: 'tenant',
        conversation: 'room',
        allowedSenders: ['user'],
        targets: ['a'],
      })),
    ],
  };
  let coordinator: InvestigationCoordinator;
  t.after(async () => {
    await coordinator?.close();
  });
  async function start() {
    await f.writeConfig(config);
    const host = await PluginHost.load(f.configFile, builtinPlugins);
    const store = await InvestigationStore.open(host.runtime.stateDirectory);
    coordinator = new InvestigationCoordinator(host, store);
    await coordinator.start();
    const base = (name = 'chat') =>
      'http://127.0.0.1:' + (host.channelFor(name) as RestChannel).address!.port;
    const get = (url: string, name = 'chat') => fetch(base(name) + url, { headers });
    const post = async (body: unknown, name = 'chat') => {
      const response = await fetch(base(name) + '/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 202);
      const reference = (await response.json()) as AcceptanceResult;
      await coordinator.idle();
      return reference;
    };
    return { host, store, base, get, post };
  }
  return {
    ...f,
    start,
    close: () => coordinator.close(),
    restrict: () => {
      config = {
        ...config,
        routes: config.routes.map((route) =>
          route.channel === 'chat' ? { ...route, targets: ['b'] } : route,
        ),
      };
    },
  };
}

test('console UI is opt-in while authenticated domain reads are independent of the UI and channel', async (t) => {
  const f = await setup(t);
  const run = await f.start();
  for (const resource of ['/admin', '/admin/', '/admin/app.js', '/admin/style.css']) {
    const response = await fetch(run.base() + resource);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!(await response.text()).includes(token));
    assert.equal((await run.get(resource, 'plain')).status, 404);
  }
  for (const resource of [
    '/api/targets',
    '/api/channels',
    '/api/investigations',
    '/api/investigations/unknown',
    '/api/investigations/unknown/evidence?turnId=x',
  ]) {
    assert.equal((await fetch(run.base() + resource)).status, 401);
    assert.equal(
      (await run.get(resource, 'plain')).status,
      ['/api/targets', '/api/channels', '/api/investigations'].includes(resource) ? 200 : 403,
    );
  }
  assert.equal(
    (await fetch(run.base() + '/api/targets', { method: 'POST', headers, body: '{}' })).status,
    405,
  );
  assert.equal((await run.get('/api/unknown')).status, 404);
  for (const query of [
    '?limit=0',
    '?limit=51',
    '?before=-1',
    '?before=9007199254740992',
    '?search=' + 'x'.repeat(201),
    '?status=unknown',
    '?senderId=admin',
    '?limit=1&limit=2',
    '?targetId=../secret',
  ])
    assert.equal((await run.get('/api/investigations' + query)).status, 400, query);
});

test('channel info reads safe current identities without scanning history and respects target grants', async (t) => {
  const f = await setup(t);
  let run = await f.start();
  run.host.channelFor('chat').describe = () => ({
    publicId: 'public-runtime-identity',
    appSecret: 'SYNTHETIC_PRIVATE',
    note: token,
  });
  const scan = t.mock.method(run.store, 'acceptances');
  const read = async (name = 'chat') => {
    const response = await run.get('/api/channels', name);
    assert.equal(response.status, 200);
    return ((await response.json()) as { channels: ChannelOverview[] }).channels;
  };
  assert.equal((await run.get('/api/channels?senderId=admin')).status, 400);
  const channels = await read('other');
  const chat = channels.find((channel) => channel.scope.instanceId === 'chat')!;
  assert.deepEqual(chat.targets, ['a']);
  assert.equal(chat.scope.resources.conversationId, identity.conversationId);
  assert.equal(chat.details.publicId, 'public-runtime-identity');
  assert.equal(chat.details.appSecret, '[REDACTED]');
  assert.equal(chat.details.note, '[REDACTED]');
  for (const secret of [token, 'SYNTHETIC_PRIVATE', 'configFile', f.root])
    assert.ok(!JSON.stringify(channels).includes(secret), secret);
  run.host.redactor.add(['0', 'rest', 'a']);
  const safe = (await read()).find((channel) => channel.scope.instanceId === 'chat')!;
  assert.equal(safe.scope.pluginId, 'rest');
  assert.deepEqual(safe.targets, ['a', 'b']);
  assert.equal(scan.mock.callCount(), 0, 'channel reads must not scan investigation history');
  scan.mock.restore();
  await f.close();
  f.restrict();
  run = await f.start();
  const restricted = await read();
  assert.deepEqual(
    restricted.map((channel) => channel.scope.instanceId),
    ['chat'],
  );
  assert.deepEqual(restricted[0]!.targets, ['b']);
});

test('management lists only authorized investigations before pagination, redacts input, and preserves diagnostic status', async (t) => {
  const f = await setup(t);
  const run = await f.start();
  const first = await run.post({
    messageId: 'first',
    targetId: 'a',
    text: '<script>error</script> password=private-value ' + token,
  });
  await run.post({ messageId: 'foreign', targetId: 'a', text: 'other-source-private' }, 'other');
  const second = await run.post({
    messageId: 'second',
    targetId: 'b',
    text: 'second investigation',
  });
  let page = (await (await run.get('/api/investigations?limit=1')).json()) as InvestigationPage;
  assert.equal(page.investigations.length, 1);
  assert.equal(page.investigations[0]!.investigationId, second.investigationId);
  assert.ok(page.nextBefore);
  page = (await (
    await run.get('/api/investigations?limit=1&before=' + page.nextBefore)
  ).json()) as InvestigationPage;
  assert.notEqual(page.investigations[0]!.investigationId, first.investigationId);
  assert.ok(page.nextBefore);
  page = (await (
    await run.get('/api/investigations?limit=1&before=' + encodeURIComponent(page.nextBefore!))
  ).json()) as InvestigationPage;
  assert.equal(page.investigations[0]!.investigationId, first.investigationId);
  assert.equal(page.nextBefore, null);
  assert.ok(!JSON.stringify(page).includes('private-value'));
  assert.ok(!JSON.stringify(page).includes(token));
  assert.ok(!JSON.stringify(page).includes('sessionHandle'));
  const filtered = (await (
    await run.get('/api/investigations?targetId=a&status=completed&search=script')
  ).json()) as InvestigationPage;
  assert.equal(filtered.investigations.length, 1);
  assert.equal(
    (await run.get('/api/investigations/' + first.investigationId, 'other')).status,
    200,
  );
  assert.equal((await run.get('/api/investigations/unknown')).status, 403);
  await run.post({
    messageId: 'status',
    investigationId: first.investigationId,
    action: 'status',
    text: 'status',
  });
  const detail = (await (
    await run.get('/api/investigations/' + first.investigationId)
  ).json()) as InvestigationDetail;
  assert.equal(detail.investigation.status, 'completed');
  assert.equal(detail.investigation.turnCount, 1);
  assert.equal(detail.turns.at(-1)!.status, 'handled');
});

test('management redacts data while keeping typed report, evidence and target identifiers intact', async (t) => {
  const f = await setup(t);
  const run = await f.start();
  const first = await run.post({ messageId: 'typed-identity', targetId: 'a', text: 'investigate' });
  const route = '/api/investigations/' + first.investigationId;
  const original = (await (await run.get(route)).json()) as InvestigationDetail;
  const stored = await run.store.evidence(first.turnId);
  run.host.redactor.add(['a', 'engine', 'a-tools', 'completed', 'ok', first.investigationId]);

  const detail = (await (await run.get(route)).json()) as InvestigationDetail;
  const report = detail.turns[0]!.report!;
  assert.equal(detail.investigation.status, 'completed');
  assert.equal(report.targetId, 'a');
  assert.equal(report.investigationId, first.investigationId);
  assert.equal(report.turnId, first.turnId);
  assert.deepEqual(
    report.facts.map((fact) => fact.evidenceIds),
    original.turns[0]!.report!.facts.map((fact) => fact.evidenceIds),
  );

  const page = (await (
    await run.get(route + '/evidence?turnId=' + first.turnId)
  ).json()) as EvidencePage;
  for (const evidence of page.evidence) {
    const source = stored.find((item) => item.id === evidence.id)!;
    assert.ok(source);
    assert.equal(evidence.status, source.status);
    assert.equal(evidence.targetId, source.targetId);
    assert.equal(evidence.providerInstanceId, source.providerInstanceId);
    assert.equal(evidence.investigationId, first.investigationId);
    assert.ok(!JSON.stringify(evidence.resources).includes('a-tools'));
    assert.ok(!evidence.contentPreview.includes('TEST_SECRET_'));
  }
  const targets = ((await (await run.get('/api/targets')).json()) as { targets: TargetOverview[] })
    .targets;
  const target = targets.find((entry) => entry.targetId === 'a')!;
  assert.equal(target.engine.instanceId, 'engine');
  assert.equal(target.tools[0]!.instanceId, 'a-tools');
  assert.ok(!JSON.stringify(target.engine.resources).includes('engine'));
});

test('management details, evidence previews and follow-ups paginate safely and survive restart', async (t) => {
  const f = await setup(t);
  let run = await f.start();
  const first = await run.post({ messageId: 'original', targetId: 'a', text: 'investigate' });
  const followup = {
    messageId: 'followup',
    investigationId: first.investigationId,
    text: 'explain more',
  };
  const second = await run.post(followup);
  await run.post(followup);
  assert.equal(
    run.store.acceptances().length,
    2,
    'retry of a follow-up must not create another turn',
  );
  const route = '/api/investigations/' + first.investigationId;
  let detail = (await (await run.get(route + '?limit=1')).json()) as InvestigationDetail;
  assert.equal(detail.turns[0]!.turnId, second.turnId);
  assert.equal(detail.investigation.turnCount, 2);
  assert.ok(detail.nextBefore);
  detail = (await (
    await run.get(route + '?limit=1&before=' + detail.nextBefore)
  ).json()) as InvestigationDetail;
  assert.equal(detail.turns[0]!.turnId, first.turnId);
  assert.equal(detail.nextBefore, null);
  assert.ok(detail.turns[0]!.report);
  assert.ok(detail.turns[0]!.evidenceCount);
  const evidenceRoute = route + '/evidence?turnId=' + first.turnId;
  const inputEvidence = (await (await run.get(evidenceRoute + '&limit=1')).json()) as EvidencePage;
  assert.equal(inputEvidence.evidence.length, 1);
  assert.equal(inputEvidence.nextOffset, 1);
  const evidence = (await (
    await run.get(evidenceRoute + '&limit=1&offset=' + inputEvidence.nextOffset)
  ).json()) as EvidencePage;
  assert.equal(evidence.evidence.length, 1);
  assert.ok(evidence.evidence[0]!.previewTruncated);
  assert.equal(evidence.evidence[0]!.contentPreview.length, 12000);
  assert.ok(!JSON.stringify(evidence).includes('TEST_SECRET_a-tools'));
  assert.equal((await run.get(evidenceRoute, 'other')).status, 200);
  assert.equal((await run.get(route + '/evidence?turnId=unknown')).status, 403);
  assert.equal((await run.get(route + '/evidence')).status, 400);
  assert.equal((await run.get(evidenceRoute + '&offset=-1')).status, 400);
  await f.close();
  run = await f.start();
  const restored = (await (await run.get(route)).json()) as InvestigationDetail;
  assert.equal(restored.turns.length, 2);
  assert.equal(restored.turns[0]!.evidenceCount, detail.turns[0]!.evidenceCount);
  assert.deepEqual(await (await run.get(evidenceRoute + '&limit=1&offset=1')).json(), evidence);
});

test('target overview contains current safe scopes and revocation also removes old history', async (t) => {
  const f = await setup(t);
  let run = await f.start();
  const first = await run.post({ messageId: 'original', targetId: 'a', text: 'investigate' });
  const overview = (await (await run.get('/api/targets', 'other')).json()) as {
    targets: TargetOverview[];
  };
  assert.deepEqual(
    overview.targets.map((target) => target.targetId),
    ['a'],
  );
  assert.equal(overview.targets[0]!.tools.length, 1);
  for (const secret of ['credential', 'configFile', 'TEST_SECRET_', 'sessionHandle', f.root])
    assert.ok(!JSON.stringify(overview).includes(secret), secret);
  await f.close();
  f.restrict();
  run = await f.start();
  const page = (await (await run.get('/api/investigations')).json()) as InvestigationPage;
  assert.deepEqual(page.investigations, []);
  assert.equal((await run.get('/api/investigations/' + first.investigationId)).status, 403);
  assert.equal(
    (
      await run.get(
        '/api/investigations/' + first.investigationId + '/evidence?turnId=' + first.turnId,
      )
    ).status,
    403,
  );
  const targets = (await (await run.get('/api/targets')).json()) as { targets: TargetOverview[] };
  assert.deepEqual(
    targets.targets.map((target) => target.targetId),
    ['b'],
  );
});

test('management pagination traverses more than twenty independent single-turn investigations', async (t) => {
  const f = await setup(t);
  const run = await f.start();
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) {
    const accepted = await run.post({ messageId: 'page-' + i, targetId: 'b', text: 'record ' + i });
    ids.push(accepted.investigationId);
  }
  const first = (await (await run.get('/api/investigations?limit=20')).json()) as InvestigationPage;
  assert.equal(first.investigations.length, 20);
  assert.ok(first.nextBefore);
  const second = (await (
    await run.get('/api/investigations?limit=20&before=' + encodeURIComponent(first.nextBefore!))
  ).json()) as InvestigationPage;
  assert.equal(second.investigations.length, 1);
  assert.equal(second.nextBefore, null);
  assert.deepEqual(
    [...first.investigations, ...second.investigations].map((item) => item.investigationId),
    ids.reverse(),
  );
});
