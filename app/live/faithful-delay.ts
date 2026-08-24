import type { SequenceFrame } from "../offline-matching.ts";
import {
  FaithfulStrictSequence,
  type FaithfulCandidate,
  type FaithfulChoice,
  type FaithfulRanked,
} from "../live-faithful-sequence.ts";

export type FaithfulDelayStats = {
  analyzedFrames: number;
  committedFrames: number;
  pendingLookaheadFrames: number;
};

/**
 * Runs the exact streaming equivalent of the offline strict path optimizer, but
 * keeps a configurable number of future frames uncommitted. The delay lets the
 * best beam revise recent choices before they become visible. No analyzed frame
 * is intentionally discarded; flush() emits the remaining suffix in order.
 */
export class DelayedFaithfulCommitter<T extends FaithfulCandidate> {
  private readonly sequence = new FaithfulStrictSequence<T>();
  private lookaheadFrames: number;
  private committedFrames = 0;

  constructor(lookaheadFrames = 90) {
    this.lookaheadFrames = Math.max(0, Math.floor(lookaheadFrames));
  }

  reset(lookaheadFrames = this.lookaheadFrames) {
    this.sequence.reset();
    this.lookaheadFrames = Math.max(0, Math.floor(lookaheadFrames));
    this.committedFrames = 0;
  }

  push(frame: SequenceFrame, rankedBeam: FaithfulRanked<T>[]) {
    this.sequence.push(frame, rankedBeam);
    return this.take(false);
  }

  flush() {
    return this.take(true);
  }

  stats(): FaithfulDelayStats {
    const analyzedFrames = this.sequence.sequence().length;
    return {
      analyzedFrames,
      committedFrames: this.committedFrames,
      pendingLookaheadFrames: Math.max(0, analyzedFrames - this.committedFrames),
    };
  }

  private take(flush: boolean): FaithfulChoice<T>[] {
    const bestPath = this.sequence.sequence();
    const stableEnd = flush
      ? bestPath.length
      : Math.max(0, bestPath.length - this.lookaheadFrames);
    if (stableEnd <= this.committedFrames) return [];
    const output = bestPath.slice(this.committedFrames, stableEnd);
    this.committedFrames = stableEnd;
    return output;
  }
}
