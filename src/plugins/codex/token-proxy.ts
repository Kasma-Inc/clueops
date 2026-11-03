import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { SerialQueue } from '../../core/serial.js';
import { HostError } from '../../core/errors.js';
import { object } from '../shared.js';

const countFields = new Set([
  'conversation',
  'input',
  'instructions',
  'model',
  'parallel_tool_calls',
  'personality',
  'previous_response_id',
  'reasoning',
  'text',
  'tool_choice',
  'tools',
  'truncation',
]);
/** Owns API credentials and records usage; only an explicit cap enables preflight reservations. */
export async function openTokenProxy(
  baseUrl: string,
  apiKey: string,
  maximum: number | undefined,
  parent: AbortSignal,
) {
  const token = randomBytes(32).toString('hex');
  const abort = new AbortController();
  const signal = AbortSignal.any([parent, abort.signal]);
  const queue = new SerialQueue();
  let used = 0;
  let requests = 0;
  let confirmed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let exhausted = false;
  const limit = 16 * 1024 * 1024;
  const http = createServer(async (req, res) => {
    const fail = (status: number, code: string) => {
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: code, type: 'invalid_request_error', code } }));
    };
    if (
      req.method !== 'POST' ||
      req.url !== '/v1/responses' ||
      req.headers.authorization !== `Bearer ${token}` ||
      signal.aborted
    ) {
      fail(403, 'MODEL_ROUTE_DENIED');
      return;
    }
    const parts: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > limit) {
          fail(413, 'MODEL_INPUT_TOO_LARGE');
          return;
        }
        parts.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!object(body)) throw new Error();
      await queue.run(async () => {
        signal.throwIfAborted();
        if (maximum !== undefined && used >= maximum) {
          exhausted = true;
          fail(429, 'MODEL_TOKEN_BUDGET_EXHAUSTED');
          return;
        }
        const clientAbort = new AbortController();
        const onClose = () => {
          if (!res.writableFinished) clientAbort.abort();
        };
        res.on('close', onClose);
        const requestSignal = AbortSignal.any([
          signal,
          clientAbort.signal,
          AbortSignal.timeout(120000),
        ]);
        let reserved = 0;
        let settled = false;
        try {
          const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
          let maxOutput: number | undefined;
          if (maximum !== undefined) {
            const counted = await fetch(baseUrl.replace(/\/$/, '') + '/responses/input_tokens', {
              method: 'POST',
              headers,
              body: JSON.stringify(
                Object.fromEntries(Object.entries(body).filter(([key]) => countFields.has(key))),
              ),
              signal: requestSignal,
            });
            if (!counted.ok) {
              await counted.body?.cancel();
              throw new HostError('MODEL_TOKEN_COUNT_FAILED');
            }
            const count: unknown = await counted.json();
            if (
              !object(count) ||
              !Number.isSafeInteger(count.input_tokens) ||
              Number(count.input_tokens) < 0
            )
              throw new HostError('MODEL_TOKEN_COUNT_INVALID');
            const input = Number(count.input_tokens);
            const remaining = maximum - used - input;
            if (remaining < 1) {
              used = maximum;
              exhausted = true;
              fail(429, 'MODEL_TOKEN_BUDGET_EXHAUSTED');
              return;
            }
            const requested =
              typeof body.max_output_tokens === 'number' ? body.max_output_tokens : 8192;
            maxOutput = Math.min(Math.max(1, requested), 8192, remaining);
            reserved = input + maxOutput;
            used += reserved;
          }
          requests++;
          const upstream = await fetch(baseUrl.replace(/\/$/, '') + '/responses', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              ...body,
              stream: true,
              ...(maxOutput === undefined ? {} : { max_output_tokens: maxOutput }),
              store: false,
            }),
            signal: requestSignal,
          });
          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel();
            throw new HostError('MODEL_REQUEST_FAILED');
          }
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          let pending = '';
          let total = 0;
          const decoder = new TextDecoder();
          for await (const chunk of upstream.body) {
            total += chunk.byteLength;
            if (total > limit) throw new HostError('MODEL_RESPONSE_TOO_LARGE');
            pending += decoder.decode(chunk, { stream: true });
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, end).trimEnd();
              pending = pending.slice(end + 1);
              if (!line.startsWith('data:')) continue;
              let event: unknown;
              try {
                event = JSON.parse(line.slice(5));
              } catch {
                continue;
              }
              if (
                object(event) &&
                ['response.completed', 'response.incomplete', 'response.failed'].includes(
                  String(event.type),
                ) &&
                object(event.response) &&
                object(event.response.usage)
              ) {
                const usage = event.response.usage;
                if (
                  Number.isSafeInteger(usage.input_tokens) &&
                  Number.isSafeInteger(usage.output_tokens) &&
                  Number(usage.input_tokens) >= 0 &&
                  Number(usage.output_tokens) >= 0
                ) {
                  const actual = Number(usage.input_tokens) + Number(usage.output_tokens);
                  if (!settled) {
                    used += actual - reserved;
                    inputTokens += Number(usage.input_tokens);
                    outputTokens += Number(usage.output_tokens);
                    confirmed++;
                    settled = true;
                  }
                  if (maximum !== undefined && actual > reserved) {
                    used = maximum;
                    exhausted = true;
                    throw new HostError('MODEL_USAGE_EXCEEDS_RESERVATION');
                  }
                }
              }
            }
            if (!res.write(chunk)) await once(res, 'drain', { signal: requestSignal });
          }
          res.end();
        } finally {
          res.off(
            'close',
            onClose,
          ); /* Missing terminal usage conservatively consumes the reservation. */
        }
      });
    } catch (error) {
      if (!res.headersSent)
        fail(502, error instanceof HostError ? error.code : 'MODEL_PROXY_FAILED');
      else res.destroy();
    }
  });
  http.requestTimeout = 120000;
  http.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new HostError('MODEL_PROXY_LISTEN_FAILED');
  let closing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    token,
    get usage() {
      return {
        used,
        maximum,
        requests,
        exhausted,
        inputTokens,
        outputTokens,
        complete: requests === confirmed,
      };
    },
    close(): Promise<void> {
      if (closing) return closing;
      abort.abort();
      http.closeAllConnections();
      closing = new Promise<void>((resolve) => http.close(() => resolve()));
      return closing;
    },
  };
}
