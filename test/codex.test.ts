import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import codexPlugin from '../src/plugins/codex/index.js';
import { openTokenProxy } from '../src/plugins/codex/token-proxy.js';
import type {
  BoundDiagnosticTool,
  Evidence,
  InvestigationRequest,
  JsonValue,
} from '../src/plugin-api/index.js';
import { fixture, principal } from './helpers.js';
import { InvestigationStore } from '../src/core/store.js';
import { ToolRound } from '../src/core/tool-round.js';
import { messageKey } from '../src/core/identity.js';
import { validateReport } from '../src/core/reports.js';

test(
  'actual pinned Codex CLI binds only A tools on fresh/resumed turns and checks handle scope',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    const host = await f.loadHost();
    const scope = host.authorize(principal, 'a');
    let request: InvestigationRequest = {
      investigationId: 'incident-a',
      turnId: 'turn-one',
      scope,
      message: {
        address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
        senderId: 'user',
        messageId: 'first',
        text: 'Read evidence',
      },
    };
    let calls = 0;
    let requests = 0;
    let scenario = '';
    const captures: string[] = [];
    const evidence = (): Evidence => ({
      id: `evidence-${calls}`,
      investigationId: request.investigationId,
      turnId: request.turnId,
      targetId: 'a',
      providerInstanceId: 'a-tools',
      toolName: 'read',
      parameters: {},
      resources: [{ cluster: 'a' }],
      observedAt: new Date().toISOString(),
      status: 'ok',
      content: 'database connections exhausted',
      truncated: false,
    });
    const tool: BoundDiagnosticTool = {
      providerInstanceId: 'a-tools',
      definition: {
        name: 'read_a_evidence',
        description: 'Read target A evidence',
        readOnly: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      async call() {
        calls++;
        return evidence();
      },
    };
    const api = createServer(async (req, res) => {
      let raw = '';
      for await (const part of req) raw += String(part);
      assert.match(String(req.headers.authorization), /^Bearer SYNTHETIC_MODEL_KEY$/);
      if (req.url === '/v1/responses/input_tokens') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 }));
        return;
      }
      if (req.url !== '/v1/responses') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw);
      assert.equal(
        body.text?.format?.type,
        'json_schema',
        'structured output must reach the model on new and resumed turns',
      );
      captures.push(raw);
      const n = requests++;
      if (process.env.INCIDENT_TEST_DEBUG)
        console.log(
          JSON.stringify({
            n,
            tools: body.tools,
            extra: body.input?.filter((i: { type: string }) =>
              ['custom_tool_call_output', 'function_call_output', 'additional_tools'].includes(
                i.type,
              ),
            ),
          }),
        );
      const emit = (type: string, extra: unknown) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(extra as object) })}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = 'resp_' + n;
      emit('response.created', {
        response: { id, object: 'response', status: 'in_progress', output: [] },
      });
      const item =
        n % 2 === 0
          ? {
              id: 'tool_' + n,
              call_id: 'call_' + n,
              type: 'function_call',
              name: scenario === 'forged-b' ? 'read_b_evidence' : 'read_a_evidence',
              namespace: 'mcp__investigation',
              arguments: '{}',
            }
          : {
              id: 'msg_' + n,
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  annotations: [],
                  text: JSON.stringify({
                    investigationId: request.investigationId,
                    turnId: request.turnId,
                    targetId: 'a',
                    facts: calls ? [{ text: '连接耗尽', evidenceIds: [evidence().id] }] : [],
                    hypotheses: [],
                    recommendations: [],
                    missingEvidence: [],
                  }),
                },
              ],
            };
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', {
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      });
      res.end();
      assert.ok(body.max_output_tokens <= 8192);
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      api.closeAllConnections();
      await new Promise<void>((resolve) => api.close(() => resolve()));
    });
    const port = (api.address() as { port: number }).port;
    await writeFile(path.join(f.root, 'model-key'), 'SYNTHETIC_MODEL_KEY');
    const plugin = await codexPlugin.create(
      {
        apiKeyFile: './model-key',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'gpt-6',
        stateDirectory: './codex',
      },
      {
        instanceId: 'engine',
        configFile: path.join(f.root, 'codex.yaml'),
        resolvePath: (p) => path.resolve(f.root, p),
      },
    );
    t.after(() => plugin.dispose());
    let handle: JsonValue | undefined;
    for (const mode of ['fresh-a', 'resumed-a', 'forged-b']) {
      scenario = mode;
      requests = 0;
      request = { ...request, turnId: mode };
      const options = { scope, tools: [tool], budget: { maxModelTokens: 50000 } };
      const session = handle
        ? await plugin.engine!.resumeSession(handle, options, AbortSignal.timeout(25000))
        : await plugin.engine!.createSession(options, AbortSignal.timeout(25000));
      try {
        let reports = 0;
        for await (const event of session.runTurn(request, AbortSignal.timeout(25000)))
          if (event.type === 'report') reports++;
        assert.equal(reports, 1);
        handle = session.handle;
      } finally {
        await session.close();
      }
    }
    assert.equal(calls, 2, 'forged B tool is unavailable even after resume');
    const serialized = JSON.stringify(captures);
    assert.ok(!serialized.includes('TEST_SECRET_b-tools'));
    assert.ok(!serialized.includes('SYNTHETIC_MODEL_KEY'));
    assert.ok(captures.some((c) => c.includes('read_a_evidence')));
    await assert.rejects(
      plugin.engine!.resumeSession(
        handle!,
        { scope: host.authorize(principal, 'b'), tools: [tool] },
        AbortSignal.timeout(1000),
      ),
      /SESSION_SCOPE_MISMATCH/,
    );
  },
);

test('token gateway counts every retry, caps output before generation and refuses overspend', async (t) => {
  let count = 60;
  let actualInput: number | undefined;
  let generated = 0;
  let cap = 0;
  const api = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += String(part);
    res.setHeader(
      'content-type',
      req.url?.endsWith('input_tokens') ? 'application/json' : 'text/event-stream',
    );
    if (req.url?.endsWith('input_tokens'))
      res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: count }));
    else {
      generated++;
      cap = JSON.parse(raw).max_output_tokens;
      res.end(
        `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: actualInput ?? count, output_tokens: 30 } } })}\n\n`,
      );
    }
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });
  const proxy = await openTokenProxy(
    `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`,
    'key',
    100,
    new AbortController().signal,
  );
  t.after(() => proxy.close());
  const call = () =>
    fetch(proxy.baseUrl + '/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify({ model: 'test', input: 'test' }),
    });
  const first = await call();
  await first.text();
  assert.equal(cap, 40);
  assert.equal(proxy.usage.used, 90);
  count = 11;
  const second = await call();
  assert.equal(second.status, 429);
  assert.equal(generated, 1);
  count = 60;
  actualInput = 71;
  const overflow = await openTokenProxy(
    `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`,
    'key',
    100,
    new AbortController().signal,
  );
  t.after(() => overflow.close());
  await assert.rejects(async () => {
    const response = await fetch(overflow.baseUrl + '/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${overflow.token}` },
      body: JSON.stringify({ model: 'test', input: 'test' }),
    });
    await response.text();
  });
  assert.equal(overflow.usage.exhausted, true);
  assert.equal(overflow.usage.inputTokens, 71, 'confirmed overspend is recorded before rejection');
  assert.equal(overflow.usage.outputTokens, 30);
  assert.equal(overflow.usage.complete, true);
});

test(
  'actual Codex executes native commands without MCP sources and retrieves persisted evidence; explicit opt-out removes shell',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const host = await f.loadHost();
    const store = await InvestigationStore.open(path.join(f.root, 'state'));
    t.after(() => store.close());
    const request: InvestigationRequest = {
      investigationId: 'native-incident',
      turnId: 'native-turn',
      scope: host.authorize(principal, 'a'),
      message: {
        address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
        senderId: 'user',
        messageId: 'native-message',
        text: 'Read native evidence',
      },
    };
    await store.accept({
      version: 1,
      key: messageKey(request.message),
      acceptedAt: new Date().toISOString(),
      sequence: 1,
      request,
    });
    await store.setTurn(request.turnId, 'running');
    const round = new ToolRound(
      request,
      store,
      host.redactor,
      { ...host.runtime, maxResultBytes: 2 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 },
      AbortSignal.timeout(45000),
    );
    t.after(() => round.close());
    await round.open([]);
    host.redactor.add(['SYNTHETIC_NATIVE_OUTPUT']);
    const captured: Evidence[] = [];
    let enabled = true;
    let large = false;
    let calls = 0;
    let toolCatalog = '';
    const api = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      if (req.url === '/v1/responses/input_tokens') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 }));
        return;
      }
      const body = JSON.parse(raw);
      toolCatalog = JSON.stringify(body.tools);
      const n = calls++;
      if (process.env.INCIDENT_TEST_DEBUG && n === 0) console.log('NATIVE_TOOLS', toolCatalog);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type: string, extra: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
      const item =
        enabled && n === 0
          ? {
              id: 'native-call',
              call_id: 'native-call',
              type: 'function_call',
              name: 'exec_command',
              arguments: JSON.stringify({
                cmd: large
                  ? "i=0; while [ $i -lt 100000 ]; do printf 'line-%05d detail detail detail detail\\n' $i; i=$((i+1)); done; printf END_MARKER"
                  : "printf 'NATIVE_OK password=SYNTHETIC_NATIVE_OUTPUT\\n'",
                max_output_tokens: 1000,
              }),
            }
          : enabled && n === 1
            ? {
                id: 'read-native-evidence',
                call_id: 'read-native-evidence',
                type: 'function_call',
                name: 'local_command_evidence',
                namespace: 'mcp__investigation',
                arguments: '{}',
              }
            : {
                id: 'native-report',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    annotations: [],
                    text: JSON.stringify({
                      investigationId: request.investigationId,
                      turnId: request.turnId,
                      targetId: 'a',
                      facts:
                        enabled && captured.length && captured.at(-1)!.status === 'ok'
                          ? [{ text: 'NATIVE_OK', evidenceIds: [captured.at(-1)!.id] }]
                          : [],
                      hypotheses: [],
                      recommendations: [],
                      missingEvidence: [],
                    }),
                  },
                ],
              };
      const id = 'native-response-' + n;
      emit('response.created', {
        response: { id, object: 'response', status: 'in_progress', output: [] },
      });
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', {
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      });
      res.end();
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      api.closeAllConnections();
      api.close();
    });
    for (const mode of ['small', 'large', 'disabled']) {
      const localCommands = mode === 'disabled' ? false : undefined;
      large = mode === 'large';
      enabled = localCommands !== false;
      calls = 0;
      captured.length = 0;
      const plugin = await codexPlugin.create(
        {
          apiKey: 'SYNTHETIC_NATIVE_MODEL_KEY',
          baseUrl: `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`,
          model: 'gpt-6',
          ...(localCommands !== undefined ? { localCommands } : {}),
          stateDirectory: `./${mode}-codex`,
        },
        {
          instanceId: 'engine',
          configFile: path.join(f.root, 'codex.yaml'),
          resolvePath: (p) => path.resolve(f.root, p),
          registerSecrets: (values) => host.redactor.add(values),
        },
      );
      assert.equal(plugin.engine!.supportsNativeTools, enabled);
      assert.equal(plugin.scope.nativeShell, enabled);
      const session = await plugin.engine!.createSession(
        {
          scope: request.scope,
          tools: [],
          recordEvidence: async (observation, signal) => {
            const evidence = await round.recordEngineEvidence(observation, signal);
            captured.push(evidence);
            return evidence;
          },
        },
        AbortSignal.timeout(20000),
      );
      try {
        let reports = 0;
        for await (const event of session.runTurn(request, AbortSignal.timeout(20000)))
          if (event.type === 'report') {
            validateReport(event.report, request, await store.evidence(request.turnId));
            reports++;
          }
        assert.equal(reports, 1);
        if (enabled) {
          assert.equal(captured.length, 2, toolCatalog);
          assert.equal(captured[0]!.toolName, 'command_execution');
          assert.equal(captured[1]!.toolName, 'command_evidence');
          assert.equal(captured[1]!.parameters.sourceEvidenceId, captured[0]!.id);
          if (large) {
            for (const evidence of captured) {
              assert.equal(evidence.status, 'error');
              assert.equal(evidence.truncated, true);
              assert.equal(evidence.failure?.code, 'LOCAL_COMMAND_OUTPUT_INCOMPLETE');
              assert.equal((evidence.content as { exitCode: number }).exitCode, 0);
              assert.match(
                (evidence.content as { output: string }).output,
                /\.\.\. \d+ bytes omitted \.\.\./,
              );
              assert.ok((evidence.content as { output: string }).output.includes('END_MARKER'));
            }
          } else {
            assert.equal(captured[0]!.status, 'ok', JSON.stringify(captured));
            assert.ok(JSON.stringify(captured[0]!).includes('NATIVE_OK'));
          }
          assert.ok(!JSON.stringify(captured[0]!).includes('SYNTHETIC_NATIVE_OUTPUT'));
          assert.equal(calls, 3);
        } else {
          assert.ok(!toolCatalog.includes('"exec_command"'), toolCatalog);
          assert.ok(!toolCatalog.includes('local_command_evidence'), toolCatalog);
          assert.equal(calls, 1);
        }
      } finally {
        await session.close();
        await plugin.dispose();
      }
    }
  },
);

test(
  'cancelling an actual native command closes its orphaned local process',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const host = await f.loadHost();
    let pidFile = '';
    let doneFile = '';
    let command = '';
    const marker = path.basename(f.root) + '-native-cancel';
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const request: InvestigationRequest = {
      investigationId: 'cancel-native',
      turnId: 'cancel-native-turn',
      scope: host.authorize(principal, 'a'),
      message: {
        address: { channelInstanceId: 'chat', tenantId: 'tenant', conversationId: 'room' },
        senderId: 'user',
        messageId: 'cancel-native-message',
        text: 'Run native query',
      },
    };
    let requests = 0;
    const api = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      if (req.url === '/v1/responses/input_tokens') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 }));
        return;
      }
      const n = requests++;
      const item =
        n === 0
          ? {
              id: 'long-command',
              call_id: 'long-command',
              type: 'function_call',
              name: 'exec_command',
              arguments: JSON.stringify({
                cmd: command,
                yield_time_ms: 1000,
                max_output_tokens: 1000,
              }),
            }
          : {
              id: 'cancel-report',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  annotations: [],
                  text: JSON.stringify({
                    investigationId: request.investigationId,
                    turnId: request.turnId,
                    targetId: 'a',
                    facts: [],
                    hypotheses: [],
                    recommendations: [],
                    missingEvidence: [],
                  }),
                },
              ],
            };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (type: string, extra: object) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`);
      const id = 'cancel-response-' + n;
      emit('response.created', {
        response: { id, object: 'response', status: 'in_progress', output: [] },
      });
      emit('response.output_item.added', { output_index: 0, item });
      emit('response.output_item.done', { output_index: 0, item });
      emit('response.completed', {
        response: {
          id,
          object: 'response',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      });
      res.end();
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      api.closeAllConnections();
      api.close();
    });
    const plugin = await codexPlugin.create(
      {
        apiKey: 'SYNTHETIC_CANCEL_KEY',
        model: 'gpt-6',
        baseUrl: `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`,
        stateDirectory: './cancel-codex',
      },
      {
        instanceId: 'engine',
        configFile: path.join(f.root, 'codex.yaml'),
        resolvePath: (p) => path.resolve(f.root, p),
      },
    );
    const abort = new AbortController();
    const session = await plugin.engine!.createSession(
      { scope: request.scope, tools: [] },
      abort.signal,
    );
    const handle = session.handle as { directoryId: string };
    const work = path.join(f.root, 'cancel-codex', handle.directoryId, 'work');
    pidFile = path.join(work, 'native.pid');
    doneFile = path.join(work, 'native.done');
    command = `/bin/sh -c ${quote(`echo $$ > ${quote(pidFile)}; sleep 20; echo done > ${quote(doneFile)}`)} ${quote(marker)}`;
    const run = (async () => {
      try {
        for await (const event of session.runTurn(request, abort.signal)) void event;
      } catch {}
    })();
    let pid: number | undefined;
    try {
      const deadline = Date.now() + 10000;
      while (!pid && Date.now() < deadline) {
        try {
          pid = Number(await readFile(pidFile, 'utf8'));
        } catch {}
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(pid, 'native command must actually start before cancellation');
      abort.abort();
      await session.close();
      await run;
      let running = true;
      const stopDeadline = Date.now() + 1000;
      while (running && Date.now() < stopDeadline) {
        try {
          process.kill(pid, 0);
        } catch {
          running = false;
        }
        if (running) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(running, false, 'native process must not outlive successful close');
      await assert.rejects(readFile(doneFile), { code: 'ENOENT' });
    } finally {
      abort.abort();
      await session.close().catch(() => {});
      await plugin.dispose().catch(() => {});
      await run;
      if (pid)
        try {
          const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
            encoding: 'utf8',
          });
          if (cmd.includes(marker)) process.kill(pid, 'SIGKILL');
        } catch {}
    }
  },
);

test('uncapped model gateway forwards output settings without pre-counting and records only confirmed usage', async (t) => {
  let requests = 0;
  const bodies: Record<string, unknown>[] = [];
  const api = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/responses', 'uncapped mode needs no token-count endpoint');
    assert.equal(req.headers.authorization, 'Bearer SYNTHETIC_KEY');
    let raw = '';
    for await (const part of req) raw += String(part);
    bodies.push(JSON.parse(raw));
    requests++;
    res.setHeader('content-type', 'text/event-stream');
    res.end(
      `data: ${JSON.stringify({ type: 'response.completed', response: requests === 1 ? { usage: { input_tokens: 250000, output_tokens: 100 } } : {} })}\n\n`,
    );
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    api.closeAllConnections();
    api.close();
  });
  const proxy = await openTokenProxy(
    `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`,
    'SYNTHETIC_KEY',
    undefined,
    new AbortController().signal,
  );
  t.after(() => proxy.close());
  for (const body of [{ model: 'test', max_output_tokens: 16384 }, { model: 'test' }]) {
    const response = await fetch(proxy.baseUrl + '/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(bodies[0]!.max_output_tokens, 16384);
  assert.ok(!Object.hasOwn(bodies[1]!, 'max_output_tokens'));
  assert.deepEqual(proxy.usage, {
    used: 250100,
    maximum: undefined,
    requests: 2,
    exhausted: false,
    inputTokens: 250000,
    outputTokens: 100,
    complete: false,
  });
});
