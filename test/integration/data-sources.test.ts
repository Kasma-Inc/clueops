import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';
import kubernetes from '../../src/plugins/kubernetes/index.js';
import database from '../../src/plugins/database/index.js';
import type { PluginContext, ToolBinding } from '../../src/plugin-api/index.js';
const exec = promisify(execFile);
async function directory(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'incident-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const context = (root: string): PluginContext => ({
  instanceId: 'source',
  configFile: path.join(root, 'plugin.yaml'),
  resolvePath: (value) => path.resolve(root, value),
});
const bindingContext = () => ({
  investigationId: 'incident',
  turnId: 'turn',
  targetId: 'a',
  scopeRevision: 'a'.repeat(64),
  signal: AbortSignal.timeout(45000),
});
const call = (
  binding: ToolBinding,
  name: string,
  args: Record<string, string | number | boolean> = {},
) => binding.call(name, args, AbortSignal.timeout(10000));

test(
  'real Kubernetes MCP relays target A across namespaces and preserves API RBAC failures',
  { timeout: 60000 },
  async (t) => {
    const root = await directory(t);
    const seen: string[] = [];
    let bRequests = 0;
    const api = createServer((req, res) => {
      seen.push(req.url!);
      res.setHeader('content-type', 'application/json');
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname.endsWith('/selfsubjectaccessreviews')) {
        // client-go may send protobuf; the actual resource endpoints below
        // enforce the synthetic RBAC denial, independently of this preflight.
        req.resume();
        res.end(
          JSON.stringify({
            apiVersion: 'authorization.k8s.io/v1',
            kind: 'SelfSubjectAccessReview',
            status: { allowed: true },
          }),
        );
        return;
      }
      if (
        req.method !== 'GET' ||
        url.pathname.includes('/secrets/') ||
        url.pathname.endsWith('/nodes')
      ) {
        res.writeHead(403).end(
          JSON.stringify({
            kind: 'Status',
            apiVersion: 'v1',
            status: 'Failure',
            reason: 'Forbidden',
            message: 'SYNTHETIC_RBAC_DENIED',
            code: 403,
          }),
        );
        return;
      }
      if (url.pathname === '/api/v1/namespaces') {
        res.end(
          JSON.stringify({
            apiVersion: 'v1',
            kind: 'NamespaceList',
            metadata: {},
            items: [{ metadata: { name: 'team-a' } }, { metadata: { name: 'team-b' } }],
          }),
        );
        return;
      }
      if (url.pathname === '/version') {
        res.end(JSON.stringify({ major: '1', minor: '33', gitVersion: 'v1.33.0' }));
        return;
      }
      if (url.pathname.endsWith('/log')) {
        res.setHeader('content-type', 'text/plain');
        res.end('ERROR database password=SYNTHETIC_K8S_TOKEN timeout\n');
        return;
      }
      if (url.pathname.endsWith('/pods/web')) {
        res.end(
          JSON.stringify({
            apiVersion: 'v1',
            kind: 'Pod',
            metadata: {
              name: 'web',
              namespace: 'team-a',
              annotations: { arbitrary: 'SYNTHETIC_K8S_TOKEN' },
            },
            spec: {
              containers: [
                { name: 'web', env: [{ name: 'DATABASE_URL', value: 'PRIVATE_EMBEDDED_VALUE' }] },
              ],
            },
            status: { phase: 'Running' },
          }),
        );
        return;
      }
      if (url.pathname.endsWith('/pods')) {
        res.end(
          JSON.stringify({
            apiVersion: 'v1',
            kind: 'PodList',
            metadata: { continue: 'SYNTHETIC_NEXT_PAGE', remainingItemCount: 400 },
            items: [
              {
                metadata: { name: 'web', namespace: 'team-a' },
                spec: { containers: [{ name: 'web' }, { name: 'sidecar' }] },
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/api') {
        res.end(JSON.stringify({ kind: 'APIVersions', versions: ['v1'] }));
        return;
      }
      if (url.pathname === '/apis') {
        res.end(
          JSON.stringify({
            kind: 'APIGroupList',
            groups: [
              {
                name: 'authorization.k8s.io',
                versions: [{ groupVersion: 'authorization.k8s.io/v1', version: 'v1' }],
                preferredVersion: { groupVersion: 'authorization.k8s.io/v1', version: 'v1' },
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/apis/authorization.k8s.io/v1') {
        res.end(
          JSON.stringify({
            kind: 'APIResourceList',
            groupVersion: 'authorization.k8s.io/v1',
            resources: [
              {
                name: 'selfsubjectaccessreviews',
                kind: 'SelfSubjectAccessReview',
                namespaced: false,
                verbs: ['create'],
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === '/api/v1') {
        res.end(
          JSON.stringify({
            kind: 'APIResourceList',
            groupVersion: 'v1',
            resources: [
              { name: 'pods', kind: 'Pod', namespaced: true, verbs: ['get', 'list'] },
              { name: 'events', kind: 'Event', namespaced: true, verbs: ['get', 'list'] },
              { name: 'nodes', kind: 'Node', namespaced: false, verbs: ['get', 'list'] },
              { name: 'namespaces', kind: 'Namespace', namespaced: false, verbs: ['get', 'list'] },
              { name: 'secrets', kind: 'Secret', namespaced: true, verbs: ['get', 'list'] },
            ],
          }),
        );
        return;
      }
      if (url.pathname.endsWith('/events')) {
        res.end(JSON.stringify({ apiVersion: 'v1', kind: 'EventList', items: [], metadata: {} }));
        return;
      }
      res
        .writeHead(404)
        .end(
          JSON.stringify({ kind: 'Status', status: 'Failure', message: 'not found', code: 404 }),
        );
    });
    const other = createServer((_req, res) => {
      bRequests++;
      res.end('{}');
    });
    for (const server of [api, other]) {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      t.after(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
    }
    const address = (server: typeof api) =>
      `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await writeFile(
      path.join(root, 'kubeconfig'),
      stringify({
        apiVersion: 'v1',
        kind: 'Config',
        'current-context': 'b',
        contexts: [
          { name: 'a', context: { cluster: 'a', user: 'a', namespace: 'team-a' } },
          { name: 'b', context: { cluster: 'b', user: 'b' } },
        ],
        clusters: [
          { name: 'a', cluster: { server: address(api) } },
          { name: 'b', cluster: { server: address(other) } },
        ],
        users: [
          { name: 'a', user: { token: 'SYNTHETIC_K8S_TOKEN' } },
          { name: 'b', user: { token: 'B_SECRET' } },
        ],
      }),
    );
    const plugin = await kubernetes.create(
      {
        resourceId: 'cluster-a',
        kubeconfig: './kubeconfig',
        context: 'a',
      },
      context(root),
    );
    const result = await plugin.tools!.bind(bindingContext());
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    const binding = result.binding;
    t.after(() => binding.close());
    assert.equal(result.definitions!.find((d) => d.name === 'pods_exec')!.readOnly, false);
    assert.equal(result.definitions!.find((d) => d.name === 'pods_get')!.readOnly, true);
    assert.ok(!result.definitions!.some((d) => d.name.startsWith('configuration_')));
    const namespaceList = await call(binding, 'namespaces_list', {});
    assert.equal(namespaceList.status, 'ok');
    assert.equal(namespaceList.resources[0]!.tool, 'namespaces_list');
    assert.equal(
      namespaceList.resources[0]!.kind,
      null,
      'unknown resource types must not be mislabeled Pod',
    );
    assert.equal((await call(binding, 'pods_list', {})).status, 'ok');
    assert.equal(
      (await call(binding, 'pods_get', { name: 'web', namespace: 'team-b' })).status,
      'ok',
    );
    assert.equal(
      (await call(binding, 'resources_list', { apiVersion: 'v1', kind: 'Pod' })).status,
      'ok',
    );
    const listed = await call(binding, 'pods_list_in_namespace', { namespace: 'team-a' });
    assert.equal(listed.status, 'ok');
    assert.equal(listed.truncated, true, 'a continuation token means this is only one list page');
    const pod = await call(binding, 'pods_get', { name: 'web' });
    assert.equal(pod.status, 'ok');
    assert.ok(!JSON.stringify(pod).includes('PRIVATE_EMBEDDED_VALUE'));
    const log = await call(binding, 'pods_log', {
      name: 'web',
      container: 'sidecar',
      previous: true,
      tail: 5,
    });
    assert.equal(log.status, 'ok');
    assert.equal(log.truncated, true);
    assert.ok(!JSON.stringify(log).includes('SYNTHETIC_K8S_TOKEN'));
    assert.equal((await call(binding, 'events_list', {})).status, 'ok');
    assert.ok(
      seen.some(
        (url) =>
          url.includes('/team-a/pods/web/log') &&
          url.includes('previous=true') &&
          url.includes('container=sidecar') &&
          url.includes('tailLines=5'),
      ),
    );
    assert.ok(
      seen.some((url) => url.startsWith('/api/v1/pods')),
      JSON.stringify(seen),
    );
    assert.ok(seen.some((url) => url.includes('/namespaces/team-b/pods/web')));
    assert.ok(seen.some((url) => url.startsWith('/api/v1/events')));
    const before = seen.length;
    for (const [name, args] of [
      ['resources_get', { name: 'secret', namespace: 'team-a', apiVersion: 'v1', kind: 'Secret' }],
      ['resources_list', { apiVersion: 'v1', kind: 'Node' }],
      ['pods_delete', { name: 'web', namespace: 'team-a' }],
      ['configuration_view', {}],
      ['pods_get', { name: 'web', context: 'b' }],
    ] as const)
      assert.equal((await call(binding, name, args)).status, 'error');
    assert.ok(
      seen.length > before,
      'RBAC failures must come from the API rather than a host access list',
    );
    assert.ok(seen.some((url) => url.includes('/secrets/secret')));
    assert.ok(seen.some((url) => url.startsWith('/api/v1/nodes')));
    assert.equal(bRequests, 0);
  },
);

test(
  'real DBHub + PostgreSQL enforce scope, reader permissions, row/byte/time limits and runtime evidence',
  { timeout: 90000 },
  async (t) => {
    let stop: (() => Promise<void>) | undefined;
    t.after(async () => {
      await stop?.();
    });
    const root = await directory(t);
    const data = path.join(root, 'pg');
    const socket = path.join(root, 'socket');
    await mkdir(socket);
    const pg = (name: string) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name);
    let port = 20000 + Math.floor(Math.random() * 20000);
    if (process.env.PG_TEST_IMAGE) {
      const name = 'incident-pg-test-' + randomUUID();
      await exec('docker', [
        'run',
        '--rm',
        '-d',
        '--name',
        name,
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
        '--env',
        'POSTGRES_USER=postgres',
        '--env',
        'POSTGRES_DB=postgres',
        '--env',
        'POSTGRES_PASSWORD=synthetic',
        '--env',
        'PGDATA=/var/lib/postgresql/incident-test',
        '--tmpfs',
        '/var/lib/postgresql',
        '--publish',
        '127.0.0.1::5432',
        '--entrypoint',
        'docker-entrypoint.sh',
        process.env.PG_TEST_IMAGE,
        'postgres',
        '-c',
        'max_connections=30',
      ]);
      stop = async () => {
        await exec('docker', ['rm', '-f', name]);
      };
      port = Number(
        (await exec('docker', ['port', name, '5432/tcp'])).stdout.trim().split(':').at(-1),
      );
    } else {
      await exec(pg('initdb'), [
        '-D',
        data,
        '-U',
        'postgres',
        '-A',
        'trust',
        '--no-locale',
        ...(process.env.PG_SHARE ? ['-L', process.env.PG_SHARE] : []),
      ]);
      await exec(pg('pg_ctl'), [
        '-D',
        data,
        '-l',
        path.join(root, 'postgres.log'),
        '-o',
        `-h 127.0.0.1 -p ${port} -k ${socket} -c max_connections=30`,
        '-w',
        'start',
      ]);
      stop = async () => {
        await exec(pg('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']);
      };
    }
    const sql = (query: string, db = 'postgres') =>
      exec(
        'psql',
        [
          '-X',
          '-h',
          '127.0.0.1',
          '-p',
          String(port),
          '-U',
          'postgres',
          '-d',
          db,
          '-v',
          'ON_ERROR_STOP=1',
          '-Atc',
          query,
        ],
        { env: { ...process.env, PGPASSWORD: 'synthetic' } },
      );
    for (let attempt = 0; ; attempt++) {
      try {
        await sql('SELECT 1');
        break;
      } catch (error) {
        if (attempt >= 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await sql('CREATE DATABASE target_a');
    await sql('CREATE DATABASE target_b');
    await sql(
      "CREATE ROLE diagnostic_reader LOGIN PASSWORD ' synthetic-test-password '; ALTER ROLE diagnostic_reader SET default_transaction_read_only=on; GRANT pg_read_all_stats TO diagnostic_reader; REVOKE CONNECT ON DATABASE target_b FROM PUBLIC",
    );
    await sql(
      "CREATE TABLE same_name(id int, value text); INSERT INTO same_name SELECT n, 'A_ONLY' FROM generate_series(1,20)n; GRANT USAGE ON SCHEMA public TO diagnostic_reader; GRANT SELECT ON same_name TO diagnostic_reader",
      'target_a',
    );
    await sql(
      "CREATE TABLE same_name(value text); INSERT INTO same_name VALUES ('B_PRIVATE')",
      'target_b',
    );
    await writeFile(path.join(root, 'pg-password'), ' synthetic-test-password \r\n');
    const config = {
      resourceId: 'pg-a',
      source: {
        type: 'postgres' as const,
        host: '127.0.0.1',
        port,
        database: 'target_a',
        user: 'diagnostic_reader',
        passwordFile: './pg-password',
      },
      queryTimeoutMs: 1000,
      maxRows: 3,
      maxResultBytes: 8192,
      poolMaxConnections: 2,
    };
    const plugin = await database.create(config, context(root));
    const result = await plugin.tools!.bind(bindingContext());
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') return;
    const binding = result.binding;
    try {
      const rows = await call(binding, 'execute_sql', {
        sql: 'SELECT * FROM same_name ORDER BY id',
      });
      assert.equal(rows.status, 'ok');
      assert.equal(rows.truncated, true, 'DBHub row limit must be preserved in evidence metadata');
      assert.ok(JSON.stringify(rows).includes('A_ONLY'));
      assert.ok(!JSON.stringify(rows).includes('B_PRIVATE'));
      const large = await call(binding, 'execute_sql', { sql: "SELECT repeat('x',10000)" });
      assert.equal(large.truncated, true, JSON.stringify(large).slice(0, 300));
      for (const query of [
        "INSERT INTO same_name VALUES (100,'bad')",
        'CREATE TABLE denied(id int)',
        'SET transaction_read_only=off; DELETE FROM same_name',
        "SELECT dblink_connect('dbname=target_b')",
      ])
        assert.equal((await call(binding, 'execute_sql', { sql: query })).status, 'error');
      assert.equal(
        (await call(binding, 'execute_sql', { sql: 'SELECT 1', source: 'target_b' })).status,
        'error',
      );
      const runtime = await call(binding, 'execute_sql', {
        sql: 'SELECT datname,state FROM pg_stat_activity; SELECT locktype,mode FROM pg_locks LIMIT 3',
      });
      assert.equal(runtime.status, 'ok');
      const long = await call(binding, 'execute_sql', { sql: 'SELECT pg_sleep(3)' });
      assert.equal(long.status, 'error');
      assert.equal(long.failure?.remoteStatus, 'unknown');
      const readerConnections = await sql(
        "SELECT count(*) FROM pg_stat_activity WHERE usename='diagnostic_reader'",
      );
      assert.ok(Number(readerConnections.stdout.trim()) <= 2);
    } finally {
      await binding.close();
    }
    const after = await sql(
      "SELECT count(*) FROM pg_stat_activity WHERE usename='diagnostic_reader'",
    );
    assert.equal(Number(after.stdout.trim()), 0);
    await sql(
      "CREATE ROLE diagnostic_b LOGIN PASSWORD 'synthetic-test-password'; GRANT CONNECT ON DATABASE target_b TO diagnostic_b",
    );
    await sql(
      'GRANT USAGE ON SCHEMA public TO diagnostic_b; GRANT SELECT ON same_name TO diagnostic_b',
      'target_b',
    );
    const { passwordFile: _passwordFile, ...bConnection } = config.source;
    const second = await database.create(
      {
        ...config,
        resourceId: 'pg-b',
        source: {
          ...bConnection,
          database: 'target_b',
          user: 'diagnostic_b',
          password: 'synthetic-test-password',
        },
      },
      context(root),
    );
    const a = await plugin.tools!.bind(bindingContext());
    const b = await second.tools!.bind({ ...bindingContext(), targetId: 'b', turnId: 'b' });
    assert.equal(a.status, 'ready');
    assert.equal(b.status, 'ready');
    if (a.status === 'ready' && b.status === 'ready') {
      let peak = 0;
      let done = false;
      const start = performance.now();
      const monitor = (async () => {
        while (!done) {
          const connections = await sql(
            "SELECT count(*) FROM pg_stat_activity WHERE usename IN ('diagnostic_reader','diagnostic_b')",
          );
          peak = Math.max(peak, Number(connections.stdout.trim()));
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      })();
      try {
        const outputs = await Promise.all(
          Array.from({ length: 16 }, async (_, index) => {
            const output = await call(index % 2 ? a.binding : b.binding, 'execute_sql', {
              sql: 'SELECT pg_sleep(0.05); SELECT * FROM same_name LIMIT 3',
            });
            assert.equal(output.status, 'ok');
            assert.ok(JSON.stringify(output.content).includes(index % 2 ? 'A_ONLY' : 'B_PRIVATE'));
            return output;
          }),
        );
        const bytes = outputs.reduce(
          (sum, output) => sum + Buffer.byteLength(JSON.stringify(output)),
          0,
        );
        assert.ok(peak <= 4);
        t.diagnostic(
          JSON.stringify({
            pgVersion: (await sql('SHOW server_version')).stdout.trim(),
            targets: 2,
            queries: 16,
            initializedBackends: 2,
            poolLimitEach: 2,
            connectionPeak: peak,
            returnedBytes: bytes,
            elapsedMs: Math.round(performance.now() - start),
          }),
        );
      } finally {
        done = true;
        await monitor;
        await a.binding.close();
        await b.binding.close();
      }
    }
    if (process.env.PG_TEST_IMAGE) {
      await writeFile(path.join(root, 'wrong-password'), 'intentionally-incorrect');
      const wrong = await database.create(
        { ...config, source: { ...config.source, passwordFile: './wrong-password' } },
        context(root),
      );
      const auth = await wrong.tools!.bind(bindingContext());
      assert.equal(auth.status, 'ready');
      if (auth.status === 'ready') {
        try {
          const denied = await call(auth.binding, 'execute_sql', { sql: 'SELECT 1' });
          assert.equal(denied.status, 'error');
        } finally {
          await auth.binding.close();
        }
      }
    }
    const unavailable = await database.create(
      { ...config, source: { ...config.source, port: 1 } },
      context(root),
    );
    const lazy = await unavailable.tools!.bind(bindingContext());
    assert.equal(lazy.status, 'ready');
    if (lazy.status === 'ready') {
      try {
        assert.equal(
          (await call(lazy.binding, 'execute_sql', { sql: 'SELECT 1' })).status,
          'error',
        );
      } finally {
        await lazy.binding.close();
      }
    }
  },
);
