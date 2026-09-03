#!/usr/bin/env python3
"""Patch the five-second review so failure cannot masquerade as activity.

The old wait loop captured stale React state. If the model or manifest failed
after processing began, the callback could remain in `waiting` forever. This
patch uses mutable readiness refs, a hard preparation deadline, and a progress
heartbeat watchdog. It also switches MediaPipe runtime files to same-origin
assets so CSP, CDN, or transient network failures do not disable the page.
"""

from __future__ import annotations

from pathlib import Path

PATH = Path("app/live/review-client-lite.tsx")
text = PATH.read_text(encoding="utf-8")

if 'from "./runtime-liveness";' not in text:
    marker = 'import { evaluateVerificationGate } from "./verification-gate";\n'
    replacement = marker + '''import {
  OPERATION_STALL_TIMEOUT_MS,
  operationIsStalled,
  preparationFailureReason,
  progressSignature,
} from "./runtime-liveness";
'''
    if marker not in text:
        raise SystemExit("verification-gate import marker not found")
    text = text.replace(marker, replacement, 1)

old_urls = '''const WASM_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";'''
new_urls = '''const WASM_URL = "/mediapipe";
const MODEL_URL = "/mediapipe/face_landmarker.task";'''
if old_urls in text:
    text = text.replace(old_urls, new_urls, 1)
elif new_urls not in text:
    raise SystemExit("MediaPipe URL marker not found")

window_old = '''  interface Window {
    __MANY_FACES_VERIFY__?: VerificationReport;
  }
}'''
window_new = '''  interface Window {
    __MANY_FACES_VERIFY__?: VerificationReport;
    __MANY_FACES_RUNTIME__?: {
      phase: Phase;
      label: string;
      updatedAt: number;
      stalled: boolean;
    };
  }
}'''
if window_old in text:
    text = text.replace(window_old, window_new, 1)
elif "__MANY_FACES_RUNTIME__" not in text:
    raise SystemExit("Window verification marker not found")

fetch_marker = '''function loadCandidateImage(candidate: Candidate) {
'''
fetch_helper = '''async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 20_000,
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function loadCandidateImage(candidate: Candidate) {
'''
if "async function fetchWithTimeout(" not in text:
    if fetch_marker not in text:
        raise SystemExit("loadCandidateImage marker not found")
    text = text.replace(fetch_marker, fetch_helper, 1)

refs_old = '''  const replayFpsRef = useRef(12);
  const lastOutputIdRef = useRef<string | null>(null);
'''
refs_new = '''  const replayFpsRef = useRef(12);
  const lastOutputIdRef = useRef<string | null>(null);
  const modelStateRef = useRef<Readiness>("loading");
  const manifestStateRef = useRef<Readiness>("loading");
  const lastProgressSignatureRef = useRef("");
  const lastProgressAtRef = useRef(0);
'''
if refs_old in text:
    text = text.replace(refs_old, refs_new, 1)
elif "modelStateRef = useRef" not in text:
    raise SystemExit("runtime ref marker not found")

state_old = '''  const [currentError, setCurrentError] = useState<ProjectionError | null>(null);
  const [error, setError] = useState<string | null>(null);
'''
state_new = '''  const [currentError, setCurrentError] = useState<ProjectionError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsSinceProgress, setSecondsSinceProgress] = useState(0);
'''
if state_old in text:
    text = text.replace(state_old, state_new, 1)
elif "secondsSinceProgress" not in text:
    raise SystemExit("error-state marker not found")

report_effect = '''  useEffect(() => {
    window.__MANY_FACES_VERIFY__ = report ?? undefined;
  }, [report]);

  const busy = !["idle", "review", "error"].includes(phase);
'''
heartbeat_effect = '''  useEffect(() => {
    window.__MANY_FACES_VERIFY__ = report ?? undefined;
  }, [report]);

  useEffect(() => {
    const signature = progressSignature(phase, progress);
    if (signature !== lastProgressSignatureRef.current) {
      lastProgressSignatureRef.current = signature;
      lastProgressAtRef.current = Date.now();
    }
    window.__MANY_FACES_RUNTIME__ = {
      phase,
      label: progress?.label ?? phaseText(phase),
      updatedAt: lastProgressAtRef.current,
      stalled: false,
    };
  }, [phase, progress]);

  const busy = !["idle", "review", "error"].includes(phase);
'''
if report_effect in text:
    text = text.replace(report_effect, heartbeat_effect, 1)
elif "lastProgressSignatureRef.current" not in text:
    raise SystemExit("verification-report effect marker not found")

memo_marker = '''  const readinessLabel = useMemo(() => {
    if (modelState === "failed" || manifestState === "failed") return "準備エラー";
    if (modelState === "ready" && manifestState === "ready") return "解析準備OK";
    return "バックグラウンド準備中";
  }, [manifestState, modelState]);
'''
watchdog = memo_marker + '''
  useEffect(() => {
    if (!busy) return;
    const tick = () => {
      const now = Date.now();
      const elapsed = Math.max(0, now - lastProgressAtRef.current);
      setSecondsSinceProgress(Math.floor(elapsed / 1_000));
      if (!operationIsStalled(true, now, lastProgressAtRef.current)) return;
      processingTokenRef.current += 1;
      const message = `「${phaseText(phase)}」で${Math.ceil(
        OPERATION_STALL_TIMEOUT_MS / 1_000,
      )}秒以上進捗がありません。処理を停止しました。`;
      setError(message);
      setProgress(null);
      setPhase("error");
      window.__MANY_FACES_RUNTIME__ = {
        phase: "error",
        label: message,
        updatedAt: now,
        stalled: true,
      };
    };
    const firstTick = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1_000);
    return () => {
      window.clearTimeout(firstTick);
      window.clearInterval(timer);
    };
  }, [busy, phase]);
'''
if "operationIsStalled(true" not in text:
    if memo_marker not in text:
        raise SystemExit("readiness memo marker not found")
    text = text.replace(memo_marker, watchdog, 1)

setup_old = '''  useEffect(() => {
    let disposed = false;

    async function prepareManifest() {
'''
setup_new = '''  useEffect(() => {
    let disposed = false;
    modelStateRef.current = "loading";
    manifestStateRef.current = "loading";

    async function prepareManifest() {
'''
if setup_old in text:
    text = text.replace(setup_old, setup_new, 1)

text = text.replace(
    '''        const response = await fetch("/api/catalog/manifest?source=seed", {
          cache: "no-store",
        });''',
    '''        const response = await fetchWithTimeout(
          "/api/catalog/manifest?source=seed",
          { cache: "no-store" },
          15_000,
        );''',
    1,
)

manifest_success = '''        manifestRef.current = manifest;
        setCatalogTotal(
'''
manifest_success_new = '''        manifestRef.current = manifest;
        manifestStateRef.current = "ready";
        setCatalogTotal(
'''
if manifest_success in text and "manifestStateRef.current = \"ready\"" not in text:
    text = text.replace(manifest_success, manifest_success_new, 1)
text = text.replace(
    '''        if (!disposed) setManifestState("failed");''',
    '''        manifestStateRef.current = "failed";
        if (!disposed) setManifestState("failed");''',
    1,
)

model_success = '''        landmarkerRef.current = landmarker;
        setModelState("ready");
'''
model_success_new = '''        landmarkerRef.current = landmarker;
        modelStateRef.current = "ready";
        setModelState("ready");
'''
if model_success in text:
    text = text.replace(model_success, model_success_new, 1)
text = text.replace(
    '''        if (!disposed) setModelState("failed");''',
    '''        modelStateRef.current = "failed";
        if (!disposed) setModelState("failed");''',
    1,
)

wait_start = text.find("  const waitUntilPrepared = useCallback(async (token: number) => {")
wait_end = text.find("\n\n  const loadShard = useCallback", wait_start)
if wait_start < 0 or wait_end < 0:
    raise SystemExit("waitUntilPrepared section marker not found")
wait_replacement = '''  const waitUntilPrepared = useCallback(async (token: number) => {
    const startedAt = Date.now();
    while (
      processingTokenRef.current === token &&
      (!manifestRef.current || !landmarkerRef.current)
    ) {
      const reason = preparationFailureReason(
        modelStateRef.current,
        manifestStateRef.current,
        Date.now() - startedAt,
      );
      if (reason) throw new Error(reason);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
    }
    if (processingTokenRef.current !== token) {
      throw new DOMException("Cancelled", "AbortError");
    }
  }, []);'''
text = text[:wait_start] + wait_replacement + text[wait_end:]

text = text.replace(
    '''      const response = await fetch(
        `/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`,
        { cache: "force-cache" },
      );''',
    '''      const response = await fetchWithTimeout(
        `/api/catalog/shard?source=seed&file=${encodeURIComponent(file)}&catalog=${encodeURIComponent(catalog)}`,
        { cache: "force-cache" },
        20_000,
      );''',
    1,
)

metrics_marker = '''          <div><span>STRICT ERROR</span><strong>{currentError?.strictTotal.toFixed(4) ?? "—"}</strong></div>
'''
metrics_new = metrics_marker + '''          <div><span>HEARTBEAT</span><strong>{busy ? `${secondsSinceProgress}s ago` : "idle"}</strong></div>
'''
if metrics_marker in text and "HEARTBEAT" not in text:
    text = text.replace(metrics_marker, metrics_new, 1)

PATH.write_text(text, encoding="utf-8")
print("Applied live runtime reliability patch.")
