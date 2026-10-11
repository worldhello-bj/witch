/** Bounded JSON transport shared by model and search requests. */
export class RequestTimeoutError extends Error {
  constructor(label: string) { super(`${label} timed out`); this.name = "TimeoutError"; }
}

export async function runWithDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error(`${label} requires a positive, bounded timeout`);
  signal?.throwIfAborted();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal!.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new RequestTimeoutError(label)), timeoutMs);
  let rejectOnAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    // The race also bounds custom providers that accidentally ignore AbortSignal.
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    }), cancelled]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forwardAbort);
    if (rejectOnAbort) controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}

export async function requestJsonObject<T extends object>(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal; label: string; maxBytes?: number },
): Promise<{ response: Response; data: T }> {
  return runWithDeadline(options.timeoutMs, options.signal, options.label, async (signal) => {
    const response = await fetch(url, { ...init, redirect: init.redirect ?? "error", signal });
    const maxBytes = options.maxBytes ?? 2_000_000;
    const length = response.headers.get("content-length");
    if (length && Number(length) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${options.label} response exceeds ${maxBytes} bytes`);
    }
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    let size = 0;
    if (reader) {
      const cancelRead = () => { void reader.cancel(signal.reason).catch(() => undefined); };
      signal.addEventListener("abort", cancelRead, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new Error(`${options.label} response exceeds ${maxBytes} bytes`);
          }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        signal.removeEventListener("abort", cancelRead);
        reader.releaseLock();
      }
    }
    signal.throwIfAborted();
    let data: unknown;
    try { data = JSON.parse(raw); }
    catch { throw new Error(`${options.label} returned invalid JSON (HTTP ${response.status})`); }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error(`${options.label} returned an invalid JSON object (HTTP ${response.status})`);
    return { response, data: data as T };
  });
}
