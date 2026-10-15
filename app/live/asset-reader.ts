export type AssetReadOptions = {
  signal?: AbortSignal;
  idleMs?: number;
  maxMs?: number;
  maxBytes?: number;
  onBytes?: (received: number, delta: number) => void;
};

/** Deadline covers headers AND the body; only newly received bytes reset idle.
 * A slow but advancing response is not a hung task. A header-only response is.
 */
export async function readAssetBytes(url: string, options: AssetReadOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const controller = new AbortController();
  const path = new URL(url, globalThis.location?.href ?? "http://localhost").pathname;
  const fail = (code: string) => new Error(`${code}: ${path}`);
  const cancel = () => controller.abort(options.signal?.reason ?? new DOMException("Cancelled", "AbortError"));
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  let idle: ReturnType<typeof setTimeout>;
  const rearm = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(fail("ASSET_IDLE_TIMEOUT")), options.idleMs ?? 20000); };
  rearm();
  const maximum = setTimeout(() => controller.abort(fail("ASSET_TOTAL_TIMEOUT")), options.maxMs ?? 600000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => { rejectAbort(controller.signal.reason); void reader?.cancel(controller.signal.reason).catch(() => undefined); };
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    const response = await Promise.race([fetch(url, { signal: controller.signal, cache: "force-cache" }), abortPromise]);
    if (!response.ok) throw fail(`ASSET_HTTP_${response.status}`);
    if (!response.body) throw fail("ASSET_EMPTY_BODY");
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maxBytes) throw fail("ASSET_TOO_LARGE");
    reader = response.body.getReader();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (done) break;
      if (!value.byteLength) continue;
      received += value.byteLength;
      if (received > maxBytes) throw fail("ASSET_TOO_LARGE");
      chunks.push(value); rearm(); options.onBytes?.(received, value.byteLength);
    }
    if (!received) throw fail("ASSET_EMPTY_BODY");
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    complete = true;
    return bytes;
  } finally {
    clearTimeout(idle!); clearTimeout(maximum);
    options.signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
    if (!complete) { controller.abort(); void reader?.cancel().catch(() => undefined); }
    reader?.releaseLock();
  }
}

export async function readAssetJson<T>(url: string, options: AssetReadOptions = {}): Promise<T> {
  const bytes = await readAssetBytes(url, options);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; }
  catch { throw new Error(`ASSET_INVALID_JSON: ${new URL(url, globalThis.location?.href ?? "http://localhost").pathname}`); }
}

export class ProgressDeadline {
  private sequence = -1;
  private last: number;
  private readonly started: number;
  constructor(now: number) { this.last = now; this.started = now; }
  observe(sequence: number, now: number) {
    if (!Number.isSafeInteger(sequence) || sequence <= this.sequence || !Number.isFinite(now)) return false;
    this.sequence = sequence; this.last = now; return true;
  }
  expired(now: number, idleMs: number, maxMs = Infinity) {
    return now - this.last >= idleMs || now - this.started >= maxMs;
  }
}
