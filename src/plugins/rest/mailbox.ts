import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { compileContract, objectSchema, schemas } from '../../plugin-api/index.js';
import type { OutboundMessage } from '../../plugin-api/index.js';
import { HostError } from '../../core/errors.js';
import { fingerprint } from '../../core/identity.js';
import { SerialQueue } from '../../core/serial.js';

const maximumMessages = 10000;
const maximumBytes = 131072;
interface Entry {
  readonly cursor: number;
  readonly message: OutboundMessage;
}
const entryValidator = compileContract<Entry>(
  objectSchema({
    cursor: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    message: schemas.outboundMessage,
  }),
  'REST mailbox entry',
);
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
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await lstat(directory)).isDirectory()) throw new HostError('REST_MAILBOX_INVALID');
  }
}

/** Transport history, separate from the host's authoritative investigation/outbox records. */
export class RestMailbox {
  readonly #serial = new SerialQueue();
  readonly #entries = new Map<
    string,
    { cursor: number; digest: string; investigationId?: string }
  >();
  #next = 1;
  #dirty = false;
  private constructor(readonly directory: string) {}

  static async open(directory: string, check: (message: OutboundMessage) => void) {
    await ensureDirectory(directory);
    const mailbox = new RestMailbox(directory);
    const cursors = new Set<number>();
    for (const name of await readdir(directory)) {
      if (/^\.tmp-[a-f0-9-]+$/.test(name)) {
        await rm(path.join(directory, name));
        continue;
      }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new HostError('REST_MAILBOX_INVALID');
      const entry = await mailbox.read(name.slice(0, -5));
      check(entry.message);
      if (cursors.has(entry.cursor)) throw new HostError('REST_MAILBOX_INVALID');
      cursors.add(entry.cursor);
      mailbox.#entries.set(name.slice(0, -5), {
        cursor: entry.cursor,
        digest: fingerprint(entry.message),
        ...(entry.message.reference
          ? { investigationId: entry.message.reference.investigationId }
          : {}),
      });
      mailbox.#next = Math.max(mailbox.#next, entry.cursor + 1);
      if (mailbox.#entries.size > maximumMessages) throw new HostError('REST_MAILBOX_FULL');
    }
    await sync(directory);
    return mailbox;
  }

  private async read(id: string): Promise<Entry> {
    const file = path.join(this.directory, id + '.json');
    const info = await lstat(file);
    if (!info.isFile() || info.size > maximumBytes) throw new HostError('REST_MAILBOX_INVALID');
    try {
      const entry = entryValidator.parse(JSON.parse(await readFile(file, 'utf8')));
      if (fingerprint(entry.message.idempotencyKey) !== id) throw new Error();
      return entry;
    } catch {
      throw new HostError('REST_MAILBOX_INVALID');
    }
  }

  append(message: OutboundMessage): Promise<string> {
    return this.#serial.run(async () => {
      await this.flush();
      const id = fingerprint(message.idempotencyKey);
      const existing = this.#entries.get(id);
      if (existing) {
        if (existing.digest !== fingerprint(message))
          throw new HostError('REST_IDEMPOTENCY_CONFLICT');
        // A previous directory sync might have failed after publication; retries must recheck it.
        await sync(this.directory);
        return id;
      }
      if (this.#entries.size >= maximumMessages) throw new HostError('REST_MAILBOX_FULL');
      const entry: Entry = { cursor: this.#next, message };
      const bytes = JSON.stringify(entry);
      if (Buffer.byteLength(bytes) > maximumBytes) throw new HostError('REST_REPLY_TOO_LARGE');
      const file = path.join(this.directory, id + '.json');
      const temporary = path.join(this.directory, '.tmp-' + randomUUID());
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
        this.#entries.set(id, {
          cursor: entry.cursor,
          digest: fingerprint(message),
          ...(message.reference ? { investigationId: message.reference.investigationId } : {}),
        });
        this.#next++;
        this.#dirty = true;
        // A failed sync must be retried before another append or a page can expose its cursor.
        await this.flush();
        return id;
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async page(investigationId: string, after: number, limit: number) {
    return this.#serial.run(async () => {
      await this.flush();
      const selected = [...this.#entries]
        .filter(([, entry]) => entry.investigationId === investigationId && entry.cursor > after)
        .sort((a, b) => a[1].cursor - b[1].cursor)
        .slice(0, limit);
      const messages = await Promise.all(
        selected.map(async ([messageId]) => {
          const { cursor, message } = await this.read(messageId);
          return {
            messageId,
            cursor,
            text: message.text,
            ...(message.reference ? { reference: message.reference } : {}),
          };
        }),
      );
      return { messages, nextCursor: messages.at(-1)?.cursor ?? after };
    });
  }

  prune(investigationIds: ReadonlySet<string>): Promise<void> {
    return this.#serial.run(async () => {
      await this.flush();
      for (const [id, entry] of this.#entries) {
        if (!entry.investigationId || !investigationIds.has(entry.investigationId)) continue;
        await rm(path.join(this.directory, id + '.json'), { force: true });
        this.#entries.delete(id);
      }
      await sync(this.directory);
    });
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }
  private async flush(): Promise<void> {
    if (!this.#dirty) return;
    await sync(this.directory);
    this.#dirty = false;
  }
  idle(): Promise<void> {
    return this.#serial.idle();
  }
}
