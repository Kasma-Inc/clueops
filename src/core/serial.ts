/** Serializes short authoritative changes; remote work must never hold this queue. */
export class SerialQueue {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => {});
    return result;
  }
  async idle(): Promise<void> {
    await this.#tail;
  }
}
