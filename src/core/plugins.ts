import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stat, realpath } from 'node:fs/promises';
import { compileContract, snapshot, validators } from '../plugin-api/index.js';
import type {
  JsonObject,
  JsonValue,
  PluginDefinition,
  PluginInstance,
  PluginManifest,
  PluginScope,
  ToolDefinition,
  ToolProvider,
} from '../plugin-api/index.js';
import { readYaml, validateReferences } from './config.js';
import type { Configuration } from './config.js';
import { HostError } from './errors.js';
import { withDeadline } from './lifecycle.js';
import { runtimeDefaults } from './runtime-config.js';
import type { Redactor } from './redaction.js';

export interface LoadedPlugin {
  readonly scope: PluginScope;
  readonly instance: PluginInstance;
  readonly provider: ToolProvider | undefined;
  readonly knowledge: readonly string[];
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function moduleUrl(specifier: string, directory: string): string {
  if (path.isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../')) {
    return pathToFileURL(path.resolve(directory, specifier)).href;
  }
  if (specifier.startsWith('file:')) {
    const url = new URL(specifier);
    if (url.search || url.hash) throw new Error();
    return pathToFileURL(fileURLToPath(url)).href;
  }
  if (specifier.includes(':') || specifier.startsWith('#')) throw new Error();
  // Package specifiers resolve from the installed host, not from process.cwd().
  return import.meta.resolve(specifier);
}

export async function knowledgePaths(
  paths: readonly string[],
  directory: string,
): Promise<readonly string[]> {
  const resolved: string[] = [];
  for (const entry of paths) {
    try {
      const absolute = await realpath(path.resolve(directory, entry));
      const info = await stat(absolute);
      if (!info.isFile() && !info.isDirectory()) throw new Error();
      resolved.push(absolute);
    } catch {
      throw new HostError('KNOWLEDGE_PATH_INVALID');
    }
  }
  return Object.freeze(resolved);
}

function validateInstance(
  value: unknown,
  manifest: PluginManifest,
): asserts value is PluginInstance {
  if (!object(value) || typeof value.dispose !== 'function' || !object(value.scope))
    throw new Error();
  snapshot(value.scope);
  const has = (kind: 'engine' | 'tools' | 'channel') => manifest.capabilities.includes(kind);
  for (const kind of ['engine', 'tools', 'channel'] as const) {
    if (has(kind) !== (value[kind] !== undefined)) throw new Error();
  }
  if (has('engine')) {
    if (
      !object(value.engine) ||
      typeof value.engine.createSession !== 'function' ||
      typeof value.engine.resumeSession !== 'function' ||
      (value.engine.supportsNativeTools !== undefined &&
        typeof value.engine.supportsNativeTools !== 'boolean') ||
      (value.engine.supportsSkills !== undefined &&
        typeof value.engine.supportsSkills !== 'boolean')
    )
      throw new Error();
  }
  if (has('tools')) {
    if (
      !object(value.tools) ||
      !Array.isArray(value.tools.definitions) ||
      typeof value.tools.bind !== 'function'
    )
      throw new Error();
  }
  if (has('channel')) {
    if (
      !object(value.channel) ||
      ['start', 'stop', 'send', 'update'].some(
        (name) => typeof (value.channel as Record<string, unknown>)[name] !== 'function',
      ) ||
      (value.channel.renderReply !== undefined && typeof value.channel.renderReply !== 'function')
    )
      throw new Error();
  }
}

export async function loadPlugins(
  configuration: Configuration,
  redactor: Redactor,
): Promise<ReadonlyMap<string, LoadedPlugin>> {
  const staged = new Map<
    string,
    {
      definition: PluginDefinition;
      config: JsonValue;
      configFile: string;
      knowledge: readonly string[];
      location: string;
    }
  >();
  const modules = new Map<
    string,
    {
      definition: PluginDefinition;
      parseConfig(value: unknown): JsonValue;
      knowledge: readonly string[];
    }
  >();
  for (const [instanceId, entry] of Object.entries(configuration.composition.plugins)) {
    if (entry.enabled === false) continue;
    const location = entry.location ?? instanceId;
    let url: string;
    try {
      url = moduleUrl(entry.module, configuration.directory);
    } catch {
      throw new HostError('PLUGIN_LOAD_FAILED', location);
    }
    let module = modules.get(url);
    if (module === undefined) {
      let imported: unknown;
      try {
        imported = ((await import(url)) as { default?: unknown }).default;
      } catch {
        throw new HostError('PLUGIN_LOAD_FAILED', location);
      }
      try {
        if (!object(imported) || typeof imported.create !== 'function') throw new Error();
        const manifest = validators.pluginManifest.parse(imported.manifest);
        const factory = imported.create as PluginDefinition['create'];
        const definition: PluginDefinition = {
          manifest,
          create: (config, context) => factory.call(imported, config, context),
        };
        const parser = compileContract<JsonValue>(manifest.configSchema, 'plugin config');
        const knowledge = await knowledgePaths(
          manifest.knowledge ?? [],
          path.dirname(fileURLToPath(url)),
        );
        module = { definition, parseConfig: (value) => parser.parse(value), knowledge };
        modules.set(url, module);
      } catch {
        throw new HostError('PLUGIN_CONTRACT_INVALID', location);
      }
    }
    const configFile = entry.configFile ?? entry.sourceFile ?? configuration.file;
    const raw = entry.configFile !== undefined ? await readYaml(configFile) : (entry.config ?? {});
    if (entry.capability && !module.definition.manifest.capabilities.includes(entry.capability))
      throw new HostError('PLUGIN_REFERENCE_INVALID', entry.location ?? instanceId);
    let config: JsonValue;
    try {
      config = module.parseConfig(raw);
    } catch {
      throw new HostError('PLUGIN_CONFIG_INVALID', location);
    }
    staged.set(instanceId, {
      definition: module.definition,
      config,
      configFile,
      knowledge: module.knowledge,
      location,
    });
  }
  validateReferences(
    configuration.composition,
    new Map([...staged].map(([id, item]) => [id, item.definition.manifest])),
  );

  const loaded = new Map<string, LoadedPlugin>();
  const disposers: Array<() => Promise<void>> = [];
  const instances = new Set<unknown>();
  try {
    for (const [instanceId, item] of staged) {
      let instance: unknown;
      try {
        instance = await item.definition.create(
          item.config,
          Object.freeze({
            instanceId,
            configFile: item.configFile,
            stateDirectory: path.join(
              path.resolve(
                configuration.directory,
                configuration.composition.runtime?.stateDirectory ?? runtimeDefaults.stateDirectory,
              ),
              'plugins',
              instanceId,
            ),
            resolvePath: (entry: string) => path.resolve(path.dirname(item.configFile), entry),
            registerSecrets: (values: readonly string[]) => redactor.add(values),
          }),
        );
        if (instances.has(instance)) throw new Error();
        instances.add(instance);
        if (object(instance) && typeof instance.dispose === 'function') {
          const disposable = instance as unknown as PluginInstance;
          disposers.push(() => disposable.dispose());
        }
        validateInstance(instance, item.definition.manifest);
        const definitions = new Map<string, ToolDefinition>();
        for (const raw of instance.tools?.definitions ?? []) {
          const definition = validators.toolDefinition.parse(raw);
          if (definitions.has(definition.name)) throw new Error();
          compileContract(definition.inputSchema, 'tool input');
          definitions.set(definition.name, definition);
        }
        const scope: PluginScope = snapshot({
          instanceId,
          pluginId: item.definition.manifest.id,
          pluginVersion: item.definition.manifest.version,
          apiVersion: 1,
          resources: instance.scope as JsonObject,
        });
        const tools = instance.tools;
        const provider: ToolProvider | undefined =
          tools === undefined
            ? undefined
            : Object.freeze({
                definitions: Object.freeze([...definitions.values()]),
                bind: (context: Parameters<ToolProvider['bind']>[0]) => tools.bind(context),
              });
        loaded.set(instanceId, {
          instance,
          scope,
          provider,
          knowledge: item.knowledge,
        });
      } catch {
        throw new HostError('PLUGIN_INITIALIZATION_FAILED', item.location);
      }
    }
    return loaded;
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        await withDeadline(dispose(), configuration.composition.lifecycleTimeoutMs ?? 10000);
      } catch {
        /* Continue cleaning all created instances. */
      }
    }
    throw error;
  }
}
