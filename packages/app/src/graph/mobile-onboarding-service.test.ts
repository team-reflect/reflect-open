import { describe, expect, it, vi } from 'vitest'
import type { MobileStorageInfo, Settings } from '@reflect/core'
import { AppError } from '@reflect/core'
import {
  createTestActivityPort,
  createTestClockService,
  createTestGraphSessionService,
  createTestIpcBridgeService,
  createTestLoggerService,
  createTestMobileStorageService,
  createTestPlatformService,
  createTestSettingsService,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import { createMobileOnboardingService } from './mobile-onboarding-service.ts'

/**
 * The fixed mobile roots the test storage reports.
 */
const MOBILE_ROOT = '/Documents'
const ICLOUD_ROOT = '/iCloud/Documents'
/**
 * Where a fresh iCloud graph is created when the container is empty.
 */
const ICLOUD_GRAPH = `${ICLOUD_ROOT}/Notes`

const STORAGE: MobileStorageInfo = {
  localRoot: MOBILE_ROOT,
  icloudDocumentsRoot: ICLOUD_ROOT,
  icloudGraphRoots: [],
}

interface SetupOptions {
  settings?: Partial<Settings>
  storage?: MobileStorageInfo
  platform?: TestPlatformOptions
  /**
   * Replaces the storage resolve; receives the 1-based call number.
   */
  resolve?: (call: number) => Promise<MobileStorageInfo>
}

/**
 * An onboarding service on an iOS graph session over fakes.
 */
function setup(options?: SetupOptions) {
  const failures = { open: false }
  const opened: string[] = []
  let generation = 0
  const ipc = createTestIpcBridgeService({
    commands: {
      recent_graphs: () => [],
      graph_open: (args) => {
        if (failures.open) {
          throw new AppError('io', 'cannot open graph')
        }
        const root = String(args['path'])
        opened.push(root)
        generation += 1
        return { root, name: root.split('/').findLast(Boolean) ?? '', generation }
      },
    },
  })
  const logger = createTestLoggerService()
  const clock = createTestClockService()
  const platform = createTestPlatformService({ appPlatform: 'ios', ...options?.platform })
  const storage = createTestMobileStorageService({ storage: options?.storage ?? STORAGE })
  let resolveCalls = 0
  const customResolve = options?.resolve
  const resolveStorage = storage.resolve.bind(storage)
  vi.spyOn(storage, 'resolve').mockImplementation(async (): Promise<MobileStorageInfo> => {
    resolveCalls += 1
    return customResolve === undefined ? await resolveStorage() : await customResolve(resolveCalls)
  })
  const mobileStorage = storage
  const settings = createTestSettingsService(options?.settings)
  const graphSession = createTestGraphSessionService({ ipc, mobileStorage, logger })
  const activity = createTestActivityPort()
  let focusSubscriptions = 0
  const subscribeFocus = activity.subscribeFocus.bind(activity)
  activity.subscribeFocus = (listener) => {
    focusSubscriptions += 1
    return subscribeFocus(listener)
  }
  const service = createMobileOnboardingService({
    mobileStorage,
    settings,
    graphSession,
    platform,
    clock,
    activity,
    logger,
  })
  return {
    service,
    graphSession,
    settings,
    activity,
    focusSubscriptions: () => focusSubscriptions,
    storage,
    clock,
    logger,
    failures,
    opened,
    resolveCalls: () => resolveCalls,
  }
}

/**
 * Boot the session and the onboarding, and wait for the onboarding screen.
 */
async function bootFreshInstall(options?: SetupOptions) {
  const context = setup(options)
  context.graphSession.attach()
  const stop = context.service.boot()
  await expect.poll(() => context.service.getState().needsOnboarding).toBe(true)
  await expect.poll(() => context.service.getState().resolving).toBe(false)
  return { ...context, stop }
}

describe('MobileOnboardingService warm', () => {
  it('starts the resolve once and hands it to exactly one boot', async () => {
    const context = setup()
    context.service.warm()
    context.service.warm() // idempotent: still one resolve
    expect(context.resolveCalls()).toBe(1)

    const stop = context.service.boot()
    await expect.poll(() => context.service.getState().storageInfo).toEqual(STORAGE)
    expect(context.resolveCalls()).toBe(1)
    stop()

    // Consume-once: the slot is a boot hint, not a cache — a second boot
    // must fall back to its own fresh call.
    context.service.boot()
    expect(context.resolveCalls()).toBe(2)
  })

  it('resolves at boot when nothing was warmed', () => {
    const context = setup()
    expect(context.resolveCalls()).toBe(0)
    context.service.boot()
    expect(context.resolveCalls()).toBe(1)
  })

  it('does not surface an unhandled rejection when the warm fails untaken', async () => {
    const context = setup({
      resolve: () => Promise.reject(new Error('no container')),
    })
    context.service.warm()
    // Settle the rejection with no taker attached; the service's internal
    // catch keeps it from escaping as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

describe('MobileOnboardingService boot', () => {
  it('does nothing on desktop', async () => {
    const context = setup({ platform: { appPlatform: 'desktop' } })
    context.service.boot()
    await Promise.resolve()
    expect(context.resolveCalls()).toBe(0)
    expect(context.service.getState()).toEqual({
      needsOnboarding: false,
      storageInfo: null,
      resolving: false,
      kind: null,
    })
  })

  it('defers opening the fixed roots and shows onboarding on a fresh install', async () => {
    const context = await bootFreshInstall()

    expect(context.graphSession.getState().status).toBe('choosing')
    expect(context.graphSession.getState().graph).toBeNull()
    expect(context.service.getState().storageInfo).toEqual(STORAGE)
    // The roots must stay untouched until the user chooses — the GitHub clone
    // path needs the local one empty (`git_clone` refuses a non-empty
    // directory), and opening the iCloud one would bootstrap + seed it.
    expect(context.opened).toEqual([])
    expect(context.storage.createdGraphs()).toEqual([])
  })

  it('shows onboarding immediately while the iCloud container is still resolving', async () => {
    let releaseStorage: () => void = () => {}
    const context = setup({
      resolve: async () => {
        await new Promise<void>((resolve) => {
          releaseStorage = resolve
        })
        return STORAGE
      },
    })
    context.service.boot()

    // Onboarding must not wait on the container lookup — on a fresh install
    // that call can take a long time, and it used to hold the whole app on a
    // bare "Loading…" screen.
    await expect.poll(() => context.service.getState().needsOnboarding).toBe(true)
    expect(context.service.getState().resolving).toBe(true)
    // The sandbox root seeds instantly so the on-device/GitHub paths work.
    await expect.poll(() => context.service.getState().storageInfo?.localRoot).toBe(MOBILE_ROOT)
    expect(context.service.getState().storageInfo?.icloudDocumentsRoot).toBeNull()

    releaseStorage()
    await expect.poll(() => context.service.getState().resolving).toBe(false)
    expect(context.service.getState().storageInfo?.icloudDocumentsRoot).toBe(ICLOUD_ROOT)
  })

  it('retries a failed container resolve after 2 and 8 seconds, then gives up', async () => {
    const context = setup({
      resolve: () => Promise.reject(new Error('no container')),
    })
    context.service.boot()
    await expect.poll(() => context.logger.getErrors()).toHaveLength(1)
    expect(context.service.getState().resolving).toBe(true)

    await context.clock.advance(2_000)
    expect(context.resolveCalls()).toBe(2)
    expect(context.service.getState().resolving).toBe(true)

    await context.clock.advance(8_000)
    expect(context.resolveCalls()).toBe(3)
    expect(context.service.getState().resolving).toBe(false)
    expect(context.service.getState().storageInfo).toEqual({
      localRoot: MOBILE_ROOT,
      icloudDocumentsRoot: null,
      icloudGraphRoots: [],
    })
    expect(context.logger.getErrors()).toEqual([
      { message: 'mobile storage resolution failed:', cause: 'no container' },
      { message: 'mobile storage resolution failed:', cause: 'no container' },
      { message: 'mobile storage resolution failed:', cause: 'no container' },
    ])
    expect(context.clock.pendingTimers()).toBe(0)
  })

  it('drops the pending retry once the boot is stopped', async () => {
    const context = setup({
      resolve: () => Promise.reject(new Error('no container')),
    })
    const stop = context.service.boot()
    await expect.poll(() => context.clock.pendingTimers()).toBe(1)

    stop()

    expect(context.clock.pendingTimers()).toBe(0)
  })

  it('opens the local root directly when onboarded without a storage kind (pre-Plan-21 installs)', async () => {
    const context = setup({ settings: { mobileOnboarded: true } })
    context.service.boot()

    await expect.poll(() => context.graphSession.getState().status).toBe('ready')
    expect(context.service.getState().needsOnboarding).toBe(false)
    expect(context.graphSession.getState().graph?.root).toBe(MOBILE_ROOT)
    expect(context.service.getState().kind).toBe('local')
    // The full storage info resolves in the background for the switcher.
    await expect.poll(() => context.service.getState().storageInfo).toEqual(STORAGE)
  })

  it('opens the first container graph when onboarded onto iCloud with no saved name (pre-multi-graph installs)', async () => {
    const context = setup({
      settings: { mobileOnboarded: true, mobileStorage: 'icloud' },
      storage: { ...STORAGE, icloudGraphRoots: [ICLOUD_GRAPH] },
    })
    context.service.boot()

    await expect.poll(() => context.graphSession.getState().status).toBe('ready')
    expect(context.graphSession.getState().graph?.root).toBe(ICLOUD_GRAPH)
    expect(context.service.getState().kind).toBe('icloud')
  })

  it('opens the graph named in settings when the container holds several', async () => {
    const context = setup({
      settings: { mobileOnboarded: true, mobileStorage: 'icloud', mobileGraphName: 'Work' },
      storage: { ...STORAGE, icloudGraphRoots: [`${ICLOUD_ROOT}/Notes`, `${ICLOUD_ROOT}/Work`] },
    })
    context.service.boot()

    await expect.poll(() => context.graphSession.getState().status).toBe('ready')
    expect(context.graphSession.getState().graph?.root).toBe(`${ICLOUD_ROOT}/Work`)
  })

  it('retries the head-start resolve once before opening an iCloud graph', async () => {
    const context = setup({
      settings: { mobileOnboarded: true, mobileStorage: 'icloud' },
      resolve: (call) => {
        if (call === 1) {
          return Promise.reject(new Error('transient'))
        }
        return Promise.resolve({ ...STORAGE, icloudGraphRoots: [ICLOUD_GRAPH] })
      },
    })
    context.service.warm()
    context.service.boot()

    await expect.poll(() => context.graphSession.getState().status).toBe('ready')
    expect(context.resolveCalls()).toBe(2)
    expect(context.graphSession.getState().graph?.root).toBe(ICLOUD_GRAPH)
  })

  it('parks on an honest error when the iCloud graph is unreachable (signed out)', async () => {
    const context = setup({
      settings: { mobileOnboarded: true, mobileStorage: 'icloud' },
      storage: { localRoot: MOBILE_ROOT, icloudDocumentsRoot: null, icloudGraphRoots: [] },
    })
    context.service.boot()

    await expect.poll(() => context.graphSession.getState().status).toBe('choosing')
    // No silent fallback to the empty local root — that would look like the
    // user's notes vanished. The error names the fix instead.
    expect(context.service.getState().needsOnboarding).toBe(false)
    expect(context.graphSession.getState().error).toMatch(/iCloud isn’t available/)
    expect(context.opened).toEqual([])
  })

  it('parks on the error when the settings fail to load', async () => {
    const context = setup()
    context.settings.failLoad()
    context.service.boot()

    await expect.poll(() => context.graphSession.getState().status).toBe('choosing')
    expect(context.graphSession.getState().error).toBe('Couldn’t load your settings.')
    expect(context.service.getState().needsOnboarding).toBe(false)
  })

  it('reloads failed settings when the app is focused, then shows onboarding', async () => {
    const context = setup()
    context.settings.failLoad()
    context.service.boot()
    await expect
      .poll(() => context.graphSession.getState().error)
      .toBe('Couldn’t load your settings.')

    context.settings.ipc.onCommand('settings_load', () => ({}))
    context.activity.emitFocus()

    await expect.poll(() => context.service.getState().needsOnboarding).toBe(true)
    expect(context.settings.status()).toBe('loaded')
  })

  it('reloads failed settings when the app turns visible, then opens the graph', async () => {
    const context = setup()
    context.settings.failLoad()
    context.service.boot()
    await expect
      .poll(() => context.graphSession.getState().error)
      .toBe('Couldn’t load your settings.')

    context.settings.ipc.onCommand('settings_load', () => ({
      mobileOnboarded: true,
      mobileStorage: 'local',
    }))
    context.activity.emitVisible()
    context.activity.emitFocus()

    await expect.poll(() => context.opened).toEqual([MOBILE_ROOT])
    expect(context.service.getState().kind).toBe('local')
  })

  it('keeps retrying on each return while the settings still fail to load', async () => {
    const context = setup()
    context.settings.failLoad()
    context.service.boot()
    const loads = () =>
      context.settings.ipc.calls().filter((call) => call.command === 'settings_load').length
    await expect.poll(context.focusSubscriptions).toBe(1)
    expect(loads()).toBe(1)

    context.activity.emitFocus()
    await expect.poll(context.focusSubscriptions).toBe(2)
    context.activity.emitFocus()
    await expect.poll(context.focusSubscriptions).toBe(3)
    expect(loads()).toBe(3)
    expect(context.graphSession.getState().error).toBe('Couldn’t load your settings.')
  })

  it('stops retrying failed settings once the boot is stopped', async () => {
    const context = setup()
    context.settings.failLoad()
    const stop = context.service.boot()
    await expect
      .poll(() => context.graphSession.getState().error)
      .toBe('Couldn’t load your settings.')
    stop()

    context.settings.ipc.onCommand('settings_load', () => ({}))
    context.activity.emitFocus()
    await context.clock.advance(0)

    expect(context.settings.status()).toBe('failed')
  })

  it('opens nothing once the boot is stopped', async () => {
    const context = setup({ settings: { mobileOnboarded: true } })
    const stop = context.service.boot()
    stop()

    await context.settings.whenLoaded()
    await context.clock.advance(0)
    expect(context.opened).toEqual([])
    expect(context.graphSession.getState().status).toBe('loading')
  })
})

describe('MobileOnboardingService completeOnboarding', () => {
  it('opens the local root and records flag + kind on completeOnboarding(local)', async () => {
    const context = await bootFreshInstall()

    await context.service.completeOnboarding('local')

    expect(context.graphSession.getState().status).toBe('ready')
    expect(context.service.getState().needsOnboarding).toBe(false)
    expect(context.graphSession.getState().graph?.root).toBe(MOBILE_ROOT)
    expect(context.service.getState().kind).toBe('local')
    // The gate is persisted so later launches open the root directly.
    await context.settings.flush()
    expect(context.settings.saves().at(-1)).toMatchObject({
      mobileOnboarded: true,
      mobileStorage: 'local',
      mobileGraphName: '',
    })
  })

  it('creates the default container graph and records kind + name on completeOnboarding(icloud)', async () => {
    const context = await bootFreshInstall()

    await context.service.completeOnboarding('icloud')

    expect(context.graphSession.getState().status).toBe('ready')
    expect(context.graphSession.getState().graph?.root).toBe(ICLOUD_GRAPH)
    expect(context.service.getState().kind).toBe('icloud')
    expect(context.storage.createdGraphs()).toEqual([ICLOUD_GRAPH])
    await context.settings.flush()
    // WHICH graph is remembered by name — never by container path.
    expect(context.settings.saves().at(-1)).toMatchObject({
      mobileOnboarded: true,
      mobileStorage: 'icloud',
      mobileGraphName: 'Notes',
    })
  })

  it('opens the explicitly chosen container graph and persists its name', async () => {
    const context = await bootFreshInstall({
      storage: { ...STORAGE, icloudGraphRoots: [`${ICLOUD_ROOT}/Notes`, `${ICLOUD_ROOT}/Work`] },
    })

    await context.service.completeOnboarding('icloud', `${ICLOUD_ROOT}/Work`)

    expect(context.graphSession.getState().status).toBe('ready')
    expect(context.graphSession.getState().graph?.root).toBe(`${ICLOUD_ROOT}/Work`)
    expect(context.storage.createdGraphs()).toEqual([])
    await context.settings.flush()
    expect(context.settings.saves().at(-1)?.mobileGraphName).toBe('Work')
  })

  it('creates an explicitly named iCloud graph when it is not already known', async () => {
    const journalRoot = `${ICLOUD_ROOT}/Journal`
    const context = await bootFreshInstall({
      storage: { ...STORAGE, icloudGraphRoots: [`${ICLOUD_ROOT}/Notes`] },
    })

    await context.service.completeOnboarding('icloud', journalRoot)

    expect(context.graphSession.getState().status).toBe('ready')
    expect(context.storage.createdGraphs()).toEqual([journalRoot])
    await context.settings.flush()
    expect(context.settings.saves().at(-1)?.mobileGraphName).toBe('Journal')
  })

  it('rejects completeOnboarding(icloud) when iCloud is unavailable', async () => {
    const context = await bootFreshInstall({
      storage: { localRoot: MOBILE_ROOT, icloudDocumentsRoot: null, icloudGraphRoots: [] },
    })

    await expect(context.service.completeOnboarding('icloud')).rejects.toThrow(
      /iCloud Drive isn’t available/,
    )
    expect(context.service.getState().needsOnboarding).toBe(true)
    expect(context.settings.saves()).toEqual([])
  })

  it('rejects when no storage root is known yet', async () => {
    const context = setup()

    await expect(context.service.completeOnboarding('local')).rejects.toThrow(
      'No graph folder available.',
    )
  })

  it('keeps onboarding up (flag unset) when the open fails, for an in-app retry', async () => {
    const context = await bootFreshInstall()

    context.failures.open = true
    await expect(context.service.completeOnboarding('local')).rejects.toThrow(
      'Couldn’t open your notes — please try again.',
    )

    // Open failed → onboarding stays up (the screen surfaces the thrown error)
    // for an in-app retry, and the flag is never persisted — no way to get
    // stranded past onboarding on a broken open.
    expect(context.service.getState().needsOnboarding).toBe(true)
    expect(context.graphSession.getState().graph).toBeNull()
    expect(context.settings.saves()).toEqual([])
  })

  it('tells subscribers about every change', async () => {
    const context = setup()
    let changes = 0
    const unlisten = context.service.subscribe(() => {
      changes += 1
    })
    context.service.boot()
    await expect.poll(() => context.service.getState().resolving).toBe(false)
    await expect.poll(() => context.service.getState().needsOnboarding).toBe(true)
    const seen = changes
    expect(seen).toBeGreaterThan(0)

    unlisten()
    await context.service.completeOnboarding('local')
    expect(changes).toBe(seen)
  })
})
