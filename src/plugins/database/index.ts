import { definePlugin, objectSchema } from '../../plugin-api/index.js';
import type { JsonObject, JsonValue } from '../../plugin-api/index.js';
import { mcpProvider } from '../../mcp/process.js';
import { HostError } from '../../core/errors.js';
import {
  backend,
  backendSchema,
  bounded,
  credential,
  object,
  positive,
  privateRedactor,
  packagedPath,
  text,
  writeToml,
} from '../shared.js';

function decodeEnvelope(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeEnvelope);
  if (object(value) && value.type === 'text' && typeof value.text === 'string') {
    try {
      return JSON.parse(value.text) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}
function rowTruncated(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(rowTruncated);
  if (!object(value) || !object(value.data)) return false;
  return (
    value.data.truncated === true ||
    (Array.isArray(value.data.statements) &&
      value.data.statements.some((statement) => object(statement) && statement.truncated === true))
  );
}

interface Config {
  backend?: { command: string; args?: string[] };
  resourceId?: string;
  source: {
    type: 'postgres' | 'mysql' | 'sqlite' | 'sqlserver';
    host?: string;
    port?: number;
    database: string;
    user?: string;
    passwordFile?: string;
    password?: string;
    sslmode?: string;
    sslrootcert?: string;
    sslcert?: string;
    sslkey?: string;
  };
  queryTimeoutMs?: number;
  maxRows?: number;
  maxResultBytes?: number;
  poolMaxConnections?: number;
}
export default definePlugin<Config>({
  manifest: {
    id: 'dbhub',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['tools'],
    configSchema: objectSchema(
      {
        backend: backendSchema,
        resourceId: text,
        source: objectSchema(
          {
            type: { enum: ['postgres', 'mysql', 'sqlite', 'sqlserver'] },
            host: text,
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            database: text,
            user: text,
            passwordFile: text,
            password: text,
            sslmode: { enum: ['disable', 'require', 'verify-ca', 'verify-full'] },
            sslrootcert: text,
            sslcert: text,
            sslkey: text,
          },
          ['type', 'database'],
        ),
        queryTimeoutMs: positive,
        maxRows: positive,
        maxResultBytes: positive,
        poolMaxConnections: { type: 'integer', minimum: 1, maximum: 10 },
      },
      ['source'],
    ),
  },
  async create(config, context) {
    if (
      config.source.type !== 'sqlite' &&
      (!config.source.host ||
        !config.source.user ||
        (!config.source.passwordFile && config.source.password === undefined))
    )
      throw new HostError('DATABASE_SOURCE_CONFIG_INVALID');
    if (config.source.host && !/^[A-Za-z0-9._:\[\]-]+$/.test(config.source.host))
      throw new HostError('DATABASE_HOST_INVALID');
    if (config.source.type !== 'postgres' && config.poolMaxConnections !== undefined)
      throw new HostError('POOL_LIMIT_REQUIRES_POSTGRES');
    if (
      config.source.type === 'sqlite' &&
      Object.keys(config.source).some((key) => !['type', 'database'].includes(key))
    )
      throw new HostError('SQLITE_SOURCE_CONFIG_INVALID');
    const executable = await backend(config.backend, context, {
      command: process.execPath,
      args: [packagedPath('tools/dbhub/node_modules/@bytebase/dbhub/dist/index.js')],
    });
    const password =
      config.source.type === 'sqlite'
        ? undefined
        : await credential(config.source.password, config.source.passwordFile, context, 'password');
    const redactor = privateRedactor(password ? [password] : [], context);
    const timeout = config.queryTimeoutMs ?? 10000;
    const source = {
      ...config.source,
      ...(password ? { password } : {}),
      lazy: true,
      connection_timeout: 5,
      query_timeout: Math.max(1, Math.floor(timeout / 1000)),
      ...(config.source.type === 'postgres'
        ? { pool_max_connections: config.poolMaxConnections ?? 2 }
        : {}),
    };
    delete source.passwordFile;
    for (const key of ['sslrootcert', 'sslcert', 'sslkey'] as const)
      if (source[key]) source[key] = context.resolvePath(source[key]);
    if (source.type === 'sqlite') source.database = context.resolvePath(source.database);
    const policy = {
      resourceId: config.resourceId ?? context.instanceId,
      type: source.type,
      database: source.database,
      host: source.host ?? '',
      port: source.port ?? 0,
      user: source.user ?? '',
      sslmode: source.sslmode ?? 'backend-default',
      queryTimeoutMs: timeout,
      maxRows: config.maxRows ?? 200,
      poolMaxConnections: source.pool_max_connections ?? 'connector-default',
    };
    return {
      scope: policy,
      tools: mcpProvider({
        allowedTools: ['execute_sql', 'search_objects'],
        startupTimeoutMs: 10000,
        queryTimeoutMs: timeout + 6000,
        maxResultBytes: config.maxResultBytes ?? 131072,
        failureRemoteStatus: 'unknown',
        schema(_name, schema) {
          return object(schema) ? { ...schema, additionalProperties: false } : schema;
        },
        async command(_binding, directory) {
          const file = await writeToml(directory, {
            sources: [{ ...source, id: 'database' }],
            tools: [
              { name: 'execute_sql', source: 'database', readonly: true, max_rows: policy.maxRows },
              { name: 'search_objects', source: 'database' },
            ],
          });
          return {
            command: executable.command,
            args: [...(executable.args ?? []), '--transport', 'stdio', '--config', file],
          };
        },
        prepare(name, input) {
          return name === 'search_objects'
            ? { ...input, limit: bounded(input.limit, 100, Math.min(policy.maxRows, 1000)) }
            : input;
        },
        resources() {
          return [
            {
              resourceId: policy.resourceId,
              database: source.database,
              engine: source.type,
              timeRange: 'unknown',
            } satisfies JsonObject,
          ];
        },
        sanitize(value) {
          return redactor.value(decodeEnvelope(value));
        },
        truncated(_name, _input, content) {
          return rowTruncated(content);
        },
      }),
      async dispose() {},
    };
  },
});
