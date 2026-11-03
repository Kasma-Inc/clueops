import { parseArgs } from 'node:util';
import { PluginHost } from './core/index.js';
import { InvestigationStore } from './core/store.js';
import { InvestigationCoordinator } from './core/coordinator.js';
import { builtinPlugins } from './plugins/catalog.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { config: { type: 'string' }, 'check-config': { type: 'boolean' } },
  });
  if (!values.config) {
    throw new Error('Usage: npm start -- [--check-config] --config <file.yaml>');
  }
  const host = await PluginHost.load(values.config, builtinPlugins);
  if (values['check-config'])
    try {
      // Administrative output only: safe identities, never plugin configs or connection strings.
      process.stdout.write(
        JSON.stringify({
          status: 'valid',
          plugins: host
            .describePlugins()
            .map((scope) => ({ instanceId: scope.instanceId, pluginId: scope.pluginId })),
        }) + '\n',
      );
    } finally {
      await host.close();
    }
  else {
    let store: InvestigationStore;
    try {
      store = await InvestigationStore.open(host.runtime.stateDirectory);
    } catch (error) {
      await host.close();
      throw error;
    }
    const coordinator = new InvestigationCoordinator(host, store);
    let stop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    let shutdown: Promise<void> | undefined;
    const shutdownNow = () => {
      shutdown ??= coordinator.close();
      void shutdown.catch(() => {}); // The same promise is awaited in finally.
      return shutdown;
    };
    const onSignal = () => {
      stop?.();
      shutdownNow();
    };
    // A channel may be idle without an open socket; the daemon still owns its lifetime.
    const keepAlive = setInterval(() => {}, 60000);
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      await coordinator.start();
      if (!shutdown) {
        process.stdout.write(
          JSON.stringify({
            status: 'running',
            plugins: host.describePlugins().map((p) => p.instanceId),
          }) + '\n',
        );
        await stopped;
      }
    } catch (error) {
      if (!shutdown) throw error;
    } finally {
      clearInterval(keepAlive);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      await shutdownNow();
      process.stdout.write(
        JSON.stringify({ status: 'stopped', metrics: coordinator.metrics }) + '\n',
      );
    }
  }
}

try {
  await main();
} catch (error) {
  // Unknown errors from parsers/plugins can contain credentials; print only safe host errors.
  const { HostError } = await import('./core/errors.js');
  process.stderr.write(
    (error instanceof HostError
      ? error.message
      : 'START_FAILED: use --check-config --config <file.yaml>') + '\n',
  );
  process.exitCode = 1;
}
