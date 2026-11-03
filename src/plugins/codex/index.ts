import { Codex } from '@openai/codex-sdk';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ContractError,
  compileContract,
  definePlugin,
  objectSchema,
  schemas,
  validators,
} from '../../plugin-api/index.js';
import type {
  AgentSession,
  EngineEvent,
  EngineSessionOptions,
  JsonValue,
  JsonObject,
} from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';
import { withDeadline } from '../../core/lifecycle.js';
import { openToolBridge } from '../../mcp/bridge.js';
import { credential, privateRedactor, text } from '../shared.js';
import { openTokenProxy } from './token-proxy.js';
import { CommandEvidence } from './commands.js';
import { prepareSkillWorkspace } from './skills.js';
import { authenticationFromFile } from './auth.js';
import { authFilePath } from './auth.js';
import { filesystemSchema, permissionProfile, resolveFilesystem } from './permissions.js';
import type { FilesystemConfig } from './permissions.js';
import promptTemplate from '../../generated/prompts/codex/investigation.js';
import nativeCommandPrompt from '../../generated/prompts/codex/native-commands.js';

interface Config {
  apiKey?: string;
  apiKeyFile?: string;
  authFile?: string;
  baseUrl?: string;
  model: string;
  stateDirectory?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  launcher?: string;
  localCommands?: boolean;
  sandboxMode?: 'restricted' | 'danger-full-access';
  filesystem?: FilesystemConfig;
}
interface Handle {
  version: 1;
  instanceId: string;
  targetId: string;
  revision: string;
  directoryId: string;
  threadId: string | null;
  usage?: { input_tokens: number; output_tokens: number };
  usageUncertain?: boolean;
}
// The API supports a JSON Schema subset; Core still enforces unique evidence references.
const reportOutputSchema: JsonObject = JSON.parse(
  JSON.stringify(schemas.report, (key, value: unknown) =>
    key === 'uniqueItems' ? undefined : value,
  ),
);
const handleValidator = compileContract<Handle>(
  objectSchema(
    {
      version: { const: 1 },
      instanceId: text,
      targetId: text,
      revision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      directoryId: { type: 'string', format: 'uuid' },
      threadId: { anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }] },
      usage: objectSchema({
        input_tokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        output_tokens: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      }),
      usageUncertain: { type: 'boolean' },
    },
    ['version', 'instanceId', 'targetId', 'revision', 'directoryId', 'threadId'],
  ),
  'codex handle',
);
const execute = promisify(execFile);

async function savedThreads(home: string, ids: ReadonlySet<string>): Promise<Set<string>> {
  const found = new Set<string>();
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
      else if (entry.isFile()) {
        const id = /-([a-f0-9-]{36})\.jsonl(?:\.zst)?$/.exec(entry.name)?.[1];
        if (id && ids.has(id)) found.add(id);
      }
    }
  }
  await visit(path.join(home, 'sessions'));
  await visit(path.join(home, 'archived_sessions'));
  return found;
}
async function knowledge(paths: readonly string[]): Promise<string> {
  let result = '';
  async function read(file: string, depth: number): Promise<void> {
    if (depth > 4) throw new HostError('KNOWLEDGE_TOO_DEEP');
    const info = await stat(file);
    if (info.isDirectory()) {
      for (const entry of (await readdir(file, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        if (entry.isDirectory() || entry.name.endsWith('.md'))
          await read(path.join(file, entry.name), depth + 1);
      }
    } else {
      if (info.size > 262144) throw new HostError('KNOWLEDGE_TOO_LARGE');
      result += `\n<knowledge name=${JSON.stringify(path.basename(file))}>\n${await readFile(file, 'utf8')}\n</knowledge>`;
    }
    if (Buffer.byteLength(result) > 524288) throw new HostError('KNOWLEDGE_TOO_LARGE');
  }
  for (const file of paths) await read(file, 0);
  return result;
}
export default definePlugin<Config>({
  manifest: {
    id: 'codex',
    version: '1.0.0',
    apiVersion: 1,
    capabilities: ['engine'],
    configSchema: {
      ...objectSchema(
        {
          apiKeyFile: text,
          apiKey: text,
          authFile: text,
          baseUrl: { type: 'string', format: 'uri' },
          model: text,
          stateDirectory: text,
          reasoningEffort: { enum: ['low', 'medium', 'high'] },
          launcher: text,
          localCommands: { type: 'boolean' },
          sandboxMode: { enum: ['restricted', 'danger-full-access'] },
          filesystem: filesystemSchema,
        },
        ['model'],
      ),
      oneOf: ['apiKey', 'apiKeyFile', 'authFile'].map((key) => ({
        properties: { [key]: {} },
        required: [key],
      })),
      not: {
        properties: { sandboxMode: { const: 'danger-full-access' }, filesystem: {} },
        required: ['sandboxMode', 'filesystem'],
      },
    },
  },
  async create(config, context) {
    const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    const url = new URL(baseUrl);
    if (
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new HostError('MODEL_ENDPOINT_INVALID');
    const auth = config.authFile
      ? await authenticationFromFile(config.authFile, context)
      : {
          kind: 'apiKey' as const,
          key: await credential(config.apiKey, config.apiKeyFile, context),
        };
    if (auth.kind === 'chatgpt' && config.baseUrl !== undefined) {
      auth.release();
      throw new HostError('CODEX_CHATGPT_BASE_URL_UNSUPPORTED');
    }
    if (auth.kind === 'apiKey') privateRedactor([auth.key], context);
    const root = config.stateDirectory
      ? context.resolvePath(config.stateDirectory)
      : (context.stateDirectory ?? context.resolvePath('.clueops/plugins/' + context.instanceId));
    const unrestricted = config.sandboxMode === 'danger-full-access';
    let access: Awaited<ReturnType<typeof resolveFilesystem>>;
    const protectedPaths = [
      context.configFile,
      root,
      ...(context.stateDirectory ? [path.resolve(context.stateDirectory, '../..')] : []),
      ...(config.authFile ? [authFilePath(config.authFile, context)] : []),
      ...(config.apiKeyFile ? [context.resolvePath(config.apiKeyFile)] : []),
    ];
    try {
      access = await resolveFilesystem(config.filesystem, context, protectedPaths);
    } catch (error) {
      if (auth.kind === 'chatgpt') auth.release();
      throw error;
    }
    const live = new Set<AgentSession>();
    const launcher = config.launcher
      ? context.resolvePath(config.launcher)
      : fileURLToPath(new URL('../../../tools/codex-launcher.mjs', import.meta.url));
    async function session(
      options: EngineSessionOptions,
      parent: AbortSignal,
      previous?: JsonValue,
    ): Promise<AgentSession> {
      parent.throwIfAborted();
      const handle: Handle =
        previous === undefined
          ? {
              version: 1,
              instanceId: context.instanceId,
              targetId: options.scope.target.targetId,
              revision: options.scope.target.revision,
              directoryId: randomUUID(),
              threadId: null,
            }
          : { ...handleValidator.parse(previous) };
      if (
        handle.instanceId !== context.instanceId ||
        handle.targetId !== options.scope.target.targetId ||
        handle.revision !== options.scope.target.revision
      )
        throw new HostError('SESSION_SCOPE_MISMATCH');
      const maximum = options.budget?.maxModelTokens;
      const baselineKnown = !handle.usageUncertain && (!handle.threadId || !!handle.usage);
      if (auth.kind === 'chatgpt' && maximum !== undefined && !baselineKnown)
        throw new HostError('MODEL_USAGE_CHECKPOINT_REQUIRED');
      if (auth.kind === 'chatgpt' && !handle.usage) {
        handle.usage = { input_tokens: 0, output_tokens: 0 };
      }
      const baseline = { ...(handle.usage ?? { input_tokens: 0, output_tokens: 0 }) };
      let nativeUsed = 0;
      let nativeComplete = baselineKnown;
      let nativeFailure: HostError | undefined;
      const notes = await knowledge(options.scope.target.knowledge);
      const directory = path.join(root, handle.directoryId);
      const home = path.join(directory, 'home');
      const work = path.join(directory, 'work');
      const temporary = path.join(directory, 'tmp');
      await prepareSkillWorkspace(home, work, options.scope.target.skills ?? [], parent);
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      const codexHome = auth.kind === 'chatgpt' ? await auth.home() : path.join(home, '.codex');
      parent.throwIfAborted();
      const abort = new AbortController();
      const signal = AbortSignal.any([parent, abort.signal]);
      const originalRecord = options.recordEvidence;
      const record =
        originalRecord && auth.kind === 'chatgpt'
          ? async (...args: Parameters<typeof originalRecord>) => {
              await auth.registerCurrent();
              return originalRecord(...args);
            }
          : originalRecord;
      const commands = new CommandEvidence(context.instanceId, record);
      const tools = options.tools.map((tool) =>
        auth.kind === 'chatgpt'
          ? {
              ...tool,
              async call(...args: Parameters<typeof tool.call>) {
                await auth.registerCurrent();
                return tool.call(...args);
              },
            }
          : tool,
      );
      if (config.localCommands !== false && commands.tool) tools.push(commands.tool);
      const bridge = await openToolBridge(tools, signal);
      let proxy;
      try {
        if (auth.kind === 'apiKey')
          proxy = await openTokenProxy(baseUrl, auth.key, maximum, signal);
      } catch (error) {
        await bridge.close();
        throw error;
      }
      const boundedProxy = proxy;
      let closed = false;
      let running = false;
      let closing: Promise<void> | undefined;
      let runFinished: Promise<void> = Promise.resolve();
      let finishRun: (() => void) | undefined;
      const pidFiles: string[] = [];
      const adapter: AgentSession = {
        get handle() {
          return { ...handle, ...(handle.usage ? { usage: { ...handle.usage } } : {}) };
        },
        async *runTurn(request, turnSignal): AsyncIterable<EngineEvent> {
          if (closed || running) throw new HostError('SESSION_NOT_AVAILABLE');
          if (
            request.scope.target.targetId !== handle.targetId ||
            request.scope.target.revision !== handle.revision
          )
            throw new HostError('SESSION_SCOPE_MISMATCH');
          running = true;
          runFinished = new Promise((resolve) => {
            finishRun = resolve;
          });
          let completed = false;
          let usageFailure: HostError | undefined;
          let finalResponse = '';
          let usageEmitted = false;
          const usageEvent = (): EngineEvent => {
            const api = boundedProxy?.usage;
            return {
              type: 'usage',
              usage: api
                ? {
                    inputTokens: api.inputTokens,
                    outputTokens: api.outputTokens,
                    complete: api.complete,
                  }
                : {
                    inputTokens: baselineKnown
                      ? handle.usage!.input_tokens - baseline.input_tokens
                      : 0,
                    outputTokens: baselineKnown
                      ? handle.usage!.output_tokens - baseline.output_tokens
                      : 0,
                    complete: nativeComplete,
                  },
            };
          };
          const turnParent = AbortSignal.any([signal, turnSignal]);
          const runAbort = new AbortController();
          const onAbort = () => runAbort.abort(turnParent.reason);
          turnParent.addEventListener('abort', onAbort, { once: true });
          if (turnParent.aborted) onAbort();
          try {
            const combined = runAbort.signal;
            combined.throwIfAborted();
            if (auth.kind === 'chatgpt') {
              if (nativeFailure) throw nativeFailure;
              if (maximum !== undefined && nativeUsed >= maximum)
                throw new HostError('MODEL_TOKEN_BUDGET_EXHAUSTED');
              await auth.registerCurrent();
              nativeComplete = false;
              handle.usageUncertain = true;
            }
            const pidFile = path.join(directory, 'run-' + randomUUID() + '.pid');
            pidFiles.push(pidFile);
            const permissions = unrestricted
              ? { config: {}, configOverrides: [] }
              : await permissionProfile({ home, work, temporary, codexHome, access });
            const codex = new Codex({
              configOverrides: permissions.configOverrides,
              codexPathOverride: launcher,
              env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: home,
                CODEX_HOME: codexHome,
                TMPDIR: temporary,
                LANG: 'en_US.UTF-8',
                ...(boundedProxy ? { INCIDENT_MODEL_TOKEN: boundedProxy.token } : {}),
                INCIDENT_TOOL_TOKEN: bridge.token,
                INCIDENT_CODEX_PID_FILE: pidFile,
              },
              config: {
                ...permissions.config,
                ...(boundedProxy
                  ? {
                      model_provider: 'investigation',
                      model_providers: {
                        investigation: {
                          name: 'Scoped investigation model gateway',
                          base_url: boundedProxy.baseUrl,
                          wire_api: 'responses',
                          env_key: 'INCIDENT_MODEL_TOKEN',
                          requires_openai_auth: false,
                          supports_websockets: false,
                          request_max_retries: 0,
                          stream_max_retries: 0,
                        },
                      },
                    }
                  : { model_provider: 'openai', cli_auth_credentials_store: 'file' }),
                mcp_servers: tools.length
                  ? {
                      investigation: {
                        url: bridge.url,
                        bearer_token_env_var: 'INCIDENT_TOOL_TOKEN',
                        enabled: true,
                        required: true,
                        enabled_tools: tools.map((t) => t.definition.name),
                        // Only this host-authorized round's allowlist is exposed.
                        default_tools_approval_mode: 'approve',
                        startup_timeout_sec: 10,
                        tool_timeout_sec: 25,
                      },
                    }
                  : {},
                features: {
                  network_proxy: !unrestricted,
                  use_legacy_landlock: false,
                  shell_tool: config.localCommands !== false,
                  shell_snapshot: false,
                  apps: false,
                  plugins: false,
                  remote_plugin: false,
                  memories: false,
                  request_permissions_tool: false,
                  skill_mcp_dependency_install: false,
                  view_image: false,
                  hooks: false,
                  image_generation: false,
                  tool_suggest: false,
                  plugin_discovery_prefetch: false,
                  code_mode: { enabled: false },
                },
                agents: { enabled: false },
                web_search: 'disabled',
                analytics: { enabled: false },
                feedback: { enabled: false },
                shell_environment_policy: {
                  inherit: 'none',
                  set: {
                    PATH: process.env.PATH ?? '/usr/bin:/bin',
                    HOME: home,
                    TMPDIR: temporary,
                    LANG: 'en_US.UTF-8',
                    INCIDENT_CODEX_PID_FILE: pidFile,
                  },
                },
              },
            });
            const threadOptions = {
              model: config.model,
              ...(unrestricted ? { sandboxMode: 'danger-full-access' as const } : {}),
              workingDirectory: work,
              skipGitRepoCheck: true,
              approvalPolicy: 'never' as const,
              webSearchMode: 'disabled' as const,
              modelReasoningEffort: config.reasoningEffort ?? ('medium' as const),
            };
            const thread = handle.threadId
              ? codex.resumeThread(handle.threadId, threadOptions)
              : codex.startThread(threadOptions);
            const { skills: _skills, ...targetContext } = options.scope.target;
            const contextValues: Record<string, string> = {
              inputEvidenceId: 'input-' + request.turnId,
              reportIdentity: JSON.stringify({
                investigationId: request.investigationId,
                turnId: request.turnId,
                targetId: request.scope.target.targetId,
              }),
              targetContext: JSON.stringify(targetContext),
              knowledge: notes,
              history: JSON.stringify(options.history ?? null),
              userLog: request.message.text,
              nativeCommands:
                commands.tool && config.localCommands !== false ? nativeCommandPrompt : '',
            };
            // Replace only template placeholders, never placeholders inside user/tool content.
            const prompt = promptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
              const value = contextValues[key];
              if (value === undefined) throw new HostError('PROMPT_TEMPLATE_INVALID');
              return value;
            });
            const stream = await thread.runStreamed(prompt, {
              outputSchema: reportOutputSchema,
              signal: combined,
            });
            for await (const event of stream.events) {
              combined.throwIfAborted();
              if (event.type === 'thread.started') {
                handle.threadId = event.thread_id;
                yield { type: 'progress', message: '会话已建立。' };
              }
              if (event.type === 'turn.failed' || event.type === 'error')
                throw new HostError('CODEX_TURN_FAILED');
              if (event.type === 'turn.completed' && auth.kind === 'chatgpt') {
                const usage = event.usage;
                if (
                  completed ||
                  !Number.isSafeInteger(usage?.input_tokens) ||
                  !Number.isSafeInteger(usage?.output_tokens) ||
                  usage.input_tokens < handle.usage!.input_tokens ||
                  usage.output_tokens < handle.usage!.output_tokens
                ) {
                  usageFailure = new HostError('MODEL_USAGE_INVALID');
                  completed = true;
                  continue;
                }
                completed = true;
                handle.usage = {
                  input_tokens: usage.input_tokens,
                  output_tokens: usage.output_tokens,
                };
                nativeUsed =
                  usage.input_tokens -
                  baseline.input_tokens +
                  usage.output_tokens -
                  baseline.output_tokens;
                nativeComplete = baselineKnown;
                delete handle.usageUncertain;
                if (maximum !== undefined && nativeUsed > maximum)
                  usageFailure = new HostError('MODEL_TOKEN_BUDGET_EXHAUSTED');
              }
              if (event.type === 'item.completed' && event.item.type === 'command_execution')
                await commands.observe(event.item, combined);
              // Like SDK Thread.run(), the final response is the last agent message.
              // Earlier messages may be plain-text commentary before tool calls.
              if (event.type === 'item.completed' && event.item.type === 'agent_message')
                finalResponse = event.item.text;
            }
            if (
              auth.kind === 'chatgpt' &&
              (!completed || usageFailure?.code === 'MODEL_USAGE_INVALID')
            ) {
              nativeComplete = false;
              handle.usageUncertain = true;
              if (maximum !== undefined) throw usageFailure ?? new HostError('MODEL_USAGE_UNKNOWN');
            }
            yield usageEvent();
            usageEmitted = true;
            if (maximum !== undefined && usageFailure) throw usageFailure;
            let value: unknown;
            try {
              value = JSON.parse(finalResponse);
            } catch {
              throw new ContractError('report');
            }
            yield { type: 'report', report: validators.report.parse(value) };
          } catch (error) {
            const failure = boundedProxy?.usage.exhausted
              ? new HostError('MODEL_TOKEN_BUDGET_EXHAUSTED')
              : error instanceof HostError || error instanceof ContractError
                ? error
                : new HostError('CODEX_RUNTIME_FAILED');
            if (auth.kind === 'chatgpt' && maximum !== undefined && (!completed || usageFailure))
              nativeFailure =
                usageFailure ??
                (failure instanceof HostError ? failure : new HostError('MODEL_USAGE_UNKNOWN'));
            if (!usageEmitted) yield usageEvent();
            throw failure;
          } finally {
            // A completed SDK generator removes child error listeners; never abort it later.
            turnParent.removeEventListener('abort', onAbort);
            try {
              if (auth.kind === 'chatgpt') await auth.registerCurrent();
            } finally {
              running = false;
              finishRun?.();
            }
          }
        },
        close(): Promise<void> {
          if (closing) return closing;
          closed = true;
          abort.abort();
          closing = (async () => {
            await Promise.all([bridge.close(), boundedProxy?.close()]);
            await withDeadline(runFinished, 4000);
            const deadline = Date.now() + 2500;
            for (const file of pidFiles)
              while (true) {
                try {
                  await stat(file);
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
                  throw error;
                }
                if (Date.now() >= deadline) throw new HostError('CODEX_TERMINATION_UNKNOWN');
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            live.delete(adapter);
          })();
          return closing;
        },
      };
      live.add(adapter);
      return adapter;
    }
    return {
      scope: {
        model: config.model,
        baseUrl: auth.kind === 'chatgpt' ? 'https://chatgpt.com/backend-api' : baseUrl,
        authentication: auth.kind,
        ...(auth.kind === 'chatgpt' ? { account: auth.identity } : {}),
        reasoningEffort: config.reasoningEffort ?? 'medium',
        nativeShell: config.localCommands !== false,
        tokenCounting:
          auth.kind === 'chatgpt' ? 'codex-thread-usage-delta' : 'responses/input_tokens',
        skillDiscovery: 'target-home-v1',
        filesystem: unrestricted
          ? { policy: 'danger-full-access' }
          : { policy: 'target-directories-v2', ...access },
      },
      engine: {
        supportsNativeTools: config.localCommands !== false,
        supportsSkills: true,
        createSession: (options, signal) => session(options, signal),
        resumeSession: (handle, options, signal) => session(options, signal, handle),
      },
      async pruneInvestigations(investigations) {
        const handles = investigations.flatMap((item) =>
          item.sessionHandles.map((value) => handleValidator.parse(value)),
        );
        if (!handles.length) return;
        for (const handle of handles) {
          if (handle.instanceId !== context.instanceId)
            throw new HostError('SESSION_SCOPE_MISMATCH');
          if (
            [...live].some(
              (s) => handleValidator.parse(s.handle).directoryId === handle.directoryId,
            )
          )
            throw new HostError('SESSION_NOT_AVAILABLE');
        }
        if (auth.kind === 'chatgpt') {
          const home = await auth.home();
          const threads = await savedThreads(
            home,
            new Set(handles.flatMap((h) => (h.threadId ? [h.threadId] : []))),
          );
          for (const id of threads) {
            // The CLI owns its transcript/index format and deletes descendant threads as well.
            await execute(launcher, ['delete', '--force', id], {
              env: { PATH: process.env.PATH ?? '/usr/bin:/bin', CODEX_HOME: home },
              timeout: 30000,
              maxBuffer: 1024 * 1024,
            });
          }
        }
        for (const id of new Set(handles.map((h) => h.directoryId)))
          await rm(path.join(root, id), { recursive: true, force: true });
      },
      async dispose() {
        try {
          await Promise.all([...live].map((s) => s.close()));
        } finally {
          if (auth.kind === 'chatgpt') auth.release();
        }
      },
    };
  },
});
