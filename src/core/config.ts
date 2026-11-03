import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { compileContract, jsonValue, objectSchema, snapshot } from '../plugin-api/index.js';
import type { JsonValue, PluginManifest } from '../plugin-api/index.js';
import { HostError } from './errors.js';
import { runtimeSchema } from './runtime-config.js';
import type { RuntimeSettings } from './runtime-config.js';
import { fingerprint } from './identity.js';

export interface PluginConfig {
  readonly module: string;
  readonly configFile?: string;
  readonly config?: JsonValue;
  readonly sourceFile?: string;
  readonly location?: string;
  readonly capability?: 'engine' | 'tools' | 'channel';
  readonly enabled?: boolean;
}

export interface PluginDeclaration {
  readonly plugin: string;
  readonly config?: JsonValue;
  readonly configFile?: string;
  readonly enabled?: boolean;
}
export interface TargetFile {
  readonly agent?: PluginDeclaration;
  readonly tools: readonly ({ readonly name: string } & (
    PluginDeclaration | { readonly use: string }
  ))[];
  readonly knowledge?: readonly string[];
  readonly skills?: readonly string[];
}
export interface ServiceConfig {
  readonly version: 1;
  readonly runtime?: Partial<RuntimeSettings>;
  readonly lifecycleTimeoutMs?: number;
  readonly agent?: PluginDeclaration;
  readonly plugins?: Readonly<Record<string, string>>;
  readonly sharedTools?: Readonly<Record<string, PluginDeclaration>>;
  readonly targets: Readonly<Record<string, string>>;
  readonly channels: Readonly<
    Record<
      string,
      PluginDeclaration & {
        readonly routes?: readonly (Omit<RouteConfig, 'channel' | 'targets'> & {
          readonly targets?: readonly string[];
        })[];
      }
    >
  >;
}
export interface TargetConfig {
  readonly engine: string;
  readonly tools: readonly string[];
  readonly knowledge?: readonly string[];
  readonly skills?: readonly string[];
}
export interface RouteConfig {
  readonly channel: string;
  readonly tenant?: string;
  readonly conversation?: string;
  readonly allowedSenders?: readonly string[];
  readonly targets: readonly string[];
}
export interface CompositionConfig {
  readonly version: 1;
  readonly lifecycleTimeoutMs?: number;
  readonly runtime?: Partial<RuntimeSettings>;
  readonly plugins: Readonly<Record<string, PluginConfig>>;
  readonly targets: Readonly<Record<string, TargetConfig>>;
  readonly routes: readonly RouteConfig[];
}
export interface Configuration {
  readonly file: string;
  readonly directory: string;
  readonly composition: CompositionConfig;
}

const text = { type: 'string', minLength: 1 } as const;
const id = { ...text, maxLength: 128, pattern: '^[A-Za-z][A-Za-z0-9_-]*$' } as const;
const ids = { type: 'array', uniqueItems: true, items: id } as const;
const declarationProperties = {
  plugin: text,
  config: {},
  configFile: text,
  enabled: { type: 'boolean' },
} as const;
const declaration = {
  ...objectSchema(declarationProperties, ['plugin']),
  not: { properties: { config: {}, configFile: {} }, required: ['config', 'configFile'] },
};
const route = objectSchema(
  {
    tenant: text,
    conversation: text,
    allowedSenders: { type: 'array', uniqueItems: true, items: text },
    targets: ids,
  },
  [],
);
const serviceSchema = objectSchema(
  {
    version: { const: 1 },
    lifecycleTimeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
    runtime: runtimeSchema,
    agent: declaration,
    plugins: { type: 'object', propertyNames: id, additionalProperties: text },
    sharedTools: { type: 'object', propertyNames: id, additionalProperties: declaration },
    targets: {
      type: 'object',
      minProperties: 1,
      propertyNames: id,
      additionalProperties: text,
    },
    channels: {
      type: 'object',
      propertyNames: id,
      additionalProperties: {
        ...objectSchema({ ...declarationProperties, routes: { type: 'array', items: route } }, [
          'plugin',
        ]),
        not: { properties: { config: {}, configFile: {} }, required: ['config', 'configFile'] },
      },
    },
  },
  ['version', 'targets', 'channels'],
);
const validator = compileContract<ServiceConfig>(serviceSchema, 'service config');
const targetValidator = compileContract<TargetFile>(
  objectSchema(
    {
      agent: declaration,
      tools: {
        type: 'array',
        items: {
          oneOf: [
            {
              ...objectSchema({ name: id, ...declarationProperties }, ['name', 'plugin']),
              not: {
                properties: { config: {}, configFile: {} },
                required: ['config', 'configFile'],
              },
            },
            objectSchema({ name: id, use: id }),
          ],
        },
      },
      knowledge: { type: 'array', uniqueItems: true, items: text },
      skills: { type: 'array', uniqueItems: true, items: text },
    },
    ['tools'],
  ),
  'target config',
);

function modulePath(value: string, directory: string): string {
  return path.isAbsolute(value) || value.startsWith('./') || value.startsWith('../')
    ? path.resolve(directory, value)
    : value;
}
export function targetInstanceId(target: string, name: string, capability = 'tools'): string {
  return `${capability}_${target.slice(0, 32)}_${name.slice(0, 32)}_${fingerprint([target, name, capability]).slice(0, 12)}`;
}

/** Parse exactly one YAML 1.2 document; errors never echo private source lines. */
export async function readYaml(file: string): Promise<JsonValue> {
  let contents: string;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error();
    contents = await readFile(file, 'utf8');
    if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error();
  } catch {
    throw new HostError('CONFIG_READ_FAILED', file);
  }
  try {
    const document = parseDocument(contents, {
      version: '1.2',
      resolveKnownTags: false,
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (
      document.errors.length ||
      document.warnings.length ||
      document.directives.yaml.version !== '1.2'
    )
      throw new Error();
    return jsonValue(document.toJS({ maxAliasCount: 50 }));
  } catch {
    throw new HostError('CONFIG_PARSE_FAILED', file);
  }
}

export async function readConfiguration(
  file: string,
  catalog: Readonly<Record<string, string>> = {},
): Promise<Configuration> {
  const absolute = path.resolve(file);
  const value = await readYaml(absolute);
  let config: ServiceConfig;
  try {
    config = validator.parse(value);
  } catch {
    throw new HostError('CONFIG_INVALID', absolute);
  }
  const directory = path.dirname(absolute);
  const registry = {
    ...catalog,
    ...Object.fromEntries(
      Object.entries(config.plugins ?? {}).map(([name, entry]) => [
        name,
        modulePath(entry, directory),
      ]),
    ),
  };
  const plugins: Record<string, PluginConfig> = {};
  const targets: Record<string, TargetConfig> = {};
  const routes: RouteConfig[] = [];
  function add(
    instanceId: string,
    declaration: PluginDeclaration,
    sourceFile: string,
    location: string,
    capability: 'engine' | 'tools' | 'channel',
  ): void {
    if (Object.hasOwn(plugins, instanceId)) throw new HostError('PLUGIN_ID_CONFLICT', location);
    plugins[instanceId] = {
      module: Object.hasOwn(registry, declaration.plugin)
        ? registry[declaration.plugin]!
        : modulePath(declaration.plugin, path.dirname(sourceFile)),
      sourceFile,
      location: sourceFile + '#' + location,
      capability,
      ...(declaration.configFile !== undefined
        ? { configFile: path.resolve(path.dirname(sourceFile), declaration.configFile) }
        : { config: declaration.config ?? {} }),
      ...(declaration.enabled !== undefined ? { enabled: declaration.enabled } : {}),
    };
  }
  if (config.agent) add('engine', config.agent, absolute, 'agent', 'engine');
  for (const [name, item] of Object.entries(config.sharedTools ?? {}))
    add(name, item, absolute, 'sharedTools.' + name, 'tools');
  // Read every target and validate references before plugin creation acquires any resources.
  for (const [targetId, reference] of Object.entries(config.targets)) {
    const sourceFile = path.resolve(directory, reference);
    let target: TargetFile;
    try {
      target = targetValidator.parse(await readYaml(sourceFile));
    } catch (error) {
      if (error instanceof HostError) throw error;
      throw new HostError('TARGET_CONFIG_INVALID', sourceFile);
    }
    const engine = target.agent ? targetInstanceId(targetId, 'agent', 'engine') : 'engine';
    if (target.agent) add(engine, target.agent, sourceFile, 'agent', 'engine');
    if (!target.agent && !config.agent) throw new HostError('AGENT_REQUIRED', sourceFile);
    const tools: string[] = [];
    const names = new Set<string>();
    for (const item of target.tools) {
      const name = item.name;
      if (names.has(name))
        throw new HostError('DUPLICATE_TOOL_NAME', sourceFile + '#tools.' + name);
      names.add(name);
      if ('use' in item) {
        if (!Object.hasOwn(config.sharedTools ?? {}, item.use))
          throw new HostError('SHARED_TOOL_NOT_FOUND', sourceFile + '#tools.' + name);
        if (tools.includes(item.use))
          throw new HostError('DUPLICATE_TOOL_REFERENCE', sourceFile + '#tools.' + name);
        tools.push(item.use);
      } else {
        const instanceId = targetInstanceId(targetId, name);
        add(instanceId, item, sourceFile, 'tools.' + name, 'tools');
        tools.push(instanceId);
      }
    }
    targets[targetId] = {
      engine,
      tools,
      knowledge: (target.knowledge ?? []).map((entry) =>
        path.resolve(path.dirname(sourceFile), entry),
      ),
      ...(target.skills
        ? { skills: target.skills.map((entry) => path.resolve(path.dirname(sourceFile), entry)) }
        : {}),
    };
  }
  for (const [name, item] of Object.entries(config.channels)) {
    add(name, item, absolute, 'channels.' + name, 'channel');
    if (item.enabled === false) continue;
    for (const entry of item.routes ?? [{}])
      routes.push({ ...entry, channel: name, targets: entry.targets ?? Object.keys(targets) });
  }
  const composition: CompositionConfig = {
    version: 1,
    plugins,
    targets,
    routes,
    ...(config.runtime ? { runtime: config.runtime } : {}),
    ...(config.lifecycleTimeoutMs !== undefined
      ? { lifecycleTimeoutMs: config.lifecycleTimeoutMs }
      : {}),
  };
  return snapshot({ file: absolute, directory, composition });
}

export function validateReferences(
  config: CompositionConfig,
  manifests: ReadonlyMap<string, PluginManifest>,
): void {
  function capability(instanceId: string, expected: 'engine' | 'tools' | 'channel'): void {
    if (!manifests.get(instanceId)?.capabilities.includes(expected))
      throw new HostError('PLUGIN_REFERENCE_INVALID', instanceId);
  }
  for (const target of Object.values(config.targets)) {
    capability(target.engine, 'engine');
    for (const instanceId of target.tools) capability(instanceId, 'tools');
  }
  for (const route of config.routes) {
    capability(route.channel, 'channel');
    for (const targetId of route.targets) {
      if (!Object.hasOwn(config.targets, targetId))
        throw new HostError('TARGET_REFERENCE_INVALID', targetId);
    }
  }
}
