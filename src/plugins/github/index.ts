import { definePlugin } from '../../plugin-api/index.js';
import type { JsonValue } from '../../plugin-api/index.js';
import { mcpProvider } from '../../mcp/process.js';
import {
  backend,
  backendSchema,
  credential,
  credentialSchema,
  object,
  privateRedactor,
  packagedPath,
  text,
} from '../shared.js';

interface Config {
  backend?: { command: string; args?: string[] };
  token?: string;
  tokenFile?: string;
  maxResultBytes?: number;
}
// This upstream annotation is not a JSON Schema keyword understood by Ajv.
function schemaAnnotations(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(schemaAnnotations);
  if (object(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'x-mcp-header')
        .map(([key, item]) => [key, schemaAnnotations(item)]),
    );
  return value;
}
export default definePlugin<Config>({
  manifest: {
    id: 'github-mcp',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['tools'],
    configSchema: credentialSchema(
      {
        backend: backendSchema,
        tokenFile: text,
        token: text,
        maxResultBytes: { type: 'integer', minimum: 1024, maximum: 1048576 },
      },
      [],
      'token',
      'tokenFile',
    ),
  },
  async create(config, context) {
    const executable = await backend(config.backend, context, {
      command: packagedPath('.clueops/bin/github-mcp-server'),
    });
    const token = await credential(config.token, config.tokenFile, context);
    const redactor = privateRedactor([token], context);
    return {
      scope: { repositoryAccess: 'token' },
      tools: mcpProvider({
        startupTimeoutMs: 15000,
        queryTimeoutMs: 20000,
        maxResultBytes: config.maxResultBytes ?? 131072,
        async command() {
          return {
            command: executable.command,
            args: [...(executable.args ?? []), 'stdio', '--read-only'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
          };
        },
        schema(_name, schema) {
          return schemaAnnotations(schema) as typeof schema;
        },
        prepare(_name, input) {
          return input;
        },
        resources(name, input) {
          return [
            {
              tool: name,
              repositoryAccess: 'token',
              owner: input.owner ?? null,
              repo: input.repo ?? null,
              path: input.path ?? null,
              requestedRef: input.sha ?? input.ref ?? input.tag ?? null,
            },
          ];
        },
        sanitize: (value) => redactor.value(value),
      }),
      async dispose() {},
    };
  },
});
