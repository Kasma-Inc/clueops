import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import {
  toNodeHandler,
  localhostHostValidation,
  localhostOriginValidation,
} from '@modelcontextprotocol/node';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { BoundDiagnosticTool, JsonObject } from '../plugin-api/index.js';

export async function openToolBridge(tools: readonly BoundDiagnosticTool[], parent: AbortSignal) {
  const token = randomBytes(32).toString('base64url');
  const route = '/mcp/' + randomBytes(16).toString('hex');
  const abort = new AbortController();
  const signal = AbortSignal.any([parent, abort.signal]);
  const limit = 1024 * 1024;
  const allowed = new Set([
    'initialize',
    'tools/list',
    'tools/call',
    'ping',
    'notifications/initialized',
    'notifications/cancelled',
  ]);
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'investigation-tools', version: '0.1.0' });
      for (const tool of tools) {
        const schema =
          typeof tool.definition.inputSchema === 'boolean'
            ? tool.definition.inputSchema
              ? {}
              : { not: {} }
            : tool.definition.inputSchema;
        server.registerTool(
          tool.definition.name,
          {
            description: tool.definition.description,
            inputSchema: fromJsonSchema<JsonObject>(schema),
            annotations: { readOnlyHint: tool.definition.readOnly },
          },
          async (args, context) => {
            signal.throwIfAborted();
            const evidence = await tool.call(
              args,
              AbortSignal.any([signal, context.mcpReq.signal]),
            );
            return {
              content: [{ type: 'text', text: JSON.stringify(evidence) }],
              isError: evidence.status !== 'ok',
            };
          },
        );
      }
      return server;
    },
    { legacy: 'stateless', maxRequestBodySize: limit },
  );
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: limit });
  const host = localhostHostValidation();
  const origin = localhostOriginValidation();
  const http = createServer(async (request, response) => {
    try {
      if (signal.aborted || request.url !== route) {
        response.writeHead(404).end();
        return;
      }
      const value = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + token);
      if (value.length !== expected.length || !timingSafeEqual(value, expected)) {
        response.writeHead(401).end();
        return;
      }
      if (!host(request, response) || !origin(request, response)) return;
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > limit) {
          response.writeHead(413).end();
          return;
        }
        parts.push(Buffer.from(chunk));
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !('method' in parsed) ||
        typeof parsed.method !== 'string' ||
        !allowed.has(parsed.method)
      ) {
        response.writeHead(403).end();
        return;
      }
      await nodeHandler(Object.assign(request, { method: 'POST', url: route }), response, parsed);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  http.requestTimeout = 10000;
  http.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('MCP_LISTEN_FAILED');
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}${route}`,
    token,
    close(): Promise<void> {
      if (closing) return closing;
      abort.abort();
      http.closeAllConnections();
      closing = (async () => {
        await handler.close();
        await new Promise<void>((resolve) => http.close(() => resolve()));
      })();
      return closing;
    },
  };
}
