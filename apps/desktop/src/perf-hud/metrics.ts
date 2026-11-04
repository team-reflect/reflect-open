/** What the HUD reports for one gesture. */
export interface GestureMetrics {
  durationMs: number
  frames: number
  fps: number
  p95FrameMs: number
  /** Milliseconds of frame time over budget per second of gesture. */
  hitchTimeRatio: number
  /** `null` when the gesture had no `pointermove`. */
  p95InputLagMs: number | null
  frameBudgetMs: number
}

export function getFrameIntervals(times: readonly number[]): number[] {
  return times.slice(1).map((time, i) => time - (times[i] ?? time))
}

/** Nearest-rank percentile; `0` for no values. */
export function getPercentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0
}

export function measureGesture(
  frameTimes: readonly number[],
  inputLags: readonly number[],
  frameBudgetMs: number,
): GestureMetrics {
  const intervals = getFrameIntervals(frameTimes)
  const durationMs = (frameTimes.at(-1) ?? 0) - (frameTimes[0] ?? 0)
  const hitchMs = intervals.reduce(
    (sum, interval) => sum + Math.max(0, interval - frameBudgetMs),
    0,
  )
  return {
    durationMs,
    frames: intervals.length,
    fps: durationMs > 0 ? (intervals.length * 1000) / durationMs : 0,
    p95FrameMs: getPercentile(intervals, 0.95),
    hitchTimeRatio: durationMs > 0 ? hitchMs / (durationMs / 1000) : 0,
    p95InputLagMs: inputLags.length > 0 ? getPercentile(inputLags, 0.95) : null,
    frameBudgetMs,
  }
}
