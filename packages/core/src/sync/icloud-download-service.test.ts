import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createTestLoggerService, type TestLoggerService } from '../testing/logger.ts'
import { createTestActivityPort, type TestActivityPort } from '../testing/shell.ts'
import { createTestICloudNativeService, type TestICloudNativeService } from '../testing/sync.ts'
import {
  createICloudDownloadService,
  type ICloudDownloadService,
} from './icloud-download-service.ts'

const ROOT = '/iCloud/Documents'

let clock: TestClockService
let activity: TestActivityPort
let logger: TestLoggerService
let icloud: TestICloudNativeService
let refreshIndex: ReturnType<typeof vi.fn<() => void>>
let active: ICloudDownloadService | null = null

beforeEach(() => {
  clock = createTestClockService({ now: Date.UTC(2026, 6, 4) })
  activity = createTestActivityPort()
  logger = createTestLoggerService()
  icloud = createTestICloudNativeService()
  refreshIndex = vi.fn<() => void>()
})

afterEach(() => {
  active?.dispose()
  active = null
})

function start(native: TestICloudNativeService = icloud): ICloudDownloadService {
  active = createICloudDownloadService(
    { icloudNative: native, activity, clock, logger },
    { root: ROOT, refreshIndex },
  )
  active.start()
  return active
}

/**
 * Note-scope download nudges: what an open or a resume requests first.
 */
function downloadCalls(): number {
  return icloud
    .calls()
    .filter((call) => call.method === 'downloadPending' && call.args[1] === 'notes').length
}

/**
 * Full-scope (assets included) download requests — the deferred bulk.
 */
function allScopeDownloadCalls(): number {
  return icloud
    .calls()
    .filter((call) => call.method === 'downloadPending' && call.args[1] === 'all').length
}

function countCalls(): number {
  return icloud.calls().filter((call) => call.method === 'pendingCount').length
}

/**
 * Let the pending native call settle without moving time.
 */
async function flush(): Promise<void> {
  await clock.advance(0)
}

/**
 * WKWebView fires `visibilitychange` and `focus` together on resume.
 */
function resumeBurst(): void {
  activity.emitVisible()
  activity.emitFocus()
}

describe('createICloudDownloadService', () => {
  it('nudges note downloads on start without repeating the open-time reconcile', async () => {
    start()
    await flush()

    expect(icloud.calls()[0]).toEqual({ method: 'downloadPending', args: [ROOT, 'notes'] })
    expect(downloadCalls()).toBe(1)
    // The graph open just synced the index against local disk; an immediate
    // second full pass would repeat that work on a large first sync.
    expect(refreshIndex).not.toHaveBeenCalled()
    // No notes pending — the deferred bulk (assets) may start right away.
    expect(allScopeDownloadCalls()).toBe(1)
  })

  it('polls the note count while pending and reconciles + starts assets when they land', async () => {
    icloud.setPendingCount(3)
    start()
    await flush()
    expect(downloadCalls()).toBe(1)
    expect(refreshIndex).not.toHaveBeenCalled()
    // Notes still pending — the bulk (assets) must wait its turn.
    expect(allScopeDownloadCalls()).toBe(0)

    // Still pending after one poll: no reconcile yet, keep waiting — and the
    // poll only counts, it never re-requests the downloads.
    await clock.advance(1000)
    expect(countCalls()).toBe(1)
    expect(icloud.calls().at(-1)).toEqual({ method: 'pendingCount', args: [ROOT, 'notes'] })
    expect(downloadCalls()).toBe(1)
    expect(refreshIndex).not.toHaveBeenCalled()

    // Notes finished: the next poll reconciles immediately — and only now
    // does the full-scope (assets) request fire.
    icloud.setPendingCount(0)
    await clock.advance(2000)
    expect(countCalls()).toBe(2)
    expect(refreshIndex).toHaveBeenCalledTimes(1)
    expect(allScopeDownloadCalls()).toBe(1)

    // Settled — no further polling.
    await clock.advance(60_000)
    expect(countCalls()).toBe(2)
    expect(clock.pendingTimers()).toBe(0)
  })

  it('backs the poll off geometrically while notes stay pending', async () => {
    icloud.setPendingCount(3)
    start()
    await flush()

    // First wait: the 1s floor.
    await clock.advance(999)
    expect(countCalls()).toBe(0)
    await clock.advance(1)
    expect(countCalls()).toBe(1)

    // Second wait doubles to 2s...
    await clock.advance(1999)
    expect(countCalls()).toBe(1)
    await clock.advance(1)
    expect(countCalls()).toBe(2)

    // ...then 4s, the ceiling.
    await clock.advance(3999)
    expect(countCalls()).toBe(2)
    await clock.advance(1)
    expect(countCalls()).toBe(3)

    await clock.advance(3999)
    expect(countCalls()).toBe(3)
    await clock.advance(1)
    expect(countCalls()).toBe(4)
  })

  it('stops polling when the app hides, and the next foreground restarts the drain', async () => {
    icloud.setPendingCount(3)
    start()
    await flush()
    expect(downloadCalls()).toBe(1)

    activity.setHidden(true)
    await clock.advance(1000)
    expect(countCalls()).toBe(0) // the armed tick bailed hidden

    await clock.advance(60_000)
    expect(countCalls()).toBe(0) // and nothing re-armed behind the webview

    activity.emitVisible()
    await flush()
    expect(downloadCalls()).toBe(2) // the resume renudges...
    await clock.advance(1000)
    expect(countCalls()).toBe(1) // ...and the poll starts over
  })

  it('a quick hide → show inside the dedupe window still restarts the drain', async () => {
    icloud.setPendingCount(3)
    start()
    await flush()
    expect(downloadCalls()).toBe(1)

    // Hide and let the armed tick bail — the poll is now abandoned…
    activity.setHidden(true)
    await clock.advance(1000)
    expect(countCalls()).toBe(0)

    // …and a return to visible only 200ms later (inside the 1.5s resume
    // dedupe) must not be swallowed, or nothing would be scheduled at all.
    await clock.advance(200)
    activity.emitVisible()
    await flush()
    expect(downloadCalls()).toBe(2)
    await clock.advance(1000)
    expect(countCalls()).toBe(1)
  })

  it('gives up polling at the limit with one final reconcile', async () => {
    icloud.setPendingCount(3)
    start()
    await flush()
    expect(refreshIndex).not.toHaveBeenCalled()

    // Never finishes downloading (a big asset on a slow link): the poll caps
    // out with a last reconcile instead of spinning forever.
    await clock.advance(120_000)
    expect(refreshIndex).toHaveBeenCalledTimes(1)
    // Well-bounded: one nudge, then at most limit/interval count polls.
    expect(downloadCalls()).toBe(1)
    expect(countCalls()).toBeLessThanOrEqual(21)
    expect(clock.pendingTimers()).toBe(0)
    // Notes never drained, so the bulk request stays deferred — it would
    // compete with the notes still downloading on the slow link.
    expect(allScopeDownloadCalls()).toBe(0)
  })

  it('a failed nudge never starts the bulk download', async () => {
    // `pending` defaulting to 0 on error must not read as "notes are in".
    const requested: string[] = []
    vi.spyOn(icloud, 'downloadPending').mockImplementation(async (_root, scope) => {
      requested.push(scope)
      throw new AppError('io', 'container hiccup')
    })
    start()
    await flush()

    expect(requested).toEqual(['notes'])
    expect(logger.getErrors()).toEqual([
      { message: 'iCloud download nudge failed:', cause: 'container hiccup' },
    ])
  })

  it('a failed poll is logged and reconciles what landed', async () => {
    icloud.setPendingCount(3)
    vi.spyOn(icloud, 'pendingCount').mockRejectedValue(new AppError('io', 'container hiccup'))
    start()
    await flush()
    await clock.advance(1000)

    expect(logger.getErrors()).toEqual([
      { message: 'iCloud pending poll failed:', cause: 'container hiccup' },
    ])
    expect(refreshIndex).toHaveBeenCalledTimes(1)
    expect(clock.pendingTimers()).toBe(0)
  })

  it('collapses the resume event burst into one refresh — which reconciles', async () => {
    start()
    await flush()
    expect(downloadCalls()).toBe(1)

    resumeBurst()
    await flush()
    expect(downloadCalls()).toBe(1) // deduped — still within the window
    expect(refreshIndex).not.toHaveBeenCalled()

    await clock.advance(2000)
    resumeBurst()
    await flush()
    expect(downloadCalls()).toBe(2) // a real later resume refreshes, once
    expect(refreshIndex).toHaveBeenCalledTimes(1) // and resume does reconcile
  })

  it('stops listening after dispose', async () => {
    const service = start()
    await flush()
    service.dispose()
    active = null

    await clock.advance(5000)
    resumeBurst()
    await flush()
    expect(downloadCalls()).toBe(1)
  })

  it('drops a nudge that settles after dispose', async () => {
    icloud.setPendingCount(3)
    const service = start()
    service.dispose()
    active = null
    await clock.advance(60_000)

    expect(countCalls()).toBe(0)
    expect(refreshIndex).not.toHaveBeenCalled()
  })
})
