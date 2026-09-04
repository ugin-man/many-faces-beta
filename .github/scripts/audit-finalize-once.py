"""One-time audit migration; removed from the branch after applying."""
from pathlib import Path
import json,subprocess,shutil

def edit(file,old,new,count=1):
    p=Path(file);s=p.read_text()
    if s.count(old)!=count: raise RuntimeError(f'{file}: wanted {count} occurrences of {old[:80]}, got {s.count(old)}')
    p.write_text(s.replace(old,new))

review='app/live/review-client-lite.tsx'
edit(review,'import { captureCameraClip } from "./camera-capture";', 'import { captureCameraClip } from "./camera-capture";\nimport { CandidateAttribution, type Attribution } from "./candidate-attribution";')
edit(review,'type CatalogEntry = {','type CatalogEntry = Attribution & {')
edit(review,'type Candidate = {','type Candidate = Attribution & {')
edit(review,'    creator: entry.creator,','    creator: entry.creator,\n    sourceUrl: entry.sourceUrl,\n    license: entry.license,\n    licenseUrl: entry.licenseUrl,')
edit(review,'  const inputLockRef = useRef(false);','  const inputLockRef = useRef(false);\n  const seekControllerRef = useRef<AbortController | null>(null);')
edit(review,'  const [currentOutputName, setCurrentOutputName] = useState("—");','  const [currentCandidate, setCurrentCandidate] = useState<Candidate | null>(null);\n  const [currentOutputName, setCurrentOutputName] = useState("—");')
edit(review,'  const stopPlayback = useCallback(() => {','  const stopPlayback = useCallback(() => {\n    seekControllerRef.current?.abort(new DOMException("Playback changed", "AbortError"));\n    seekControllerRef.current = null;')
edit(review,'    lastOutputIdRef.current = null;\n    setReport(null);','    lastOutputIdRef.current = null;\n    setCurrentCandidate(null);\n    setReport(null);')
edit(review,'      setCurrentOutputName(item.choice.candidate.name);','      setCurrentCandidate(item.choice.candidate);\n      setCurrentOutputName(item.choice.candidate.name);')
edit(review,'    if (video.paused || video.ended) {','    seekControllerRef.current?.abort(new DOMException("Playback started", "AbortError"));\n    if (video.paused || video.ended) {')
edit(review,'''    const target = clamp(time, 0, clipDuration);
    video.currentTime = target;
    setPlaybackTime(target);
    drawReviewAt(target);''','''    const target = clamp(time, 0, clipDuration);
    const token = processingTokenRef.current;
    const controller = new AbortController();
    seekControllerRef.current = controller;
    setPlaybackTime(target);
    void seekDecodedVideoFrame(video, target, controller.signal).then(() => {
      if (!controller.signal.aborted && token === processingTokenRef.current) drawReviewAt(target);
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted && token === processingTokenRef.current) setError(caught instanceof Error ? caught.message : "再生位置を変更できませんでした");
    });''')
edit(review,'              <b>{currentOutputSource}</b>\n            </div>','              <b>{currentOutputSource}</b>\n            </div>\n            <CandidateAttribution candidate={currentCandidate} />')
edit(review,'              value={analysisFps}','              aria-label="解析密度"\n              value={analysisFps}')
edit(review,'                  value={replayFps}','                  aria-label="再生"\n                  value={replayFps}')

# Preserve the broken historical workflow outside the active Actions directory.
old=Path('.github/workflows/patch-live-static-search.yml')
archive=Path('docs/archived-workflows/patch-live-static-search.yml.disabled');archive.parent.mkdir(parents=True,exist_ok=True)
shutil.move(old,archive)

# Resolve registry metadata instead of guessing incompatible tooling versions.
def npm_view(spec,field):
    return json.loads(subprocess.check_output(['npm','view',spec,field,'--json'],text=True,timeout=45))
plugin='1.54.4'
wrangler_spec=npm_view('@cloudflare/vite-plugin@'+plugin,'dependencies')['wrangler']
versions=npm_view('wrangler@'+wrangler_spec,'version');wrangler=versions[-1] if isinstance(versions,list) else versions
peers=npm_view('wrangler@'+wrangler,'peerDependencies') or {}
types_range=peers.get('@cloudflare/workers-types','^4.20260515.1')
versions=npm_view('@cloudflare/workers-types@'+types_range,'version');types=versions[-1] if isinstance(versions,list) else versions
p=Path('package.json');package=json.loads(p.read_text())
package['dependencies']['next']='16.3.4'
package['devDependencies'].update({'eslint-config-next':'16.3.4','@cloudflare/vite-plugin':plugin,'wrangler':wrangler,'@cloudflare/workers-types':types})
p.write_text(json.dumps(package,indent=2)+'\n')
print('PINNED_RUNTIME',json.dumps({'next':'16.3.4','cloudflarePlugin':plugin,'wrangler':wrangler,'workersTypes':types}),flush=True)
subprocess.run(['npm','install','--package-lock-only','--ignore-scripts'],check=True,timeout=180)
# Keep direct version pins and never use --force or accept breaking downgrades.
fixed=subprocess.run(['npm','audit','fix','--package-lock-only','--ignore-scripts'],timeout=180)
if fixed.returncode not in (0,1): raise SystemExit(fixed.returncode)
print('FINALIZE_SOURCE_APPLIED',flush=True)
