export class BodyLimitError extends Error {
  constructor() { super("Response body exceeds the allowed size"); this.name = "BodyLimitError"; }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Cancelled", "AbortError");
}

/** The deadline includes body consumption, not only the response headers. */
export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  milliseconds = 20_000,
): Promise<T> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("処理が時間内に完了しませんでした", "TimeoutError")), milliseconds);
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort?.(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

/** Reads at most maxBytes; chunked bodies cannot bypass the memory limit. */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid body limit");
  throwIfAborted(signal);
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel("Body size limit").catch(() => undefined);
        throw new BodyLimitError();
      }
      chunks.push(value);
    }
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output.buffer;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function fetchJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  milliseconds = 20_000,
  maxBytes = 16 * 1024 * 1024,
): Promise<T> {
  return withDeadline(async (signal) => {
    const response = await fetch(input, { ...init, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (declared > maxBytes) { void response.body?.cancel(); throw new BodyLimitError(); }
    const bytes = await readBoundedBody(response.body, maxBytes, signal);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }, init.signal ?? undefined, milliseconds);
}

export function pauseTask(milliseconds = 0, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException("Cancelled", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
