import { readFile, appendFile } from 'node:fs/promises';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
const [catalogFile, recordFile] = process.argv.slice(2);
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const server = new McpServer({ name: 'scripted-backend', version: '1.0.0' });
for (const tool of catalog)
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: fromJsonSchema(tool.inputSchema),
      annotations: tool.readOnly === null ? undefined : { readOnlyHint: tool.readOnly !== false },
    },
    async (args) => {
      await appendFile(
        recordFile,
        JSON.stringify({
          name: tool.name,
          arguments: args,
          inheritedUnexpectedEnv: Boolean(process.env.INCIDENT_TEST_B_SECRET),
        }) + '\n',
      );
      if (args.delayMs) await new Promise((resolve) => setTimeout(resolve, args.delayMs));
      return {
        isError:
          typeof args.query === 'string' && /authentication_failure|rate_limit/.test(args.query),
        content: [
          {
            type: 'text',
            text: JSON.stringify({ name: tool.name, arguments: args, resourceId: 'A_ONLY' }),
          },
        ],
      };
    },
  );
process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
