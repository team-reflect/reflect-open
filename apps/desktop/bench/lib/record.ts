/**
 * Writes a benchmark result to `docs/performance-pass-20260620/artifacts/<rev>/`.
 *
 * Gated on `BENCH_REV` so a normal `vitest run` is a pure no-op — only the
 * before/after runner (which sets `BENCH_REV` and `BENCH_OUT`) materialises
 * artifacts. Benchmark-only.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface BenchResult {
  /** Stable flow id, also the artifact filename. */
  flow: string
  /** One-line human description of what the numbers mean. */
  description: string
  /** The recorded metrics (counts and/or durations). */
  metrics: Record<string, number | string>
}

/** Persist one flow's result for the current revision, if a run requested it. */
export function record(result: BenchResult): void {
  const rev = process.env['BENCH_REV']
  if (!rev) {
    return
  }
  const base =
    process.env['BENCH_OUT'] ??
    resolve(process.cwd(), '../../docs/performance-pass-20260620/artifacts')
  const dir = join(base, rev)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${result.flow}.json`),
    `${JSON.stringify({ rev, ...result }, null, 2)}\n`,
  )
}
