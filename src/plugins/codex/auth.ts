import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';
import { object } from '../shared.js';
import { canonicalPath } from '../private-paths.js';

const maximumBytes = 1024 * 1024;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
interface NativeFile {
  readonly bytes: Buffer;
  readonly identity: string;
  readonly secrets: readonly string[];
}
type AuthFile =
  { readonly kind: 'apiKey'; readonly key: string } | ({ readonly kind: 'chatgpt' } & NativeFile);
const stores = new Map<string, NativeCredentialStore>();

export function authFilePath(file: string, context: PluginContext): string {
  return file === '~' || file.startsWith('~/')
    ? path.join(homedir(), file.slice(2))
    : context.resolvePath(file);
}

/** Read only the explicitly selected auth cache; never load the operator's Codex config. */
export async function readAuthFile(file: string): Promise<AuthFile> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maximumBytes) throw new Error();
    const bytes = await readFile(file);
    if (bytes.length > maximumBytes) throw new Error();
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(value)) throw new Error();
    const mode = value.auth_mode;
    if (mode !== undefined && !['apikey', 'chatgpt'].includes(String(mode))) throw new Error();
    if (
      (mode === 'apikey' || mode === undefined) &&
      typeof value.OPENAI_API_KEY === 'string' &&
      value.OPENAI_API_KEY.trim()
    ) {
      if (mode === undefined && object(value.tokens)) throw new Error();
      return { kind: 'apiKey', key: value.OPENAI_API_KEY.trim() };
    }
    if (mode === 'apikey' || !object(value.tokens)) throw new Error();
    const tokens = value.tokens;
    const secrets = ['access_token', 'refresh_token', 'id_token'].map((key) => tokens[key]);
    if (!secrets.every((value): value is string => typeof value === 'string' && value.length > 0))
      throw new Error();
    const claims: unknown = JSON.parse(
      Buffer.from(String(tokens.id_token).split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    if (!object(claims)) throw new Error();
    const details = claims['https://api.openai.com/auth'];
    let account = tokens.account_id;
    if (typeof account !== 'string' || !account) {
      if (!object(details)) throw new Error();
      account = details.chatgpt_account_id;
    }
    const user =
      claims.sub ?? (object(details) ? (details.chatgpt_user_id ?? details.user_id) : undefined);
    if (typeof account !== 'string' || !account || typeof user !== 'string' || !user)
      throw new Error();
    return {
      kind: 'chatgpt',
      bytes,
      identity: hash(JSON.stringify([account, user])),
      secrets,
    };
  } catch {
    throw new HostError('CODEX_AUTH_FILE_INVALID', file);
  }
}

async function sync(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function ensureDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
    await sync(path.dirname(directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await ensureDirectory(path.dirname(directory));
      return ensureDirectory(directory);
    }
    if (
      (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !(await lstat(directory)).isDirectory()
    )
      throw new HostError('CODEX_AUTH_STATE_INVALID');
  }
}
async function writePrivate(file: string, bytes: string | Buffer): Promise<void> {
  const temporary = file + '.tmp-' + randomUUID();
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    await sync(path.dirname(file));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Same-source service sessions share Codex's own refresh coordination and persistence. */
class NativeCredentialStore {
  readonly contexts = new Map<PluginContext, number>();
  #ready: Promise<string> | undefined;
  #preparing = false;
  constructor(
    readonly directory: string,
    readonly source: NativeFile,
  ) {}
  home(): Promise<string> {
    if (!this.#ready) {
      this.#preparing = true;
      this.#ready = this.prepare().finally(() => {
        this.#preparing = false;
        this.removeIfUnused();
      });
    }
    return this.#ready;
  }
  detach(context: PluginContext): void {
    const count = this.contexts.get(context) ?? 0;
    if (count > 1) this.contexts.set(context, count - 1);
    else this.contexts.delete(context);
    this.removeIfUnused();
  }
  private removeIfUnused(): void {
    if (!this.contexts.size && !this.#preparing && stores.get(this.directory) === this)
      stores.delete(this.directory);
  }
  private async prepare(): Promise<string> {
    await ensureDirectory(this.directory);
    const marker = path.join(this.directory, 'import.json');
    const file = path.join(this.directory, 'auth.json');
    let previous: unknown;
    try {
      previous = JSON.parse(await readFile(marker, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new HostError('CODEX_AUTH_STATE_INVALID');
    }
    if (
      previous !== undefined &&
      (!object(previous) ||
        typeof previous.sourceDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(previous.sourceDigest))
    )
      throw new HostError('CODEX_AUTH_STATE_INVALID');
    if (!object(previous) || previous.sourceDigest !== hash(this.source.bytes)) {
      await writePrivate(file, this.source.bytes);
      await writePrivate(marker, JSON.stringify({ sourceDigest: hash(this.source.bytes) }));
    }
    // Only this service owns these discovery paths; selected skills live in each session's HOME.
    await rm(path.join(this.directory, 'skills'), { recursive: true, force: true });
    await this.registerCurrent();
    return this.directory;
  }
  async registerCurrent(): Promise<void> {
    const current = await readAuthFile(path.join(this.directory, 'auth.json'));
    if (current.kind !== 'chatgpt' || current.identity !== this.source.identity)
      throw new HostError('CODEX_AUTH_ACCOUNT_CHANGED');
    for (const context of this.contexts.keys()) context.registerSecrets?.(current.secrets);
  }
}

export interface NativeAuthentication {
  readonly kind: 'chatgpt';
  readonly identity: string;
  home(): Promise<string>;
  registerCurrent(): Promise<void>;
  release(): void;
}

export async function authenticationFromFile(
  file: string,
  context: PluginContext,
): Promise<{ readonly kind: 'apiKey'; readonly key: string } | NativeAuthentication> {
  let source: string;
  try {
    source = await realpath(authFilePath(file, context));
  } catch {
    throw new HostError('CODEX_AUTH_FILE_INVALID', authFilePath(file, context));
  }
  const auth = await readAuthFile(source);
  if (auth.kind === 'apiKey') return auth;
  context.registerSecrets?.(auth.secrets);
  const parent = context.stateDirectory
    ? path.dirname(context.stateDirectory)
    : context.resolvePath('.clueops/plugins');
  const directory = path.join(await canonicalPath(parent), '.codex-auth', hash(source));
  let store = stores.get(directory);
  if (store && hash(store.source.bytes) !== hash(auth.bytes))
    throw new HostError('CODEX_AUTH_SOURCE_CHANGED');
  if (!store) {
    store = new NativeCredentialStore(directory, auth);
    stores.set(directory, store);
  }
  store.contexts.set(context, (store.contexts.get(context) ?? 0) + 1);
  let released = false;
  return {
    kind: 'chatgpt',
    identity: auth.identity,
    home() {
      if (released) throw new HostError('CODEX_AUTH_CLOSED');
      return store.home();
    },
    registerCurrent: () => store.registerCurrent(),
    release() {
      if (released) return;
      released = true;
      store.detach(context);
    },
  };
}
