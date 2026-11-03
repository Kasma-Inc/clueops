import { appendFile } from 'node:fs/promises';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
const record = process.argv[2];
const server = new McpServer({ name: 'synthetic-redis', version: '0.5.1' });
const string = { type: 'string' };
const integer = { type: 'integer' };
const schemas = {
  info: [{ section: string }, []],
  dbsize: [{}, []],
  type: [{ key: string }, ['key']],
  scan_keys: [{ pattern: string, cursor: integer, count: integer }, []],
  get: [{ key: string }, ['key']],
  hget: [{ name: string, key: string }, ['name', 'key']],
  hexists: [{ name: string, key: string }, ['name', 'key']],
  llen: [{ name: string }, ['name']],
  lrange: [{ name: string, start: integer, stop: integer }, ['name', 'start', 'stop']],
  zrange: [
    { key: string, start: integer, end: integer, with_scores: { type: 'boolean' } },
    ['key', 'start', 'end'],
  ],
  xrange: [{ key: string, count: integer }, ['key']],
  delete: [{ key: string }, ['key']],
};
await appendFile(
  record,
  JSON.stringify({
    startup: true,
    cwd: process.cwd(),
    env: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      db: process.env.REDIS_DB,
      user: process.env.REDIS_USERNAME,
      ssl: process.env.REDIS_SSL,
      certReqs: process.env.REDIS_SSL_CERT_REQS,
      caFile: process.env.REDIS_SSL_CA_CERTS,
      noDotenv: process.env.PYTHON_DOTENV_DISABLED,
      passwordMatches: process.env.REDIS_PWD === ' synthetic password ',
      unexpectedEnv: process.env.INCIDENT_REDIS_B_SECRET !== undefined,
    },
  }) + '\n',
);
for (const [name, [properties, required]] of Object.entries(schemas)) {
  server.registerTool(
    name,
    { inputSchema: fromJsonSchema({ type: 'object', properties, required }) },
    async (input) => {
      await appendFile(record, JSON.stringify({ name, input }) + '\n');
      if (input.key === 'delay') await new Promise((r) => setTimeout(r, 5000));
      let result =
        name === 'scan_keys'
          ? {
              cursor: input.pattern === 'complete' ? 0 : 22,
              keys: [],
              scan_complete: input.pattern === 'complete',
            }
          : name === 'type'
            ? { key: input.key, type: 'string', ttl: 42 }
            : name === 'dbsize'
              ? 12
              : process.env.REDIS_HOST;
      if (input.key === 'auth')
        result = 'Error retrieving key auth: invalid username-password pair';
      if (input.key === 'type-error') result = { error: 'NOPERM' };
      if (input.key === 'business-error') result = 'Business Error happened';
      if (input.key === 'business-json') result = { error: 'ordinary business data' };
      if (input.key === 'secret') result = process.env.REDIS_PWD;
      if (input.key === 'large') result = 'x'.repeat(4000);
      return {
        content: [
          { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
        ],
        structuredContent: { result },
      };
    },
  );
}
process.stdin.on('end', () => process.exit(0));
await server.connect(new StdioServerTransport());
