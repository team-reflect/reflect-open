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
  scope: string
}

const GRAPH = {
  root: '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes',
  name: 'Notes',
  generation: 7,
}

let invoked: Array<[string, Record<string, unknown>]>
let scanCalls: ScanCall[]
/** Scripted sweep outcomes; `'hang'` parks the sweep until {@link releaseScan}. */
let scanResults: Array<Record<string, unknown> | Error | 'hang'>
let releaseScan: (() => void) | null
let listeners: Map<string, (payload: unknown) => void>

beforeEach(() => {
  // Fake only what the controller schedules — leaving the message channel
  // real gives settleScan a way to yield genuine event-loop turns, which the
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
            scope: String(args?.['scope']),
          })
          const scripted = scanResults.shift()
          if (scripted instanceof Error) {
            throw scripted
          }
          if (scripted === 'hang') {
            return await new Promise((resolve) => {
              releaseScan = () =>
                resolve({ changed: [], needsReview: [], deferred: [], autoResolved: 0 })
            })
          }
          return scripted ?? { changed: [], needsReview: [], deferred: [], autoResolved: 0 }
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

/** A desktop controller by default; `watch: true` is the mobile shape. */
function controller(overrides: { watch?: boolean } = {}) {
  active = createIcloudController({
    graph: GRAPH,
    indexGeneration: 3,
    metadataWatch: overrides.watch ?? false,
  })
  return active
}

/** Covers the arrival-driven path end to end: the 5s ingest debounce plus
 * the 30s minimum spacing from the previous sweep's end. */
const INGEST_SETTLE_MS = 31_000

/** Fire the debounce and let the async scan settle. Signal-triggered scans
 * fire on the 1s window (the default); arrival-driven ingest scans need
 * {@link INGEST_SETTLE_MS}. */
/** One macrotask turn that the faked timers do not control. */
function realEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}

async function settleScan(advanceMs = 1_100): Promise<void> {
  await vi.advanceTimersByTimeAsync(advanceMs)
  // The post-scan fan-out (emit → reindex → invalidate) continues past the
  // last timer, and hashing awaits `crypto.subtle` — a *real* async source
  // fake timers can't flush. A message channel stays un-faked (see beforeEach)
  // so each round yields a genuine event-loop turn.
  for (let round = 0; round < 20; round += 1) {
    await realEventLoopTurn()
  }
}

describe('isICloudRoot', () => {
  it('matches container and iCloud Drive paths, and nothing else', () => {
    expect(isICloudRoot(GRAPH.root)).toBe(true)
    expect(isICloudRoot('/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/Notes')).toBe(
      true,
    )
    expect(isICloudRoot('/Users/alex/Documents/Notes')).toBe(false)
  })
})

describe('createIcloudController', () => {
  it('mobile starts the watch and runs one baseline sweep', async () => {
    const icloud = controller({ watch: true })
    await icloud.start()
    await settleScan()

    const watchStart = invoked.find(([command]) => command === 'icloud_watch_start')
    expect(watchStart?.[1]).toEqual({ root: GRAPH.root })
    expect(scanCalls).toHaveLength(1)
    expect(scanCalls[0]).toMatchObject({ recordBaseline: true, ingestedPaths: [] })

    icloud.dispose()
    active = null
    expect(invoked.some(([command]) => command === 'icloud_watch_stop')).toBe(true)
  })

  it('desktop never installs the metadata watch (#1180)', async () => {
    // The container-wide NSMetadataQuery gather is what pinned fileproviderd
    // on iCloud-backed desktop graphs; the notify watcher already covers
    // freshness there, so the watch must never start — not on start, not on
    // resume — and there is nothing to stop on dispose.
    const icloud = controller()
    await icloud.start()
    await settleScan()
    window.dispatchEvent(new Event('focus'))
    await settleScan()
    icloud.dispose()
    active = null

    const commands = invoked.map(([command]) => command)
    expect(commands).not.toContain('icloud_watch_start')
    expect(commands).not.toContain('icloud_watch_stop')
    expect(scanCalls).toHaveLength(2) // baseline + resume: the sweeps still run
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

  it('defers mobile baseline, conflict, and ingest scans until foreground', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const icloud = controller({ watch: true })
      await icloud.start()
      await settleScan()
      expect(scanCalls).toHaveLength(0)

      emitFileChanges([{ path: 'notes/external.md', kind: 'upsert', modifiedMs: 5 }])
      listeners.get('icloud:conflicts')?.(['notes/conflicted.md'])
      await settleScan(INGEST_SETTLE_MS)
      expect(scanCalls).toHaveLength(0)

      visibility.mockReturnValue('visible')
      document.dispatchEvent(new Event('visibilitychange'))
      await settleScan()

      expect(scanCalls).toHaveLength(1)
      expect(scanCalls[0]).toMatchObject({
        recordBaseline: true,
        ingestedPaths: ['notes/external.md'],
      })
    } finally {
      visibility.mockRestore()
    }
  })

  it('a mobile resume restarts the metadata watch (stop before start)', async () => {
    // A long iOS suspension can kill NSMetadataQuery update delivery, and on
    // mobile the query is the sole external-change source — the resume must
    // reinstall it or remote edits stay invisible until relaunch.
    const icloud = controller({ watch: true })
    await icloud.start()
    await settleScan()
    invoked.length = 0

    window.dispatchEvent(new Event('focus'))
    await settleScan()

    const commands = invoked.map(([command]) => command)
    const stopAt = commands.indexOf('icloud_watch_stop')
    const startAt = commands.indexOf('icloud_watch_start')
    expect(stopAt).toBeGreaterThanOrEqual(0)
    expect(startAt).toBeGreaterThan(stopAt)
    expect(invoked[startAt]?.[1]).toEqual({ root: GRAPH.root })
  })

  it('preserves desktop baseline scanning while the document is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    try {
      const icloud = controller({ watch: false })
      await icloud.start()
      await settleScan()

      expect(scanCalls).toHaveLength(1)
      expect(scanCalls[0]?.recordBaseline).toBe(true)
    } finally {
      visibility.mockRestore()
    }
  })

  it('mobile scopes sweeps: full for baseline and resume, candidates for signals and ingests', async () => {
    const icloud = controller({ watch: true })
    await icloud.start()
    await settleScan()
    expect(scanCalls[0]?.scope).toBe('full') // the adoption baseline is the backstop

    listeners.get('icloud:conflicts')?.(['notes/conflicted.md'])
    await settleScan()
    expect(scanCalls[1]?.scope).toBe('candidates') // signal and set share a round

    emitFileChanges([{ path: 'notes/external.md', kind: 'upsert', modifiedMs: 2 }])
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls[2]?.scope).toBe('candidates') // bulk-sync arrival sweeps stay cheap

    window.dispatchEvent(new Event('focus'))
    await settleScan()
    expect(scanCalls[3]?.scope).toBe('full') // resume re-checks everything
  })

  it('desktop scopes arrival sweeps to the arrivals and never listens for watch signals', async () => {
    const icloud = controller()
    await icloud.start()
    await settleScan()
    expect(scanCalls[0]?.scope).toBe('full') // the adoption baseline is the backstop

    // Without a watch there is no candidate set to trust: the arrivals
    // themselves are the only notes a just-landed remote edit can have
    // conflicted, so the sweep checks exactly those — never the whole graph
    // per batch, and never the (unanswerable) candidates scope.
    emitFileChanges([{ path: 'notes/external.md', kind: 'upsert', modifiedMs: 2 }])
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls[1]).toMatchObject({ scope: 'ingested', ingestedPaths: ['notes/external.md'] })

    // No watch runs, so its signals are never subscribed to.
    expect(listeners.has('icloud:conflicts')).toBe(false)
    expect(listeners.has('icloud:watch-failed')).toBe(false)

    window.dispatchEvent(new Event('focus'))
    await settleScan()
    expect(scanCalls[2]?.scope).toBe('full') // resume re-checks everything
  })

  it('a failed candidates sweep retries at full scope', async () => {
    const icloud = controller({ watch: true })
    await icloud.start()
    await settleScan() // baseline (full) out of the way

    scanResults.push(new Error('container hiccup'))
    listeners.get('icloud:conflicts')?.(['notes/conflicted.md'])
    await settleScan()
    expect(scanCalls[1]?.scope).toBe('candidates')

    listeners.get('icloud:conflicts')?.(['notes/conflicted.md'])
    await settleScan()
    // Whatever failed, the retry must be thorough.
    expect(scanCalls[2]?.scope).toBe('full')
  })

  it('a failed desktop arrival sweep retries at full scope', async () => {
    const icloud = controller()
    await icloud.start()
    await settleScan() // baseline (full) out of the way

    scanResults.push(new Error('container hiccup'))
    emitFileChanges([{ path: 'notes/one.md', kind: 'upsert', modifiedMs: 1 }])
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls[1]?.scope).toBe('ingested')

    emitFileChanges([{ path: 'notes/two.md', kind: 'upsert', modifiedMs: 2 }])
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls[2]).toMatchObject({
      scope: 'full',
      ingestedPaths: expect.arrayContaining(['notes/one.md', 'notes/two.md']),
    })
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
    const icloud = controller({ watch: true })
    await icloud.start()
    await settleScan() // the baseline sweep starts — and hangs
    expect(scanCalls).toHaveLength(1)

    // A conflict arrives while the sweep is still running: no timer arms,
    // the class is remembered.
    listeners.get('icloud:conflicts')?.(['notes/a.md'])
    await settleScan()
    expect(scanCalls).toHaveLength(1)

    // The sweep ends → the queued conflict replays promptly (1s), never on
    // the wide ingest window — and with its own candidates scope, not the
    // default full: replaying the O(N) version pass on overlap would undo
    // the scoping in exactly the case it exists for.
    releaseScan?.()
    await settleScan()
    expect(scanCalls).toHaveLength(2)
    expect(scanCalls[1]?.scope).toBe('candidates')
  })

  it('a mid-sweep resume keeps its full scope through the replay', async () => {
    scanResults.push('hang')
    const icloud = controller({ watch: true })
    await icloud.start()
    await settleScan() // the baseline sweep starts — and hangs
    expect(scanCalls).toHaveLength(1)

    // A resume (full) and a conflict signal (candidates) both land mid-sweep:
    // full is sticky through the merge, whatever the arrival order.
    listeners.get('icloud:conflicts')?.(['notes/a.md'])
    window.dispatchEvent(new Event('focus'))
    releaseScan?.()
    await settleScan()
    expect(scanCalls).toHaveLength(2)
    expect(scanCalls[1]?.scope).toBe('full')
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
    expect(scanCalls[1]).toMatchObject({ scope: 'ingested', ingestedPaths: ['notes/late.md'] })
  })

  it('conflict signals and resume events schedule deduped sweeps', async () => {
    const icloud = controller({ watch: true })
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
