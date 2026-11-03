import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { definePlugin, objectSchema } from '../../plugin-api/index.js';
import type { JsonObject, JsonValue } from '../../plugin-api/index.js';
import { readYaml } from '../../core/config.js';
import { HostError } from '../../core/errors.js';
import { mcpProvider } from '../../mcp/process.js';
import {
  backend,
  backendSchema,
  object,
  positive,
  packagedPath,
  privateRedactor,
  text,
  writeToml,
} from '../shared.js';

interface Config {
  backend?: { command: string; args?: string[] };
  resourceId?: string;
  kubeconfig: string;
  context: string;
  maxResultBytes?: number;
}
function named(list: unknown, name: unknown, field: string): JsonObject {
  if (!Array.isArray(list)) throw new HostError('KUBECONFIG_INVALID');
  const matches = list.filter((item) => object(item) && item.name === name);
  if (matches.length !== 1 || !object(matches[0][field]))
    throw new HostError('KUBECONFIG_REFERENCE_INVALID');
  return matches[0][field];
}
export default definePlugin<Config>({
  manifest: {
    id: 'kubernetes-mcp',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['tools'],
    configSchema: objectSchema(
      {
        backend: backendSchema,
        resourceId: text,
        kubeconfig: text,
        context: text,
        maxResultBytes: positive,
      },
      ['kubeconfig', 'context'],
    ),
  },
  async create(config, context) {
    const executable = await backend(config.backend, context, {
      command: packagedPath('.clueops/bin/kubernetes-mcp-server'),
    });
    const resourceId = config.resourceId ?? context.instanceId;
    const configFile = context.resolvePath(config.kubeconfig);
    const loaded = await readYaml(configFile);
    if (!object(loaded)) throw new HostError('KUBECONFIG_INVALID');
    const selected = named(loaded.contexts, config.context, 'context');
    const cluster = { ...named(loaded.clusters, selected.cluster, 'cluster') };
    const user = { ...named(loaded.users, selected.user, 'user') };
    if (typeof cluster.server !== 'string' || !/^https?:\/\//.test(cluster.server))
      throw new HostError('KUBECONFIG_SERVER_INVALID');
    const serverUrl = new URL(cluster.server);
    if (serverUrl.username || serverUrl.password || serverUrl.search || serverUrl.hash)
      throw new HostError('KUBECONFIG_SERVER_INVALID');
    if ('auth-provider' in user) throw new HostError('KUBECONFIG_AUTH_PROVIDER_UNSUPPORTED');
    for (const [holder, source, target] of [
      [cluster, 'certificate-authority', 'certificate-authority-data'],
      [user, 'client-certificate', 'client-certificate-data'],
      [user, 'client-key', 'client-key-data'],
    ] as const) {
      if (typeof holder[source] === 'string') {
        holder[target] = (
          await readFile(path.resolve(path.dirname(configFile), holder[source]))
        ).toString('base64');
        delete holder[source];
      }
    }
    if (typeof user.tokenFile === 'string') {
      user.token = (
        await readFile(path.resolve(path.dirname(configFile), user.tokenFile), 'utf8')
      ).trim();
      delete user.tokenFile;
    }
    const secrets = Object.entries(user)
      .filter(
        ([key, value]) =>
          typeof value === 'string' && /token|password|key-data|certificate-data/.test(key),
      )
      .map(([, value]) => value as string);
    const redactor = privateRedactor(secrets, context);
    const kubeconfig = {
      apiVersion: 'v1',
      kind: 'Config',
      'current-context': 'target',
      clusters: [{ name: 'target', cluster }],
      users: [{ name: 'target', user }],
      contexts: [
        {
          name: 'target',
          context: {
            cluster: 'target',
            user: 'target',
            ...(selected.namespace ? { namespace: selected.namespace } : {}),
          },
        },
      ],
    };
    const trim = (value: unknown): JsonValue => {
      if (Array.isArray(value)) return value.map(trim);
      if (object(value))
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !['managedFields', 'annotations'].includes(key))
            .map(([key, item]) => [
              key,
              key === 'value' && typeof value.name === 'string'
                ? '[REDACTED]'
                : key === 'text' && typeof item === 'string'
                  ? trimText(item)
                  : trim(item),
            ]),
        );
      return redactor.value(value);
    };
    const trimText = (value: string): JsonValue => {
      try {
        const parsed: unknown = parse(value, { maxAliasCount: 20 });
        if (object(parsed) || Array.isArray(parsed)) return trim(parsed);
      } catch {
        /* Logs are not required to be YAML. */
      }
      return redactor.text(value);
    };
    return {
      scope: {
        resourceId,
        server: cluster.server,
        context: config.context,
        clusterIdentity: selected.cluster!,
        accountIdentity: selected.user!,
        defaultNamespace: selected.namespace ?? 'default',
      },
      tools: mcpProvider({
        startupTimeoutMs: 15000,
        queryTimeoutMs: 15000,
        maxResultBytes: config.maxResultBytes ?? 131072,
        failureRemoteStatus: 'unknown',
        async command(_binding, directory) {
          const kubeFile = path.join(directory, 'kubeconfig');
          await writeFile(kubeFile, stringify(kubeconfig), { mode: 0o600 });
          const file = await writeToml(directory, {
            kubeconfig: kubeFile,
            cluster_provider_strategy: 'kubeconfig',
            toolsets: ['core'],
            list_output: 'yaml',
            log_file: 'stderr',
            stateless: true,
            max_backend_response_bytes: config.maxResultBytes ?? 131072,
            max_result_bytes: config.maxResultBytes ?? 131072,
          });
          return {
            command: executable.command,
            args: [...(executable.args ?? []), '--config', file],
          };
        },
        prepare(_name, input) {
          return input;
        },
        resources(name, input) {
          return [
            {
              resourceId,
              tool: name,
              namespace: input.namespace ?? null,
              name: input.name ?? null,
              container: input.container ?? null,
              previous: input.previous ?? false,
              kind: input.kind ?? null,
              apiVersion: input.apiVersion ?? null,
              timeRange: 'unknown',
              ...(name === 'pods_log'
                ? {
                    coverage: '最近有限行日志；不支持精确时间过滤，历史日志可能已丢失。',
                    tail: input.tail ?? 100,
                  }
                : {}),
            },
          ];
        },
        truncated(name, _input, content) {
          const metadata = object(content) && object(content.metadata) ? content.metadata : content;
          return (
            name === 'pods_log' ||
            (object(metadata) &&
              ((typeof metadata.continue === 'string' && metadata.continue.length > 0) ||
                (typeof metadata.remainingItemCount === 'number' &&
                  metadata.remainingItemCount > 0)))
          );
        },
        sanitize: trim,
      }),
      async dispose() {},
    };
  },
});
