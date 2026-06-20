/**
 * A React `<Profiler>` wrapper that sums commit timings, so a flow can report
 * the real React commit cost (`actualDuration`) it spends across an
 * interaction — a secondary, runtime-dependent corroboration of the
 * deterministic render counts. Benchmark-only.
 */

import { Profiler, type ProfilerOnRenderCallback, type ReactElement, type ReactNode } from 'react'

export interface CommitTotals {
  /** Number of committed renders the profiled subtree participated in. */
  commits: number
  /** Summed `actualDuration` (ms) — the time React spent rendering committed work. */
  actualMs: number
  /** Summed `baseDuration` (ms) — the cost of rendering the whole subtree without memo. */
  baseMs: number
}

/** Create a fresh accumulator and a `<Profiler>`-bound onRender callback. */
export function createCommitMeter(): {
  totals: CommitTotals
  onRender: ProfilerOnRenderCallback
} {
  const totals: CommitTotals = { commits: 0, actualMs: 0, baseMs: 0 }
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration, baseDuration) => {
    totals.commits += 1
    totals.actualMs += actualDuration
    totals.baseMs += baseDuration
  }
  return { totals, onRender }
}

/** Wrap children in a profiler bound to `onRender`. */
export function MeteredTree({
  onRender,
  children,
}: {
  onRender: ProfilerOnRenderCallback
  children: ReactNode
}): ReactElement {
  return (
    <Profiler id="bench" onRender={onRender}>
      {children}
    </Profiler>
  )
}
