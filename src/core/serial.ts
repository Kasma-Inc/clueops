/** Serializes short authoritative changes; remote work must never hold this queue. */
export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async idle(): Promise<void> {
    await this.#tail;
  }
}
