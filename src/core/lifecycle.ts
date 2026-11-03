import { HostError } from './errors.js';

/** Bounds waiting, not execution: callers must still cancel/clean late acquisitions. */
export async function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HostError('LIFECYCLE_TIMEOUT')), milliseconds);
    if (signal) {
      abort = () => reject(new HostError('LIFECYCLE_CANCELLED'));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    if (signal && abort) signal.removeEventListener('abort', abort);
  }
}
