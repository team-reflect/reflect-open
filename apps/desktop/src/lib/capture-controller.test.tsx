import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DrainCaptureInboxInput,
  DrainCaptureInboxOutcome,
  FileChange,
  ReconcileCaptureEnrichmentInput,
  ReconcileCaptureEnrichmentOutcome,
} from '@reflect/core'
import { createCaptureController, type CaptureController } from './capture-controller'

const drainCaptureInbox = vi.hoisted(() =>
  vi.fn<(input: DrainCaptureInboxInput) => Promise<DrainCaptureInboxOutcome>>(),
)
const reconcileCaptureEnrichment = vi.hoisted(() =>
  vi.fn<(input: ReconcileCaptureEnrichmentInput) => Promise<ReconcileCaptureEnrichmentOutcome>>(),
)
const subscribeFileChanges = vi.hoisted(() =>
  vi.fn<(handler: (changes: readonly FileChange[]) => void) => Promise<() => void>>(),
)
const failOperation = vi.hoisted(() => vi.fn<(message: string) => void>())

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  drainCaptureInbox,
  reconcileCaptureEnrichment,
  subscribeFileChanges,
  hasBridge: () => true,
}))
vi.mock('@/lib/provider-fetch', () => ({
  providerFetch: vi.fn(),
}))
vi.mock('@/lib/operations', () => ({
  startOperation: () => ({ progress: vi.fn(), done: vi.fn(), fail: failOperation }),
}))

const NO_PROVIDERS = { providers: [], defaultProviderId: null }

function drained(overrides: Partial<DrainCaptureInboxOutcome> = {}): DrainCaptureInboxOutcome {
  return { pending: 0, drained: 0, deduped: 0, invalid: 0, stopped: null, ...overrides }
}

function enriched(
  overrides: Partial<ReconcileCaptureEnrichmentOutcome> = {},
): ReconcileCaptureEnrichmentOutcome {
  return { pending: 0, enriched: 0, skipped: 0, stopped: null, ...overrides }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let controller: CaptureController | null = null

function create(relaySharedInbox?: () => Promise<number>): CaptureController {
  controller = createCaptureController({
    generation: 3,
    getProviders: () => NO_PROVIDERS,
    ...(relaySharedInbox ? { relaySharedInbox } : {}),
  })
  return controller
}

beforeEach(() => {
  vi.clearAllMocks()
  drainCaptureInbox.mockResolvedValue(drained())
  reconcileCaptureEnrichment.mockResolvedValue(enriched())
  subscribeFileChanges.mockResolvedValue(vi.fn())
})

afterEach(() => {
  controller?.dispose()
  controller = null
})

describe('createCaptureController (shared-inbox relay)', () => {
  it('relays the shared inbox BEFORE the drain, every pass', async () => {
    const order: string[] = []
    const relay = vi.fn(async () => {
      order.push('relay')
      return 1
    })
    drainCaptureInbox.mockImplementation(async () => {
      order.push('drain')
      return drained()
    })

    create(relay).start()
    await flush()

    expect(order).toEqual(['relay', 'drain'])

    controller?.schedule()
    await flush()
    expect(order).toEqual(['relay', 'drain', 'relay', 'drain'])
  })

  it('still drains when the relay fails, surfacing the failure once', async () => {
    const relay = vi.fn<() => Promise<number>>().mockRejectedValue(new Error('container gone'))

    create(relay).start()
    await flush()

    expect(drainCaptureInbox).toHaveBeenCalledTimes(1)
    expect(failOperation).toHaveBeenCalledTimes(1)

    // The same failure on a retry pass must not re-toast.
    controller?.schedule()
    await flush()
    expect(drainCaptureInbox).toHaveBeenCalledTimes(2)
    expect(failOperation).toHaveBeenCalledTimes(1)
  })

  it('without a relay, passes run drain-then-enrich only', async () => {
    create().start()
    await flush()

    expect(drainCaptureInbox).toHaveBeenCalledTimes(1)
    expect(reconcileCaptureEnrichment).toHaveBeenCalledTimes(1)
    expect(failOperation).not.toHaveBeenCalled()
  })

  it('schedules a pass when the app becomes visible again (mobile resume)', async () => {
    const relay = vi.fn(async () => 0)
    create(relay).start()
    await flush()
    expect(drainCaptureInbox).toHaveBeenCalledTimes(1)

    document.dispatchEvent(new Event('visibilitychange'))
    await flush()

    expect(drainCaptureInbox).toHaveBeenCalledTimes(2)
  })

  it('does not listen for visibility without a relay (desktop)', async () => {
    create().start()
    await flush()
    expect(drainCaptureInbox).toHaveBeenCalledTimes(1)

    document.dispatchEvent(new Event('visibilitychange'))
    await flush()

    expect(drainCaptureInbox).toHaveBeenCalledTimes(1)
  })

  it('stops listening for visibility after dispose', async () => {
    const relay = vi.fn(async () => 0)
    create(relay).start()
    await flush()
    controller?.dispose()

    document.dispatchEvent(new Event('visibilitychange'))
    await flush()

    expect(drainCaptureInbox).toHaveBeenCalledTimes(1)
  })
})
