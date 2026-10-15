export type FrameSignals = {
  mediaTime?: number;
  presentedFrames?: number;
  decodedFrames?: number;
  presentationTime?: number;
};
export type ArrivalEvidence = "presented-frames" | "decoded-frames" | "presentation-time" | "media-time";
export type FrameArrival = { sequence: number; at: number; evidence: ArrivalEvidence; mediaTime: number | null };

const finite = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Frame identity is not playback time: live camera PTS may remain zero.
 * Count actual compositor/decoder progress first. Mere timer ticks and a live
 * track flag never create arrivals; static pictures need no pixel-diff test.
 */
export class FrameArrivalTracker {
  private sequence = 0;
  private presented: number | null = null;
  private decoded: number | null = null;
  private presentationTime: number | null = null;
  private mediaTime: number | null = null;
  private sawCounter = false;
  private lastArrival: FrameArrival | null = null;

  observe(now: number, signals: FrameSignals): FrameArrival | null {
    if (!Number.isFinite(now) || now < 0) return null;
    const presented = finite(signals.presentedFrames), decoded = finite(signals.decodedFrames);
    const presentationTime = finite(signals.presentationTime), mediaTime = finite(signals.mediaTime);
    const presentedAdvanced = presented !== null && presented > 0 && (this.presented === null || presented > this.presented);
    const decodedAdvanced = decoded !== null && decoded > 0 && (this.decoded === null || decoded > this.decoded);
    if ((presented !== null && presented > 0) || (decoded !== null && decoded > 0)) this.sawCounter = true;
    let evidence: ArrivalEvidence | null = presentedAdvanced ? "presented-frames" : decodedAdvanced ? "decoded-frames" : null;
    // A clock must not disguise stopped frame counters once those are usable.
    if (!evidence && !this.sawCounter) {
      if (presentationTime !== null && (this.presentationTime === null || presentationTime > this.presentationTime)) evidence = "presentation-time";
      else if (mediaTime !== null && (this.mediaTime === null || mediaTime !== this.mediaTime)) evidence = "media-time";
    }
    // A decoder can reset its count after reconfiguration. Rebase without
    // counting the reset itself as a frame; the next actual increment counts.
    if (presented !== null) this.presented = presented;
    if (decoded !== null) this.decoded = decoded;
    if (presentationTime !== null) this.presentationTime = presentationTime;
    if (mediaTime !== null) this.mediaTime = mediaTime;
    if (!evidence) return null;
    this.lastArrival = { sequence: ++this.sequence, at: now, evidence, mediaTime };
    return this.lastArrival;
  }

  snapshot() {
    return { arrivals: this.sequence, presentedFrames: this.presented, decodedFrames: this.decoded,
      mediaTime: this.mediaTime, lastArrivalAt: this.lastArrival?.at ?? null, evidence: this.lastArrival?.evidence ?? null };
  }
}
