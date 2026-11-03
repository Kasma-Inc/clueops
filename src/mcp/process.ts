import { Client } from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  DEFAULT_INHERITED_ENV_VARS,
} from '@modelcontextprotocol/client/stdio';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compileContract, jsonValue, validators } from '../plugin-api/index.js';
import type {
  JsonObject,
  JsonSchema,
  JsonValue,
  ToolBindingContext,
  ToolDefinition,
  ToolProvider,
  ToolQueryResult,
} from '../plugin-api/index.js';
import { HostError } from '../core/errors.js';
import { fingerprint } from '../core/identity.js';
import { withDeadline } from '../core/lifecycle.js';

export interface McpCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
export interface McpPolicy {
  /** Omit to relay the backend catalog, including its actual side-effect annotations. */
  readonly allowedTools?: readonly string[];
  readonly startupTimeoutMs: number;
  readonly queryTimeoutMs: number;
  readonly maxResultBytes: number;
  readonly failureRemoteStatus?: 'unknown';
  isError?(name: string, input: JsonObject, content: unknown): boolean;
  truncated?(name: string, input: JsonObject, content: JsonValue): boolean;
  schema?(name: string, schema: JsonSchema): JsonSchema;
  command(context: ToolBindingContext, directory: string): Promise<McpCommand>;
  prepare(name: string, input: JsonObject): JsonObject;
  resources(name: string, input: JsonObject, content: JsonValue): readonly JsonObject[];
  sanitize(value: unknown): JsonValue;
}

export function mcpProvider(policy: McpPolicy): ToolProvider {
  const baseline = new Map<string, string>();
  let catalogHash: string | undefined;
  return {
    // MCP schemas are discovered under the per-turn connection, before the engine sees tools.
    definitions: [],
    async bind(context) {
      const directory = await mkdtemp(path.join(tmpdir(), 'incident-mcp-'));
      let client: Client | undefined;
      let transport: StdioClientTransport | undefined;
      let closed = false;
      let closing: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closing) return closing;
        closed = true;
        const pid = transport?.pid;
        closing = (async () => {
          try {
            if (client) await withDeadline(client.close(), 6000);
            if (pid) {
              // Never signal a captured PID after SDK close: it could already have been reused.
              const end = Date.now() + 1000;
              while (Date.now() < end) {
                try {
                  process.kill(pid, 0);
                } catch {
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              throw new HostError('BACKEND_TERMINATION_UNKNOWN');
            }
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        })();
        return closing;
      };
      try {
        context.signal.throwIfAborted();
        const command = await policy.command(context, directory);
        transport = new StdioClientTransport({
          command: command.command,
          args: [...command.args],
          cwd: directory,
          env: {
            ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((name) => [name, ''])),
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            ...command.env,
            HOME: directory,
            TMPDIR: directory,
          },
          stderr: 'pipe',
          maxBufferSize: Math.max(1048576, policy.maxResultBytes * 2),
        });
        // Drain, but never forward raw backend diagnostics into agent context or service logs.
        transport.stderr?.on('data', () => {});
        client = new Client(
          { name: 'clueops', version: '0.1.0' },
          { capabilities: {}, versionNegotiation: { mode: 'legacy' }, listMaxPages: 8 },
        );
        const startup = AbortSignal.any([
          context.signal,
          AbortSignal.timeout(policy.startupTimeoutMs),
        ]);
        await client.connect(transport, { signal: startup, timeout: policy.startupTimeoutMs });
        const listed = await client.listTools(undefined, {
          signal: startup,
          timeout: policy.startupTimeoutMs,
          maxTotalTimeout: policy.startupTimeoutMs,
          cacheMode: 'refresh',
        });
        const definitions: ToolDefinition[] = [];
        if (policy.allowedTools === undefined) {
          const hash = fingerprint(
            listed.tools
              .map((tool) => ({
                name: tool.name,
                schema: tool.inputSchema,
                readOnly: tool.annotations?.readOnlyHint === true,
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
          if (catalogHash !== undefined && catalogHash !== hash)
            throw new HostError('TOOL_CATALOG_CHANGED');
          catalogHash = hash;
        }
        for (const name of policy.allowedTools ?? listed.tools.map((tool) => tool.name)) {
          const matches = listed.tools.filter((tool) => tool.name === name);
          if (matches.length !== 1) throw new HostError('TOOL_CATALOG_INVALID');
          const tool = matches[0]!;
          const rawSchema = jsonValue(tool.inputSchema) as JsonObject;
          const hash = fingerprint(rawSchema);
          if (baseline.has(name) && baseline.get(name) !== hash)
            throw new HostError('TOOL_CATALOG_CHANGED');
          baseline.set(name, hash);
          const definition = validators.toolDefinition.parse({
            name,
            description: tool.description || name,
            readOnly:
              policy.allowedTools === undefined ? tool.annotations?.readOnlyHint === true : true,
            inputSchema: policy.schema?.(name, rawSchema) ?? rawSchema,
          });
          definitions.push(definition);
        }
        let parsers;
        try {
          parsers = new Map(
            definitions.map((definition) => [
              definition.name,
              compileContract<JsonObject>(definition.inputSchema, 'tool arguments'),
            ]),
          );
        } catch {
          throw new HostError('TOOL_CATALOG_INVALID');
        }
        const connected = client;
        return {
          status: 'ready',
          definitions: Object.freeze(definitions),
          binding: {
            close,
            async call(name, input, signal): Promise<ToolQueryResult> {
              const failure = (code: string): ToolQueryResult => ({
                status: 'error',
                content: null,
                resources: [],
                truncated: false,
                failure: {
                  code,
                  message: code,
                  ...(code === 'QUERY_TIMEOUT' || code === 'QUERY_CANCELLED'
                    ? { remoteStatus: 'unknown' as const }
                    : {}),
                },
              });
              if (closed) return failure('BINDING_CLOSED');
              const parser = parsers.get(name);
              if (!parser) return failure('TOOL_NOT_ALLOWED');
              let arguments_: JsonObject;
              try {
                arguments_ = parser.parse(input);
                arguments_ = policy.prepare(name, arguments_);
                parser.parse(arguments_);
              } catch {
                return failure('QUERY_OUT_OF_SCOPE');
              }
              const timeout = AbortSignal.timeout(policy.queryTimeoutMs);
              const combined = AbortSignal.any([signal, context.signal, timeout]);
              try {
                const result = await connected.callTool(
                  { name, arguments: arguments_ },
                  {
                    signal: combined,
                    timeout: policy.queryTimeoutMs,
                    maxTotalTimeout: policy.queryTimeoutMs,
                    resetTimeoutOnProgress: false,
                  },
                );
                if (closed || signal.aborted || context.signal.aborted)
                  return failure('QUERY_CANCELLED');
                const rawContent = result.structuredContent ?? result.content;
                // Interpret trusted backend protocol before redacting arbitrary business text.
                const isError =
                  result.isError || policy.isError?.(name, arguments_, rawContent) === true;
                const content = policy.sanitize(rawContent);
                const serialized = JSON.stringify(content);
                const tooLarge = Buffer.byteLength(serialized) > policy.maxResultBytes;
                return {
                  status: isError ? 'error' : 'ok',
                  content: tooLarge ? '结果超过字节上限，请缩小查询范围。' : content,
                  resources: policy.resources(name, arguments_, content),
                  truncated: tooLarge || policy.truncated?.(name, arguments_, content) === true,
                  ...(isError
                    ? {
                        failure: {
                          code: 'UPSTREAM_TOOL_FAILED',
                          message: '数据源查询失败，详见脱敏证据。',
                          ...(policy.failureRemoteStatus
                            ? { remoteStatus: policy.failureRemoteStatus }
                            : {}),
                        },
                      }
                    : {}),
                };
              } catch {
                return failure(
                  signal.aborted || context.signal.aborted
                    ? 'QUERY_CANCELLED'
                    : timeout.aborted
                      ? 'QUERY_TIMEOUT'
                      : 'MCP_QUERY_FAILED',
                );
              }
            },
          },
        };
      } catch (error) {
        await close().catch(() => {});
        if (error instanceof HostError && error.code.startsWith('TOOL_CATALOG')) throw error;
        return {
          status: 'unavailable',
          failure: { code: 'MCP_UNAVAILABLE', message: '该数据源后端启动或认证失败。' },
        };
      }
    },
  };
}
