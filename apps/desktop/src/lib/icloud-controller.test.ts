import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitFileChanges, setBridge, writeNote } from '@reflect/core'
import { createIcloudController, isICloudRoot } from './icloud-controller'

/**
 * The Plan 21 controller contract, most importantly the shadow-base guard:
 * only *external* arrivals may become base ingests — feeding this device's
 * own writes to the sweep would advance a note's merge base past unsynced
 * local edits, which later makes diff3 read those edits as already-merged
 * and drop them. Everything here drives the real controller over a fake
 * bridge; the sweep itself is the Rust side's job.
 */

const seams = vi.hoisted(() => ({
  dirtyOpenPaths: vi.fn<() => string[]>(() => []),
  invalidateIndexQueries: vi.fn(),
  throttledInvalidateIndexQueries: vi.fn(),
}))
vi.mock('@/editor/open-documents', () => ({ dirtyOpenPaths: seams.dirtyOpenPaths }))
vi.mock('@/lib/query-client', () => ({
  invalidateIndexQueries: seams.invalidateIndexQueries,
  throttledInvalidateIndexQueries: seams.throttledInvalidateIndexQueries,
}))

interface ScanCall {
  skipPaths: string[]
  ingestedPaths: string[]
  recordBaseline: boolean
}

const GRAPH = { root: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes', name: 'Notes', generation: 7 }

let invoked: Array<[string, Record<string, unknown>]>
let scanCalls: ScanCall[]
/** Scripted sweep outcomes; `'hang'` parks the sweep until {@link releaseScan}. */
let scanResults: Array<Record<string, unknown> | Error | 'hang'>
let releaseScan: (() => void) | null
let listeners: Map<string, (payload: unknown) => void>

beforeEach(() => {
  // Fake only what the controller schedules — leaving setImmediate real
  // gives settleScan a way to yield genuine event-loop turns, which the
  // reindex chain needs (crypto.subtle resolves off the thread pool).
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  invoked = []
  scanCalls = []
  scanResults = []
  releaseScan = null
  listeners = new Map()
  seams.dirtyOpenPaths.mockReturnValue([])
  setBridge({
    invoke: async (command: string, args?: Record<string, unknown>) => {
      invoked.push([command, args ?? {}])
      switch (command) {
        case 'icloud_conflicts_scan': {
          scanCalls.push({
            skipPaths: (args?.['skipPaths'] as string[] | undefined) ?? [],
            ingestedPaths: (args?.['ingestedPaths'] as string[] | undefined) ?? [],
            recordBaseline: args?.['recordBaseline'] === true,
          })
          const scripted = scanResults.shift()
          if (scripted instanceof Error) {
            throw scripted
          }
          if (scripted === 'hang') {
            return new Promise((resolve) => {
              releaseScan = () =>
                resolve({ changed: [], needsReview: [], deferred: [], autoResolved: 0 })
            })
          }
          return (
            scripted ?? { changed: [], needsReview: [], deferred: [], autoResolved: 0 }
          )
        }
        case 'note_read':
          return '# merged\n'
        default:
          return null
      }
    },
    listen: async (event: string, handler: (payload: unknown) => void) => {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
  })
})

let active: ReturnType<typeof createIcloudController> | null = null

afterEach(() => {
  // Dispose in afterEach, not at test tails — a failed assertion must not
  // leak this test's subscriptions into the next one's scan counts.
  active?.dispose()
  active = null
  vi.useRealTimers()
})

function controller(overrides: { emit?: boolean } = {}) {
  active = createIcloudController({
    graph: GRAPH,
    indexGeneration: 3,
    emitFileChangesFromWatch: overrides.emit ?? false,
  })
  return active
}

/** Covers the arrival-driven path end to end: the 5s ingest debounce plus
 * the 30s minimum spacing from the previous sweep's end. */
const INGEST_SETTLE_MS = 31_000

/** Fire the debounce and let the async scan settle. Signal-triggered scans
 * fire on the 1s window (the default); arrival-driven ingest scans need
 * {@link INGEST_SETTLE_MS}. */
async function settleScan(advanceMs = 1_100): Promise<void> {
  await vi.advanceTimersByTimeAsync(advanceMs)
  // The post-scan fan-out (emit → reindex → invalidate) continues past the
  // last timer, and hashing awaits `crypto.subtle` — a *real* async source
  // fake timers can't flush. setImmediate stays un-faked (see beforeEach) so
  // each round yields a genuine event-loop turn.
  for (let round = 0; round < 20; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('isICloudRoot', () => {
  it('matches container and iCloud Drive paths, and nothing else', () => {
    expect(isICloudRoot(GRAPH.root)).toBe(true)
    expect(
      isICloudRoot('/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/Notes'),
    ).toBe(true)
    expect(isICloudRoot('/Users/alex/Documents/Notes')).toBe(false)
  })
})

describe('createIcloudController', () => {
  it('starts the watch and runs one baseline sweep', async () => {
    const icloud = controller({ emit: true })
    await icloud.start()
    await settleScan()

    const watchStart = invoked.find(([command]) => command === 'icloud_watch_start')
    expect(watchStart?.[1]).toMatchObject({ root: GRAPH.root, emitFileChanges: true })
    expect(scanCalls).toHaveLength(1)
    expect(scanCalls[0]).toMatchObject({ recordBaseline: true, ingestedPaths: [] })

    icloud.dispose()
    active = null
    expect(invoked.some(([command]) => command === 'icloud_watch_stop')).toBe(true)
  })

  it('external upserts become base ingests; this device’s own writes never do', async () => {
    const icloud = controller()
    await icloud.start()
    await settleScan() // baseline out of the way

    await writeNote('notes/own.md', '# mine\n', GRAPH.generation)
    emitFileChanges([
      { path: 'notes/own.md', kind: 'upsert', modifiedMs: 1 },
      { path: 'notes/external.md', kind: 'upsert', modifiedMs: 2 },
      { path: 'notes/gone.md', kind: 'remove' },
    ])
    await settleScan(INGEST_SETTLE_MS) // arrival-driven: debounce + minimum spacing

    expect(scanCalls).toHaveLength(2)
    expect(scanCalls[1]?.ingestedPaths).toEqual(['notes/external.md'])
    expect(scanCalls[1]?.recordBaseline).toBe(false)
  })

  it('sweep rewrites fan out to subscribers and reindex, without re-ingesting', async () => {
    scanResults.push({
      changed: [{ path: 'notes/merged.md', kind: 'upsert', modifiedMs: 5 }],
      needsReview: ['notes/merged.md'],
      deferred: [],
      autoResolved: 0,
    })
    const icloud = controller()
    await icloud.start()
    await settleScan()

    // The rewrite reindexes directly under the index generation. The reindex
    // chain hashes via crypto.subtle (real thread-pool async) — poll for its
    // arrival instead of counting event-loop yields, which is CI-speed flaky.
    await vi.waitFor(() => {
      expect(invoked.some(([command]) => command === 'index_apply_batch')).toBe(true)
    })
    const apply = invoked.find(([command]) => command === 'index_apply_batch')
    expect(apply?.[1]).toMatchObject({ generation: 3 })
    // …and neither the controller's own synchronous fan-out nor the file
    // watcher's later echo of the sweep's write may come back as an ingest —
    // only the genuinely external change does.
    emitFileChanges([
      { path: 'notes/merged.md', kind: 'upsert', modifiedMs: 6 }, // watcher echo
      { path: 'notes/other.md', kind: 'upsert', modifiedMs: 9 },
    ])
    await settleScan(INGEST_SETTLE_MS) // arrival-driven: debounce + minimum spacing
    expect(scanCalls[1]?.ingestedPaths).toEqual(['notes/other.md'])
  })

  it('a failed sweep re-queues its ingests and the adoption baseline', async () => {
    scanResults.push(new Error('container hiccup'))
    const icloud = controller()
    await icloud.start()

    emitFileChanges([{ path: 'notes/external.md', kind: 'upsert', modifiedMs: 2 }])
    await settleScan() // scan #1 (the sooner baseline timer wins): baseline + ingest — fails

    emitFileChanges([{ path: 'notes/external.md', kind: 'upsert', modifiedMs: 3 }])
    await settleScan(INGEST_SETTLE_MS) // scan #2 retries both, on the ingest window

    expect(scanCalls).toHaveLength(2)
    expect(scanCalls[0]?.recordBaseline).toBe(true)
    expect(scanCalls[1]?.recordBaseline).toBe(true)
    expect(scanCalls[1]?.ingestedPaths).toContain('notes/external.md')
  })

  it('spaces arrival-driven sweeps apart during a download stream', async () => {
    const icloud = controller()
    await icloud.start()
    await settleScan() // baseline ends ≈ t1

    // A first-sync shape: batches keep arriving. The first arrival lands
    // just after the baseline sweep — the debounce alone would sweep again
    // at +5s, but the minimum spacing holds it back…
    emitFileChanges([{ path: 'notes/one.md', kind: 'upsert', modifiedMs: 1 }])
    await settleScan(5_100)
    expect(scanCalls).toHaveLength(1)

    // …so a later batch folds into the SAME deferred sweep, which fires once
    // the spacing from the baseline's end has elapsed, carrying both ingests.
    emitFileChanges([{ path: 'notes/two.md', kind: 'upsert', modifiedMs: 2 }])
    await settleScan(26_000)
    expect(scanCalls).toHaveLength(2)
    expect(scanCalls[1]?.ingestedPaths).toEqual(
      expect.arrayContaining(['notes/one.md', 'notes/two.md']),
    )
  })

  it('a conflict signal caught mid-sweep replays on the prompt window', async () => {
    scanResults.push('hang')
    const icloud = controller()
    await icloud.start()
    await settleScan() // the baseline sweep starts — and hangs
    expect(scanCalls).toHaveLength(1)

    // A conflict arrives while the sweep is still running: no timer arms,
    // the class is remembered.
    listeners.get('icloud:conflicts')?.(['notes/a.md'])
    await settleScan()
    expect(scanCalls).toHaveLength(1)

    // The sweep ends → the queued conflict replays promptly (1s), never on
    // the wide ingest window.
    releaseScan?.()
    await settleScan()
    expect(scanCalls).toHaveLength(2)
  })

  it('an arrival caught mid-sweep replays on the ingest spacing', async () => {
    scanResults.push('hang')
    const icloud = controller()
    await icloud.start()
    await settleScan() // the baseline sweep starts — and hangs
    expect(scanCalls).toHaveLength(1)

    emitFileChanges([{ path: 'notes/late.md', kind: 'upsert', modifiedMs: 2 }])
    releaseScan?.()
    await settleScan() // prompt window only — a long sweep must not chain
    expect(scanCalls).toHaveLength(1)

    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls).toHaveLength(2)
    expect(scanCalls[1]?.ingestedPaths).toEqual(['notes/late.md'])
  })

  it('conflict signals and resume events schedule deduped sweeps', async () => {
    const icloud = controller()
    await icloud.start()
    await settleScan() // baseline

    listeners.get('icloud:conflicts')?.(['notes/a.md'])
    await settleScan()
    expect(scanCalls).toHaveLength(2)

    // One resume transition fires focus twice (focus + visibility) — deduped.
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('focus'))
    await settleScan()
    expect(scanCalls).toHaveLength(3)
  })

  it('dirty open notes ride skipPaths so their conflicts defer', async () => {
    seams.dirtyOpenPaths.mockReturnValue(['daily/2026-07-04.md'])
    const icloud = controller()
    await icloud.start()
    await settleScan()

    expect(scanCalls[0]?.skipPaths).toEqual(['daily/2026-07-04.md'])
  })
})
