    }
    async function prepareModel() {
      try {
        const landmarker = await createStableLandmarker("IMAGE", event => {
          if (disposed) return;
          modelProgressAtRef.current = Date.now();
          lastProgressAtRef.current = Date.now();
          const stage = event.stage.includes("download") ? "解析エンジンを受信中" : "解析エンジンを準備中";
          if (window.__MANY_FACES_RUNTIME__?.phase === "waiting") setProgress({ done: 0, total: 0, label: `${stage} ${(event.bytes / 1048576).toFixed(1)} MB` });
        }, preparationAbort.signal);
        if (disposed) { landmarker.close(); return; }
        landmarkerRef.current = landmarker; modelStateRef.current = "ready"; setModelState("ready");
      } catch (caught) { console.error("Review model setup failed.", caught); if (!disposed) { modelStateRef.current = "failed"; setModelState("failed"); } }
    }
    void prepareManifest(); void prepareModel();
    return () => { disposed = true; preparationAbort.abort(); clearReview(); landmarkerRef.current?.close(); landmarkerRef.current = null; };
  }, [clearReview]);

  const waitUntilPrepared = useCallback(async (token: number) => {
    const startedAt = Date.now();
    while (processingTokenRef.current === token && (!manifestRef.current || !landmarkerRef.current)) {
      const reason = preparationFailureReason(modelStateRef.current, manifestStateRef.current, Date.now() - Math.max(startedAt, modelProgressAtRef.current));
      if (reason) throw new Error(reason);
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
    if (processingTokenRef.current !== token) throw cancelled();
  }, []);
  const drawReviewAt = useCallback((time: number) => {
    const canvas = outputCanvasRef.current;
    if (!canvas) return;
    const item = reviewItemAtTime(sequenceRef.current, quantizeReviewTime(time, replayFpsRef.current, clipDuration));
    if (!item) return;
    const image = outputImagesRef.current.get(item.choice.candidate.id);
    if (image) drawFacePresentation(canvas, image, item.choice, { sourceAspectRatio, trackFace: faceTracking, faceOnly, background: "#0a0c10" });
    if (lastOutputIdRef.current !== item.choice.candidate.id) {
      lastOutputIdRef.current = item.choice.candidate.id; setCurrentOutputName(item.choice.candidate.name);
      setCurrentOutputSource(item.choice.candidate.sourceName || item.choice.candidate.creator || "—"); setCurrentError(item.choice.error);
    }
  }, [clipDuration, faceOnly, faceTracking, sourceAspectRatio]);
  useEffect(() => {\n    if (phase === "review") drawReviewAt(playbackTime);\n  }, [drawReviewAt, phase, playbackTime]);\n\n  const startPlaybackLoop = useCallback(() => {
    if (playbackRafRef.current !== null) cancelAnimationFrame(playbackRafRef.current);
    const tick = () => {
      const video = playbackVideoRef.current;
      if (!video || video.paused || video.ended) { playbackRafRef.current = null; setPlaying(false); return; }
      if (video.currentTime >= clipDuration) { video.currentTime = 0; drawReviewAt(0); setPlaybackTime(0); }
      else { drawReviewAt(video.currentTime); setPlaybackTime(video.currentTime); }
      playbackRafRef.current = requestAnimationFrame(tick);
    };
    playbackRafRef.current = requestAnimationFrame(tick);
  }, [clipDuration, drawReviewAt]);

  const processRecording = useCallback(async (videoUrl: string, duration: number, inputName: string) => {
    const token = ++processingTokenRef.current;
    captureAbortRef.current?.abort();
    const cancellation = new AbortController(); captureAbortRef.current = cancellation;
    const checkCurrent = () => { if (processingTokenRef.current !== token || cancellation.signal.aborted) throw cancelled(); };
    const started = performance.now(), phaseTimings = emptyReviewPhaseTimings();
    const frameEvidence = { presentationCallbacks: 0, decodedPausedReadbacks: 0 };
    let phaseStarted = started;
    lastProgressAtRef.current = Date.now(); searchTrafficRef.current = { bytes: 0, files: 0, decoded: 0 };
    setError(null); setProgress(null); setFaceFrames(0); setLoadedShards(0); setPeakCandidates(0);