export class Semaphore {
  #active = 0;
  readonly #waiting: Array<{
    resolve(value: () => void): void;
    reject(reason: unknown): void;
    signal: AbortSignal;
    abort(): void;
  }> = [];
  constructor(private readonly maximum: number) {}
  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.#waiting.indexOf(entry);
          if (index >= 0) this.#waiting.splice(index, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.#waiting.push(entry);
      this.dispatch();
    });
  }
  private dispatch(): void {
    while (this.#active < this.maximum && this.#waiting.length) {
      const entry = this.#waiting.shift()!;
      entry.signal.removeEventListener('abort', entry.abort);
      if (entry.signal.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      this.#active++;
      let released = false;
      entry.resolve(() => {
        if (!released) {
          released = true;
          this.#active--;
          this.dispatch();
        }
      });
    }
  }
}
