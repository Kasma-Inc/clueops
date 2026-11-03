import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, release } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { PluginHost } from '../src/core/host.js';
import { InvestigationStore } from '../src/core/store.js';
import { InvestigationCoordinator } from '../src/core/coordinator.js';
const root = await mkdtemp(path.join(tmpdir(), 'incident-benchmark-'));
const moduleFile = path.resolve(import.meta.dirname, '../test/fixtures/investigation-plugin.mjs');
const plugin = (resourceId: string) => ({
  plugin: moduleFile,
  config: {
    resourceId,
    credential: 'SYNTHETIC_BENCHMARK',
    delayMs: 25,
    resultBytes: 1024,
    eventsFile: './events.jsonl',
  },
});
for (const target of ['a', 'b'])
  await writeFile(
    path.join(root, target + '.yaml'),
    stringify({ tools: [{ name: 'evidence', ...plugin(target + '-tools') }] }),
  );
await writeFile(
  path.join(root, 'config.yaml'),
  stringify({
    version: 1,
    runtime: {
      stateDirectory: './state',
      globalConcurrency: 4,
      targetConcurrency: 2,
      maxQueuedTurns: 128,
    },
    agent: plugin('engine'),
    targets: { a: './a.yaml', b: './b.yaml' },
    channels: {
      chat: {
        ...plugin('chat'),
        routes: ['a', 'b'].map((id) => ({
          tenant: 'tenant',
          conversation: 'room-' + id,
          allowedSenders: ['user'],
          targets: [id],
        })),
      },
    },
  }),
);
const host = await PluginHost.load(path.join(root, 'config.yaml'));
const store = await InvestigationStore.open(host.runtime.stateDirectory);
const coordinator = new InvestigationCoordinator(host, store);
try {
  await coordinator.start();
  const start = performance.now();
  const acceptanceLatency: number[] = [];
  const first = await Promise.all(
    Array.from({ length: 24 }, async (_, i) => {
      const at = performance.now();
      const result = await coordinator.handle({
        address: {
          channelInstanceId: 'chat',
          tenantId: 'tenant',
          conversationId: 'room-' + (i % 2 ? 'a' : 'b'),
        },
        senderId: 'user',
        messageId: 'initial-' + i,
        text: 'ERROR web',
        targetId: i % 2 ? 'a' : 'b',
      });
      acceptanceLatency.push(performance.now() - at);
      return result;
    }),
  );
  await Promise.all(
    first.map(async (item, i) => {
      if (item.status !== 'accepted') throw new Error();
      return coordinator.handle({
        address: {
          channelInstanceId: 'chat',
          tenantId: 'tenant',
          conversationId: 'room-' + (i % 2 ? 'a' : 'b'),
        },
        senderId: 'user',
        messageId: 'follow-' + i,
        text: 'followup',
        investigationId: item.investigationId,
      });
    }),
  );
  await coordinator.idle();
  const elapsedMs = performance.now() - start;
  const { measurements } = await import(moduleFile);
  const events = (await readFile(path.join(root, 'events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  const queues = events
    .filter((e) => e.action === 'run')
    .map(
      (e) =>
        e.at -
        Date.parse(store.acceptances().find((a) => a.request.turnId === e.turnId)!.acceptedAt),
    )
    .sort((a, b) => a - b);
  acceptanceLatency.sort((a, b) => a - b);
  const percentile = (values: number[], fraction: number) =>
    Math.round(values[Math.min(values.length - 1, Math.floor(values.length * fraction))]! * 10) /
    10;
  if (
    coordinator.metrics.peakRunning > 4 ||
    measurements.activeBindings !== 0 ||
    Object.values(measurements.targetPeak).some((peak) => Number(peak) > 2) ||
    store.acceptances().some((a) => store.turn(a.request.turnId).status !== 'completed')
  )
    throw new Error('Benchmark invariant failed');
  process.stdout.write(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          platform: platform(),
          arch: arch(),
          release: release(),
        },
        workload: {
          targets: 2,
          events: 24,
          rounds: 48,
          resultBytes: 1024,
          syntheticQueryDelayMs: 25,
        },
        elapsedMs: Math.round(elapsedMs),
        acceptanceP50Ms: percentile(acceptanceLatency, 0.5),
        acceptanceP95Ms: percentile(acceptanceLatency, 0.95),
        queueP50Ms: percentile(queues, 0.5),
        queueP95Ms: percentile(queues, 0.95),
        metrics: coordinator.metrics,
        bindings: measurements,
        delivered: store.deliveries().filter((d) => d.status === 'sent').length,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await coordinator.close();
  await rm(root, { recursive: true, force: true });
}
