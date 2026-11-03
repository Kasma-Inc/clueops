import ssh2 from 'ssh2';
const { Client } = ssh2;
import type { ConnectConfig } from 'ssh2';
import { compileContract, definePlugin, objectSchema } from '../../plugin-api/index.js';
import type { JsonObject, ToolDefinition, ToolQueryResult } from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';
import { withDeadline } from '../../core/lifecycle.js';
import { text } from '../shared.js';
import { authentication, authenticationSchema, hostKeys } from './authentication.js';
import type { Authentication } from './authentication.js';

interface Config {
  host: string;
  user: string;
  port?: number;
  knownHostsFile: string;
  auth: Authentication;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
  maxResultBytes?: number;
}
const commandSchema = objectSchema({
  command: { type: 'string', minLength: 1, maxLength: 16384, pattern: '^[^\\u0000]+$' },
});
const commandParser = compileContract<{ command: string }>(commandSchema, 'ssh command');

export default definePlugin<Config>({
  manifest: {
    id: 'ssh',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['tools'],
    configSchema: objectSchema(
      {
        host: { ...text, pattern: '^[A-Za-z0-9:][A-Za-z0-9.:-]*$', maxLength: 253 },
        user: { ...text, pattern: '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' },
        port: { type: 'integer', minimum: 1, maximum: 65535 },
        knownHostsFile: text,
        auth: authenticationSchema,
        connectTimeoutMs: { type: 'integer', minimum: 1, maximum: 15000 },
        queryTimeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
        maxResultBytes: { type: 'integer', minimum: 1024, maximum: 1048576 },
      },
      ['host', 'user', 'knownHostsFile', 'auth'],
    ),
  },
  async create(config, context) {
    const auth = await authentication(config.auth, context);
    const port = config.port ?? 22;
    const trust = await hostKeys(config.host, port, config.knownHostsFile, context);
    const resource = { host: config.host, port, user: config.user, transport: 'ssh' };
    const live = new Set<() => Promise<void>>();
    const definition: ToolDefinition = {
      name: 'execute',
      description: `在已绑定的${config.user}@${config.host}:${port}执行远程诊断命令，仅提交command。按只读取证任务使用；命令能力由远端账号权限约束。此工具直接返回可引用证据，无需local_command_evidence。`,
      inputSchema: commandSchema,
      readOnly: false,
    };
    return {
      scope: { ...resource, hostKeys: trust.fingerprints, authentication: config.auth.type },
      tools: {
        definitions: [definition],
        async bind(bindingContext) {
          bindingContext.signal.throwIfAborted();
          const client = new Client();
          let closed = false,
            closing: Promise<void> | undefined,
            busy = false,
            hostMismatch = false;
          let closeEvent!: () => void;
          const disconnected = new Promise<void>((resolve) => {
            closeEvent = resolve;
          });
          client.on('close', () => {
            closed = true;
            closeEvent();
          });
          // Keep an error listener for the whole transport lifetime, including cleanup.
          client.on('error', () => {});
          const close = () =>
            (closing ??= (async () => {
              client.destroy();
              try {
                await withDeadline(disconnected, 2000);
              } finally {
                bindingContext.signal.removeEventListener('abort', onAbort);
                live.delete(close);
              }
            })());
          const onAbort = () => {
            void close().catch(() => {});
          };
          bindingContext.signal.addEventListener('abort', onAbort, { once: true });
          live.add(close);
          let authStep = 0,
            combinedPasswordSent = false;
          const options: ConnectConfig = {
            host: config.host,
            port,
            username: config.user,
            ...(auth.password !== undefined ? { password: auth.password } : {}),
            ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
            ...(auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
            readyTimeout: config.connectTimeoutMs ?? 10000,
            keepaliveInterval: 5000,
            keepaliveCountMax: 2,
            hostHash: 'sha256',
            hostVerifier: (key: string) => {
              const accepted = trust.verify(key);
              if (!accepted) hostMismatch = true;
              return accepted;
            },
            authHandler(methods, partial, next) {
              const order: ('publickey' | 'password')[] =
                config.auth.type === 'password'
                  ? ['password']
                  : config.auth.type === 'private-key'
                    ? ['publickey']
                    : ['publickey', 'password'];
              const method = order[authStep++];
              if (
                !method ||
                (methods && !methods.includes(method)) ||
                (config.auth.type === 'private-key+password' && method === 'password' && !partial)
              )
                return false;
              if (config.auth.type === 'private-key+password' && method === 'password')
                combinedPasswordSent = true;
              return next(method);
            },
          };
          const ready = new Promise<void>((resolve, reject) => {
            client.once('ready', () => {
              if (config.auth.type === 'private-key+password' && !combinedPasswordSent)
                reject(new HostError('SSH_AUTH_POLICY_UNSATISFIED'));
              else resolve();
            });
            client.once('error', reject);
            client.once('close', () => reject(new HostError('SSH_CONNECTION_CLOSED')));
          });
          void ready.catch(() => {});
          try {
            client.connect(options);
            await withDeadline(ready, config.connectTimeoutMs ?? 10000, bindingContext.signal);
            bindingContext.signal.throwIfAborted();
          } catch {
            await close();
            bindingContext.signal.throwIfAborted();
            return {
              status: 'unavailable' as const,
              failure: {
                code: hostMismatch ? 'SSH_HOST_KEY_MISMATCH' : 'SSH_CONNECTION_UNAVAILABLE',
                message: 'SSH连接或认证不可用。',
              },
            };
          }
          const failure = (code: string, unknown = false, truncated = false): ToolQueryResult => ({
            status: 'error',
            content: null,
            resources: [resource],
            truncated,
            failure: {
              code,
              message: 'SSH命令未取得完整成功证据。',
              ...(unknown ? { remoteStatus: 'unknown' as const } : {}),
            },
          });
          return {
            status: 'ready' as const,
            binding: {
              close,
              async call(
                name: string,
                input: JsonObject,
                signal: AbortSignal,
              ): Promise<ToolQueryResult> {
                const { command } = commandParser.parse(input);
                if (name !== 'execute' || closed) return failure('SSH_CONNECTION_CLOSED');
                if (busy) return failure('SSH_COMMAND_BUSY');
                busy = true;
                const timeout = AbortSignal.timeout(config.queryTimeoutMs ?? 10000);
                const combined = AbortSignal.any([bindingContext.signal, signal, timeout]);
                let dispatched = false;
                try {
                  combined.throwIfAborted();
                  const result = await new Promise<ToolQueryResult>((resolve, reject) => {
                    let settled = false,
                      bytes = 0;
                    const stdout: Buffer[] = [],
                      stderr: Buffer[] = [];
                    const finish = (value?: ToolQueryResult, error?: unknown) => {
                      if (settled) return;
                      settled = true;
                      combined.removeEventListener('abort', abort);
                      client.removeListener('close', lost);
                      client.removeListener('error', lost);
                      if (error) reject(error);
                      else resolve(value!);
                    };
                    const lost = () => finish(failure('SSH_CONNECTION_LOST', dispatched));
                    const abort = () => {
                      finish(
                        failure(
                          timeout.aborted ? 'SSH_QUERY_TIMEOUT' : 'SSH_QUERY_CANCELLED',
                          dispatched,
                        ),
                      );
                      void close().catch(() => {});
                    };
                    combined.addEventListener('abort', abort, { once: true });
                    client.once('close', lost);
                    client.once('error', lost);
                    client.exec(command, { pty: false }, (error, stream) => {
                      if (settled) {
                        stream?.close();
                        return;
                      }
                      if (error) {
                        finish(failure('SSH_EXEC_FAILED', true));
                        return;
                      }
                      const capture = (chunks: Buffer[]) => (data: Buffer) => {
                        if (settled) return;
                        bytes += data.length;
                        if (bytes > (config.maxResultBytes ?? 65536)) {
                          finish(failure('SSH_RESULT_LIMIT', true, true));
                          void close().catch(() => {});
                        } else chunks.push(Buffer.from(data));
                      };
                      stream.on('data', capture(stdout));
                      stream.stderr.on('data', capture(stderr));
                      stream.once('error', lost);
                      stream.once(
                        'close',
                        (code: number | undefined, exitSignal: string | undefined) => {
                          if (settled) return;
                          const content = auth.redactor.value({
                            stdout: Buffer.concat(stdout).toString('utf8'),
                            stderr: Buffer.concat(stderr).toString('utf8'),
                            exitCode: code ?? null,
                            signal: exitSignal ?? null,
                          });
                          finish({
                            status: code === 0 && !exitSignal ? 'ok' : 'error',
                            content,
                            resources: [resource],
                            truncated: false,
                            ...(code === 0 && !exitSignal
                              ? {}
                              : {
                                  failure: {
                                    code: 'SSH_COMMAND_FAILED',
                                    message: '远程命令失败或退出状态未知。',
                                    ...(code === undefined
                                      ? { remoteStatus: 'unknown' as const }
                                      : {}),
                                  },
                                }),
                          });
                        },
                      );
                      stream.end();
                    });
                    dispatched = true;
                  });
                  bindingContext.signal.throwIfAborted();
                  signal.throwIfAborted();
                  return result;
                } finally {
                  busy = false;
                }
              },
            },
          };
        },
      },
      async dispose() {
        const results = await Promise.allSettled([...live].map((close) => close()));
        if (results.some((r) => r.status === 'rejected'))
          throw new HostError('SSH_CLEANUP_UNCONFIRMED');
      },
    };
  },
});
