import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenDocumentsService } from '../documents/open-documents-service.ts'
import { ReflectError } from '../errors.ts'
import type { IcloudScanOptions, IcloudSweepOutcome } from '../ipc/icloud-native-service.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createTestFileChangeService, type TestFileChangeService } from '../testing/file-change.ts'
import { createTestIndexLifecycleService } from '../testing/index-lifecycle.ts'
import { createTestProgressPort, type TestProgressPort } from '../testing/ports.ts'
import { createTestLoggerService, type TestLoggerService } from '../testing/logger.ts'
import { createTestActivityPort, type TestActivityPort } from '../testing/shell.ts'
import { createTestICloudNativeService, type TestICloudNativeService } from '../testing/sync.ts'
import {
  createICloudSyncService,
  isICloudRoot,
  type ICloudSyncService,
} from './icloud-sync-service.ts'

/**
 * The Plan 21 service contract, most importantly the shadow-base guard:
 * only *external* arrivals may become base ingests — feeding this device's
 * own writes to the sweep would advance a note's merge base past unsynced
 * local edits, which later makes diff3 read those edits as already-merged
 * and drop them. Everything here drives the real service over fakes; the
 * sweep itself is the Rust side's job.
 */

const ROOT = '/Users/alex/Library/Mobile Documents/iCloud~app/Documents/Notes'
const GENERATION = 7
const INDEX_GENERATION = 3

const EMPTY_OUTCOME: IcloudSweepOutcome = {
  changed: [],
  copies: [],
  autoResolved: 0,
}

let clock: TestClockService
let activity: TestActivityPort
let logger: TestLoggerService
let progress: TestProgressPort
let fileChanges: TestFileChangeService
let icloud: TestICloudNativeService
/**
 * Scripted sweep outcomes; `'hang'` parks the sweep until {@link releaseScan}.
 */
let scanResults: Array<IcloudSweepOutcome | Error | 'hang'>
let releaseScan: (() => void) | null
let dirtyPaths: string[]
let indexApplies: Array<{ paths: string[]; generation: number; canApply: boolean }>
let active: ICloudSyncService | null = null

beforeEach(() => {
  clock = createTestClockService({ now: Date.UTC(2026, 6, 4) })
  activity = createTestActivityPort()
  logger = createTestLoggerService()
  progress = createTestProgressPort()
  fileChanges = createTestFileChangeService()
  icloud = createTestICloudNativeService()
  scanResults = []
  releaseScan = null
  dirtyPaths = []
  indexApplies = []
  icloud.onConflictsScan(async () => {
    const scripted = scanResults.shift()
    if (scripted instanceof Error) {
      throw scripted
    }
    if (scripted === 'hang') {
      return await new Promise<IcloudSweepOutcome>((resolve) => {
        releaseScan = () => {
          resolve(EMPTY_OUTCOME)
        }
      })
    }
    return scripted ?? EMPTY_OUTCOME
  })
})

afterEach(() => {
  // Dispose in afterEach, not at test tails — a failed assertion must not
  // leak this test's subscriptions into the next one's scan counts.
  active?.dispose()
  active = null
})

/**
 * A desktop service by default; `watch: true` is the mobile shape.
 */
function service(overrides: { watch?: boolean } = {}) {
  const indexLifecycle = createTestIndexLifecycleService()
  vi.spyOn(indexLifecycle, 'applyChanges').mockImplementation(
    async (changes, generation, _fileGeneration, canApply) => {
      indexApplies.push({
        paths: changes.map((change) => change.path),
        generation,
        canApply: canApply?.() ?? true,
      })
      return changes.length
    },
  )
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  vi.spyOn(openDocuments, 'dirtyPaths').mockImplementation(() => dirtyPaths)
  active = createICloudSyncService(
    {
      icloudNative: icloud,
      fileChanges,
      indexLifecycle,
      openDocuments,
      activity,
      clock,
      logger,
      progress,
    },
    {
      root: ROOT,
      generation: GENERATION,
      indexGeneration: INDEX_GENERATION,
      metadataWatch: overrides.watch ?? false,
    },
  )
  return active
}

function scanCalls(): IcloudScanOptions[] {
  return icloud.calls().flatMap((call) => (call.method === 'conflictsScan' ? [call.args[0]] : []))
}

function commands(): string[] {
  return icloud.calls().map((call) => call.method)
}

/** Covers the arrival-driven path end to end: the 5s ingest debounce plus
 * the 30s minimum spacing from the previous sweep's end. */
const INGEST_SETTLE_MS = 31_000

/** Fire the debounce and let the async scan settle. Signal-triggered scans
 * fire on the 1s window (the default); arrival-driven ingest scans need
 * {@link INGEST_SETTLE_MS}. */
async function settleScan(advanceMs = 1_100): Promise<void> {
  await clock.advance(advanceMs)
}

function emitExternal(...changes: Array<{ path: string; kind?: 'upsert' | 'remove' }>): void {
  fileChanges.emit({
    changes: changes.map((change, index) => ({
      path: change.path,
      kind: change.kind ?? 'upsert',
      ...(change.kind === 'remove' ? {} : { modifiedMs: index + 1 }),
    })),
    source: 'external',
  })
}

describe('isICloudRoot', () => {
  it('matches container and iCloud Drive paths, and nothing else', () => {
    expect(isICloudRoot(ROOT)).toBe(true)
    expect(isICloudRoot('/Users/alex/Library/Mobile Documents/com~apple~CloudDocs/Notes')).toBe(
      true,
    )
    expect(isICloudRoot('/Users/alex/Documents/Notes')).toBe(false)
  })
})

describe('createICloudSyncService', () => {
  it('mobile starts the watch and runs one baseline sweep', async () => {
    const sync = service({ watch: true })
    await sync.start()
    await settleScan()

    expect(icloud.calls().find((call) => call.method === 'watchStart')?.args).toEqual([ROOT])
    expect(scanCalls()).toHaveLength(1)
    expect(scanCalls()[0]).toMatchObject({
      generation: GENERATION,
      recordBaseline: true,
      ingestedPaths: [],
    })

    sync.dispose()
    active = null
    expect(commands()).toContain('watchStop')
  })

  it('desktop never installs the metadata watch (#1180)', async () => {
    // The container-wide NSMetadataQuery gather is what pinned fileproviderd
    // on iCloud-backed desktop graphs; the notify watcher already covers
    // freshness there, so the watch must never start — not on start, not on
    // resume — and there is nothing to stop on dispose.
    const sync = service()
    await sync.start()
    await settleScan()
    activity.emitResume()
    await settleScan()
    sync.dispose()
    active = null

    expect(commands()).not.toContain('watchStart')
    expect(commands()).not.toContain('watchStop')
    expect(scanCalls()).toHaveLength(2) // baseline + resume: the sweeps still run
  })

  it('an external batch is ingested', async () => {
    const sync = service()
    await sync.start()
    await settleScan() // baseline out of the way

    emitExternal(
      { path: 'notes/external.md' },
      { path: 'notes/gone.md', kind: 'remove' },
      { path: 'assets/picture.png' },
    )
    await settleScan(INGEST_SETTLE_MS) // arrival-driven: debounce + minimum spacing

    expect(scanCalls()).toHaveLength(2)
    expect(scanCalls()[1]?.ingestedPaths).toEqual(['notes/external.md'])
    expect(scanCalls()[1]?.recordBaseline).toBe(false)
  })

  it('own-write and pull batches are not ingested', async () => {
    const sync = service()
    await sync.start()
    await settleScan()

    fileChanges.emit({
      changes: [{ path: 'notes/own.md', kind: 'upsert', modifiedMs: 1 }],
      source: 'own-write',
    })
    fileChanges.emit({
      changes: [{ path: 'notes/pulled.md', kind: 'upsert', modifiedMs: 1 }],
      source: 'pull',
    })
    await settleScan(INGEST_SETTLE_MS)

    expect(scanCalls()).toHaveLength(1)
  })

  it('a sweep that wrote conflict copies lists every copy once through progress', async () => {
    scanResults.push({
      ...EMPTY_OUTCOME,
      copies: [
        'assets/data (conflict 2026-10-16 08-05-31 a1b2c3d4).json',
        'media/talk (conflict 2026-10-16 08-05-32 b2c3d4e5).mp3',
      ],
    })
    const sync = service()
    await sync.start()
    await settleScan()

    expect(progress.snapshot()).toMatchObject([
      {
        label: 'Syncing',
        message:
          'Kept 2 conflict copies: assets/data (conflict 2026-10-16 08-05-31 a1b2c3d4).json, media/talk (conflict 2026-10-16 08-05-32 b2c3d4e5).mp3',
      },
    ])
  })

  it('sweep rewrites fan out to subscribers and reindex, without re-ingesting', async () => {
    scanResults.push({
      changed: [
        { path: 'notes/merged.md', kind: 'upsert', modifiedMs: 5 },
        { path: 'assets/picture.png', kind: 'upsert', modifiedMs: 5 },
      ],
      copies: [],
      autoResolved: 0,
    })
    const sync = service()
    await sync.start()
    await settleScan()

    // The whole batch reaches every file-change subscriber, tagged as a sweep…
    expect(fileChanges.batches()).toEqual([
      {
        changes: [
          { path: 'notes/merged.md', kind: 'upsert', modifiedMs: 5 },
          { path: 'assets/picture.png', kind: 'upsert', modifiedMs: 5 },
        ],
        source: 'icloud-sweep',
      },
    ])
    // …and the notes reindex directly under the index generation.
    expect(indexApplies).toEqual([
      { paths: ['notes/merged.md'], generation: INDEX_GENERATION, canApply: true },
    ])
    // The sweep batch itself is never an ingest.
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls()).toHaveLength(1)
  })

  it('gates the direct reindex on visibility for mobile only', async () => {
    const changed: IcloudSweepOutcome = {
      ...EMPTY_OUTCOME,
      changed: [{ path: 'notes/merged.md', kind: 'upsert', modifiedMs: 5 }],
    }
    // The app hides while the sweep is in flight, so its result lands hidden.
    icloud.onConflictsScan(() => {
      activity.setHidden(true)
      return changed
    })

    const mobile = service({ watch: true })
    await mobile.start()
    await settleScan()
    expect(indexApplies.map((apply) => apply.canApply)).toEqual([false])
    mobile.dispose()

    activity.setHidden(false)
    indexApplies = []
    const desktop = service()
    await desktop.start()
    await settleScan()
    expect(indexApplies.map((apply) => apply.canApply)).toEqual([true])
  })

  it('defers mobile baseline, conflict, and ingest scans until foreground', async () => {
    activity.setHidden(true)
    const sync = service({ watch: true })
    await sync.start()
    await settleScan()
    expect(scanCalls()).toHaveLength(0)

    emitExternal({ path: 'notes/external.md' })
    icloud.emitConflicts(['notes/conflicted.md'])
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls()).toHaveLength(0)

    activity.emitVisible()
    activity.emitResume()
    await settleScan()

    expect(scanCalls()).toHaveLength(1)
    expect(scanCalls()[0]).toMatchObject({
      recordBaseline: true,
      ingestedPaths: ['notes/external.md'],
    })
  })

  it('a mobile resume restarts the metadata watch (stop before start)', async () => {
    // A long iOS suspension can kill NSMetadataQuery update delivery, and on
    // mobile the query is the sole external-change source — the resume must
    // reinstall it or remote edits stay invisible until relaunch.
    const sync = service({ watch: true })
    await sync.start()
    await settleScan()
    const before = icloud.calls().length

    activity.emitResume()
    await settleScan()

    const after = icloud.calls().slice(before)
    const methods = after.map((call) => call.method)
    const stopAt = methods.indexOf('watchStop')
    const startAt = methods.indexOf('watchStart')
    expect(stopAt).toBeGreaterThanOrEqual(0)
    expect(startAt).toBeGreaterThan(stopAt)
    expect(after[startAt]?.args).toEqual([ROOT])
  })

  it('a watch that fails to start is logged and the baseline sweep still runs', async () => {
    vi.spyOn(icloud, 'watchStart').mockRejectedValue(new ReflectError('io', 'no container'))
    const sync = service({ watch: true })
    await sync.start()
    await settleScan()

    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'iCloud watch failed to start:',
    ])
    expect(scanCalls()).toHaveLength(1)
  })

  it('a failed change subscription is logged and the baseline sweep still runs', async () => {
    vi.spyOn(fileChanges, 'subscribe').mockImplementation(() => {
      throw new ReflectError('io', 'watcher unavailable')
    })
    const sync = service()
    await sync.start()
    await settleScan()

    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'iCloud change subscriptions failed to start:',
    ])
    expect(scanCalls()).toHaveLength(1)
  })

  it('the watch install-failure signal is logged and sweeps right away', async () => {
    const sync = service({ watch: true })
    await sync.start()
    await settleScan() // baseline

    icloud.emitWatchFailed()
    await settleScan()

    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'iCloud watch failed to start; relying on resume-triggered sweeps',
    ])
    expect(scanCalls()).toHaveLength(2)
    expect(scanCalls()[1]?.scope).toBe('full')
  })

  it('preserves desktop baseline scanning while the document is hidden', async () => {
    activity.setHidden(true)
    const sync = service({ watch: false })
    await sync.start()
    await settleScan()

    expect(scanCalls()).toHaveLength(1)
    expect(scanCalls()[0]?.recordBaseline).toBe(true)
  })

  it('mobile scopes sweeps: full for baseline and resume, candidates for signals and ingests', async () => {
    const sync = service({ watch: true })
    await sync.start()
    await settleScan()
    expect(scanCalls()[0]?.scope).toBe('full') // the adoption baseline is the backstop

    icloud.emitConflicts(['notes/conflicted.md'])
    await settleScan()
    expect(scanCalls()[1]?.scope).toBe('candidates') // signal and set share a round

    emitExternal({ path: 'notes/external.md' })
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls()[2]?.scope).toBe('candidates') // bulk-sync arrival sweeps stay cheap

    activity.emitResume()
    await settleScan()
    expect(scanCalls()[3]?.scope).toBe('full') // resume re-checks everything
  })

  it('desktop scopes arrival sweeps to the arrivals and never listens for watch signals', async () => {
    const sync = service()
    await sync.start()
    await settleScan()
    expect(scanCalls()[0]?.scope).toBe('full') // the adoption baseline is the backstop

    // Without a watch there is no candidate set to trust: the arrivals
    // themselves are the only notes a just-landed remote edit can have
    // conflicted, so the sweep checks exactly those — never the whole graph
    // per batch, and never the (unanswerable) candidates scope.
    emitExternal({ path: 'notes/external.md' })
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls()[1]).toMatchObject({
      scope: 'ingested',
      ingestedPaths: ['notes/external.md'],
    })

    // No watch runs, so its signals are never subscribed to.
    icloud.emitConflicts(['notes/conflicted.md'])
    icloud.emitWatchFailed()
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls()).toHaveLength(2)

    activity.emitResume()
    await settleScan()
    expect(scanCalls()[2]?.scope).toBe('full') // resume re-checks everything
  })

  it('a failed candidates sweep retries at full scope', async () => {
    const sync = service({ watch: true })
    await sync.start()
    await settleScan() // baseline (full) out of the way

    scanResults.push(new Error('container hiccup'))
    icloud.emitConflicts(['notes/conflicted.md'])
    await settleScan()
    expect(scanCalls()[1]?.scope).toBe('candidates')
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'iCloud conflict sweep failed:',
    ])

    icloud.emitConflicts(['notes/conflicted.md'])
    await settleScan()
    // Whatever failed, the retry must be thorough.
    expect(scanCalls()[2]?.scope).toBe('full')
  })

  it('a failed desktop arrival sweep retries at full scope', async () => {
    const sync = service()
    await sync.start()
    await settleScan() // baseline (full) out of the way

    scanResults.push(new Error('container hiccup'))
    emitExternal({ path: 'notes/one.md' })
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls()[1]?.scope).toBe('ingested')

    emitExternal({ path: 'notes/two.md' })
    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls()[2]).toMatchObject({
      scope: 'full',
      ingestedPaths: expect.arrayContaining(['notes/one.md', 'notes/two.md']),
    })
  })

  it('a failed sweep re-queues its ingests and the adoption baseline', async () => {
    scanResults.push(new Error('container hiccup'))
    const sync = service()
    await sync.start()

    emitExternal({ path: 'notes/external.md' })
    await settleScan() // scan #1 (the sooner baseline timer wins): baseline + ingest — fails

    emitExternal({ path: 'notes/external.md' })
    await settleScan(INGEST_SETTLE_MS) // scan #2 retries both, on the ingest window

    expect(scanCalls()).toHaveLength(2)
    expect(scanCalls()[0]?.recordBaseline).toBe(true)
    expect(scanCalls()[1]?.recordBaseline).toBe(true)
    expect(scanCalls()[1]?.ingestedPaths).toContain('notes/external.md')
  })

  it('spaces arrival-driven sweeps apart during a download stream', async () => {
    const sync = service()
    await sync.start()
    await settleScan() // baseline ends ≈ t1

    // A first-sync shape: batches keep arriving. The first arrival lands
    // just after the baseline sweep — the debounce alone would sweep again
    // at +5s, but the minimum spacing holds it back…
    emitExternal({ path: 'notes/one.md' })
    await settleScan(5_100)
    expect(scanCalls()).toHaveLength(1)

    // …so a later batch folds into the SAME deferred sweep, which fires once
    // the spacing from the baseline's end has elapsed, carrying both ingests.
    emitExternal({ path: 'notes/two.md' })
    await settleScan(26_000)
    expect(scanCalls()).toHaveLength(2)
    expect(scanCalls()[1]?.ingestedPaths).toEqual(
      expect.arrayContaining(['notes/one.md', 'notes/two.md']),
    )
  })

  it('a conflict signal caught mid-sweep replays on the prompt window', async () => {
    scanResults.push('hang')
    const sync = service({ watch: true })
    await sync.start()
    await settleScan() // the baseline sweep starts — and hangs
    expect(scanCalls()).toHaveLength(1)

    // A conflict arrives while the sweep is still running: no timer arms,
    // the class is remembered.
    icloud.emitConflicts(['notes/a.md'])
    await settleScan()
    expect(scanCalls()).toHaveLength(1)

    // The sweep ends → the queued conflict replays promptly (1s), never on
    // the wide ingest window — and with its own candidates scope, not the
    // default full: replaying the O(N) version pass on overlap would undo
    // the scoping in exactly the case it exists for.
    releaseScan?.()
    await settleScan()
    expect(scanCalls()).toHaveLength(2)
    expect(scanCalls()[1]?.scope).toBe('candidates')
  })

  it('a mid-sweep resume keeps its full scope through the replay', async () => {
    scanResults.push('hang')
    const sync = service({ watch: true })
    await sync.start()
    await settleScan() // the baseline sweep starts — and hangs
    expect(scanCalls()).toHaveLength(1)

    // A resume (full) and a conflict signal (candidates) both land mid-sweep:
    // full is sticky through the merge, whatever the arrival order.
    icloud.emitConflicts(['notes/a.md'])
    activity.emitResume()
    releaseScan?.()
    await settleScan()
    expect(scanCalls()).toHaveLength(2)
    expect(scanCalls()[1]?.scope).toBe('full')
  })

  it('an arrival caught mid-sweep replays on the ingest spacing', async () => {
    scanResults.push('hang')
    const sync = service()
    await sync.start()
    await settleScan() // the baseline sweep starts — and hangs
    expect(scanCalls()).toHaveLength(1)

    emitExternal({ path: 'notes/late.md' })
    releaseScan?.()
    await settleScan() // prompt window only — a long sweep must not chain
    expect(scanCalls()).toHaveLength(1)

    await settleScan(INGEST_SETTLE_MS)
    expect(scanCalls()).toHaveLength(2)
    expect(scanCalls()[1]).toMatchObject({ scope: 'ingested', ingestedPaths: ['notes/late.md'] })
  })

  it('dirty open notes ride skipPaths so their conflicts defer', async () => {
    dirtyPaths = ['daily/2026-07-04.md']
    const sync = service()
    await sync.start()
    await settleScan()

    expect(scanCalls()[0]?.skipPaths).toEqual(['daily/2026-07-04.md'])
  })

  it('stops sweeping and listening once disposed', async () => {
    const sync = service()
    await sync.start()
    sync.dispose()
    active = null

    activity.emitResume()
    emitExternal({ path: 'notes/external.md' })
    await settleScan(INGEST_SETTLE_MS)

    expect(scanCalls()).toHaveLength(0)
    expect(clock.pendingTimers()).toBe(0)
    expect(fileChanges.listenerCount()).toEqual({ changes: 0, reconcile: 0 })
  })
})
