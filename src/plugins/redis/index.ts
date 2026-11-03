import { access } from 'node:fs/promises';
import { definePlugin, jsonValue, objectSchema } from '../../plugin-api/index.js';
import type { JsonValue } from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';
import { mcpProvider } from '../../mcp/process.js';
import {
  backend,
  backendSchema,
  bounded,
  credential,
  object,
  packagedPath,
  privateRedactor,
  text,
} from '../shared.js';
import { validatePrivatePaths } from '../private-paths.js';

export const redisTools = [
  'info',
  'dbsize',
  'type',
  'scan_keys',
  'get',
  'hget',
  'hexists',
  'llen',
  'lrange',
  'zrange',
  'xrange',
] as const;

interface Config {
  backend?: { command: string; args?: string[] };
  host: string;
  port?: number;
  database?: number;
  username?: string;
  password?: string;
  passwordFile?: string;
  tls?: { caFile?: string; certFile?: string; keyFile?: string };
  queryTimeoutMs?: number;
  maxItems?: number;
  maxResultBytes?: number;
}

// FastMCP wraps scalar results in {result: ...}; older envelopes use text blocks.
function decode(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    if (
      value.length === 1 &&
      object(value[0]) &&
      value[0].type === 'text' &&
      typeof value[0].text === 'string'
    ) {
      const text = value[0].text;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return text;
      }
      return jsonValue(parsed);
    }
    return value;
  }
  return object(value) && Object.keys(value).length === 1 && 'result' in value
    ? value.result!
    : value;
}

// The pinned upstream returns some RedisError exceptions as ordinary strings.
// These reserved prefixes are conservatively treated as failures; identical stored
// string values are indistinguishable. Never infer success from a failed query.
const errors: Readonly<Record<string, string>> = {
  info: 'Error retrieving Redis info:',
  dbsize: 'Error getting database size:',
  scan_keys: 'Error scanning keys with pattern ',
  get: 'Error retrieving key ',
  hget: 'Error getting field ',
  hexists: 'Error checking existence of field ',
  llen: 'Error retrieving length of list ',
  lrange: 'Error retrieving values from list ',
  zrange: 'Error retrieving sorted set ',
  xrange: 'Error reading from stream ',
};

export default definePlugin<Config>({
  manifest: {
    id: 'redis-mcp',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['tools'],
    configSchema: objectSchema(
      {
        backend: backendSchema,
        host: { ...text, pattern: '^[A-Za-z0-9._:\\[\\]-]+$' },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        database: { type: 'integer', minimum: 0, maximum: 255 },
        username: text,
        password: text,
        passwordFile: text,
        tls: objectSchema({ caFile: text, certFile: text, keyFile: text }, []),
        queryTimeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
        maxItems: { type: 'integer', minimum: 1, maximum: 1000 },
        maxResultBytes: { type: 'integer', minimum: 1024, maximum: 1048576 },
      },
      ['host'],
    ),
  },
  async create(config, context) {
    if (Boolean(config.tls?.keyFile) !== Boolean(config.tls?.certFile))
      throw new HostError('REDIS_TLS_CLIENT_PAIR_REQUIRED');
    const password =
      config.password !== undefined || config.passwordFile !== undefined
        ? await credential(config.password, config.passwordFile, context, 'password')
        : undefined;
    const redactor = privateRedactor(password === undefined ? [] : [password], context);
    const tls = Object.fromEntries(
      await Promise.all(
        Object.entries(config.tls ?? {}).map(async ([key, file]) => {
          const resolved = context.resolvePath(file);
          await access(resolved);
          return [key, resolved];
        }),
      ),
    );
    await validatePrivatePaths([
      ...(config.passwordFile ? [context.resolvePath(config.passwordFile)] : []),
      ...(tls.keyFile ? [tls.keyFile] : []),
    ]);
    const executable = await backend(config.backend, context, {
      command: packagedPath('.clueops/redis-venv/bin/python3'),
      args: ['-I', '-m', 'src.main'],
    });
    const timeout = config.queryTimeoutMs ?? 10000;
    const maximum = config.maxItems ?? 100;
    const scope = {
      host: config.host,
      port: config.port ?? 6379,
      database: config.database ?? 0,
      username: config.username ?? 'default',
      tls: config.tls !== undefined,
      certificates: tls,
      queryTimeoutMs: timeout,
      maxItems: maximum,
      maxResultBytes: config.maxResultBytes ?? 131072,
    };
    return {
      scope,
      tools: mcpProvider({
        allowedTools: redisTools,
        startupTimeoutMs: 15000,
        queryTimeoutMs: timeout,
        maxResultBytes: scope.maxResultBytes,
        failureRemoteStatus: 'unknown',
        schema(_name, schema) {
          if (!object(schema.properties)) return schema;
          const properties = { ...schema.properties };
          for (const key of ['count', 'start', 'stop', 'end', 'cursor']) {
            if (!object(properties[key])) continue;
            properties[key] = {
              ...properties[key],
              minimum: key === 'count' ? 1 : 0,
              ...(key === 'count' ? { maximum, default: maximum } : {}),
              ...(key === 'cursor' ? { maximum: Number.MAX_SAFE_INTEGER } : {}),
            };
          }
          return {
            ...schema,
            properties,
            additionalProperties: false,
            description: `只读查询；range最多${maximum}项，SCAN使用返回游标逐页继续，不提供scan_all_keys。`,
          };
        },
        async command() {
          return {
            command: executable.command,
            args: executable.args ?? [],
            env: {
              PYTHON_DOTENV_DISABLED: '1',
              MCP_REDIS_LOG_LEVEL: 'ERROR',
              REDIS_HOST: scope.host,
              REDIS_PORT: String(scope.port),
              REDIS_DB: String(scope.database),
              ...(config.username ? { REDIS_USERNAME: config.username } : {}),
              REDIS_PWD: password ?? '',
              REDIS_SSL: scope.tls ? 'true' : 'false',
              REDIS_SSL_CERT_REQS: 'required',
              REDIS_CLUSTER_MODE: 'false',
              ...(tls.caFile ? { REDIS_SSL_CA_CERTS: tls.caFile } : {}),
              ...(tls.certFile
                ? { REDIS_SSL_CERTFILE: tls.certFile, REDIS_SSL_KEYFILE: tls.keyFile! }
                : {}),
            },
          };
        },
        prepare(name, input) {
          if (name === 'scan_keys') {
            return { ...input, count: bounded(input.count, maximum, maximum) };
          }
          if (name === 'xrange') return { ...input, count: bounded(input.count, maximum, maximum) };
          if (name === 'lrange' || name === 'zrange') {
            const start = input.start;
            const end = input[name === 'lrange' ? 'stop' : 'end'];
            if (
              typeof start !== 'number' ||
              typeof end !== 'number' ||
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start < 0 ||
              end < start ||
              end - start + 1 > maximum
            )
              throw new HostError('REDIS_RANGE_INVALID');
          }
          return input;
        },
        resources(name, input) {
          return [
            {
              host: scope.host,
              port: scope.port,
              database: scope.database,
              ...(input.key !== undefined || input.name !== undefined
                ? { key: input.name ?? input.key! }
                : {}),
              ...(name === 'scan_keys'
                ? { pattern: input.pattern ?? '*', cursor: input.cursor ?? 0 }
                : {}),
            },
          ];
        },
        sanitize: (value) => redactor.value(decode(value)),
        isError(name, _input, rawContent) {
          const content = decode(rawContent);
          return (
            (name === 'type' && object(content) && typeof content.error === 'string') ||
            (typeof content === 'string' &&
              Boolean(errors[name]) &&
              content.startsWith(errors[name]!))
          );
        },
        truncated(name, _input, content) {
          return (
            ['lrange', 'zrange', 'xrange'].includes(name) ||
            (name === 'scan_keys' &&
              object(content) &&
              (content.scan_complete === false ||
                (content.cursor !== undefined && String(content.cursor) !== '0')))
          );
        },
      }),
      async dispose() {},
    };
  },
});
