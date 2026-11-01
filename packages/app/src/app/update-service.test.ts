import { afterEach, describe, expect, it } from 'vitest'
import {
  createTestClockService,
  createTestLoggerService,
  createTestPlatformService,
  type TestClockService,
  type TestLoggerService,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import {
  createTestUpdaterAdapter,
  createTestUpdateService,
  type TestUpdaterAdapter,
  type TestUpdaterOptions,
} from '../testing/update.ts'
import { createTestWindowService } from '../testing/window.ts'
import { createUpdateService, type UpdateService } from './update-service.ts'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

interface Setup {
  service: UpdateService
  updater: TestUpdaterAdapter
  clock: TestClockService
  logger: TestLoggerService
}

let current: UpdateService | null = null

function setup(
  options?: TestUpdaterOptions,
  extra?: { platform?: TestPlatformOptions; windowLabel?: string },
): Setup {
  const updater = createTestUpdaterAdapter(options)
  const clock = createTestClockService()
  const logger = createTestLoggerService()
  const service = createUpdateService({
    updater,
    clock,
    logger,
    platform: createTestPlatformService(extra?.platform),
    window: createTestWindowService(
      extra?.windowLabel === undefined ? undefined : { label: extra.windowLabel },
    ),
  })
  current = service
  return { service, updater, clock, logger }
}

function checkCount(updater: TestUpdaterAdapter): number {
  return updater.calls.filter((call) => call === 'check').length
}

afterEach(() => {
  current?.dispose()
  current = null
})

describe('createUpdateService', () => {
  it('is supported only in a desktop native shell', () => {
    expect(setup().service.supported).toBe(true)
    expect(setup(undefined, { platform: { isNativeShell: false } }).service.supported).toBe(false)
    expect(setup(undefined, { platform: { appPlatform: 'ios' } }).service.supported).toBe(false)
  })

  it('starts idle and does not check until started', () => {
    const { service, updater } = setup()
    expect(service.getState()).toEqual({ phase: 'idle' })
    expect(updater.calls).toEqual([])
  })

  it('does not auto-check where updates are unsupported or outside the main window', async () => {
    const unsupported = setup(undefined, { platform: { isNativeShell: false } })
    unsupported.service.start()
    await unsupported.clock.advance(SIX_HOURS_MS)
    expect(unsupported.updater.calls).toEqual([])

    const secondary = setup(undefined, { windowLabel: 'note-1' })
    secondary.service.start()
    await secondary.clock.advance(SIX_HOURS_MS)
    expect(secondary.updater.calls).toEqual([])
  })

  it('auto-check finds an update and lands on available', async () => {
    const { service, clock } = setup({ available: { version: '0.3.0' } })
    service.start()
    await clock.advance(0)
    expect(service.getState()).toEqual({ phase: 'available', version: '0.3.0' })
  })

  it('auto-check failures are silent: back to idle, app unaffected', async () => {
    const { service, clock, logger } = setup({ failCheck: 'offline' })
    service.start()
    await clock.advance(0)
    expect(service.getState()).toEqual({ phase: 'idle' })
    expect(logger.getWarnings()).toEqual([
      { message: 'update check failed (ignored)', cause: new Error('offline') },
    ])
  })

  it('auto-check repeats every six hours', async () => {
    const { service, updater, clock } = setup()
    service.start()
    await clock.advance(0)
    expect(checkCount(updater)).toBe(1)
    await clock.advance(SIX_HOURS_MS - 1)
    expect(checkCount(updater)).toBe(1)
    await clock.advance(1)
    expect(checkCount(updater)).toBe(2)
    await clock.advance(SIX_HOURS_MS)
    expect(checkCount(updater)).toBe(3)
  })

  it('a second start does not add a second schedule', async () => {
    const { service, updater, clock } = setup()
    service.start()
    service.start()
    await clock.advance(SIX_HOURS_MS)
    expect(checkCount(updater)).toBe(2)
  })

  it('manual check surfaces up-to-date and errors', async () => {
    const { service, updater } = setup()
    await service.checkNow()
    expect(service.getState()).toEqual({ phase: 'upToDate' })

    updater.configure({ failCheck: 'release endpoint unreachable' })
    await service.checkNow()
    expect(service.getState()).toEqual({
      phase: 'error',
      message: 'release endpoint unreachable',
      during: 'check',
    })
  })

  it('install reports progress and lands on ready', async () => {
    const { service, updater } = setup({ available: { version: '0.3.0' }, holdInstall: true })
    const states: string[] = []
    service.subscribe(() => {
      const state = service.getState()
      if (state.phase === 'downloading') {
        states.push(`downloading:${state.percent}`)
      }
    })
    await service.checkNow()
    const installing = service.install()
    expect(service.getState()).toEqual({ phase: 'downloading', version: '0.3.0', percent: null })
    updater.progress(50)
    expect(service.getState()).toEqual({ phase: 'downloading', version: '0.3.0', percent: 50 })
    updater.finishInstall()
    await installing
    expect(states).toContain('downloading:50')
    expect(states).toContain('downloading:100')
    expect(service.getState()).toEqual({ phase: 'ready', version: '0.3.0' })
  })

  it('a rejected payload (bad signature) surfaces as a plain error', async () => {
    const { service } = setup({
      available: { version: '0.3.0' },
      failInstall: 'signature verification failed',
    })
    await service.checkNow()
    await service.install()
    expect(service.getState()).toEqual({
      phase: 'error',
      message: 'signature verification failed',
      during: 'install',
    })
  })

  it('a check resolving after an install starts cannot clobber the download', async () => {
    const { service, updater } = setup({ available: { version: '0.3.0' } })
    await service.checkNow()

    // A second check hangs in flight while the found update gets installed.
    const releaseSecond = updater.holdNextCheck()
    updater.configure({})
    const second = service.checkNow()
    await service.install()
    expect(service.getState()).toEqual({ phase: 'ready', version: '0.3.0' })

    releaseSecond()
    await second
    expect(service.getState()).toEqual({ phase: 'ready', version: '0.3.0' })
  })

  it('a silent re-check answering "no update" keeps an already-found update available', async () => {
    const { service, updater, clock } = setup({ available: { version: '0.3.0' } })
    service.start()
    await clock.advance(0)
    expect(service.getState()).toEqual({ phase: 'available', version: '0.3.0' })

    // A silent check never enters a visible "checking" phase.
    const phases: string[] = []
    service.subscribe(() => {
      phases.push(service.getState().phase)
    })

    // e.g. the release is mid-edit and the manifest transiently lists nothing.
    updater.configure({})
    await clock.advance(SIX_HOURS_MS)
    expect(checkCount(updater)).toBe(2)
    expect(service.getState()).toEqual({ phase: 'available', version: '0.3.0' })
    expect(phases).not.toContain('checking')

    await service.install()
    expect(service.getState()).toEqual({ phase: 'ready', version: '0.3.0' })
  })

  it('a failed re-check keeps an already-found update available', async () => {
    const { service, updater, clock } = setup({ available: { version: '0.3.0' } })
    service.start()
    await clock.advance(0)

    updater.configure({ failCheck: 'offline' })
    await clock.advance(SIX_HOURS_MS)
    expect(checkCount(updater)).toBe(2)
    expect(service.getState()).toEqual({ phase: 'available', version: '0.3.0' })
  })

  it('a re-check that finds an update closes the one it replaces', async () => {
    const { service, updater, clock } = setup({ available: { version: '0.3.0' } })
    service.start()
    await clock.advance(0)

    updater.configure({ available: { version: '0.3.1' } })
    await clock.advance(SIX_HOURS_MS)
    expect(updater.calls).toEqual(['check', 'check', 'close'])
    expect(service.getState()).toEqual({ phase: 'available', version: '0.3.1' })
  })

  it('a manual check answering "no update" closes the found update', async () => {
    const { service, updater } = setup({ available: { version: '0.3.0' } })
    await service.checkNow()

    updater.configure({})
    await service.checkNow()
    expect(updater.calls).toEqual(['check', 'check', 'close'])
    expect(service.getState()).toEqual({ phase: 'upToDate' })
  })

  it('a check resolving after an install starts closes the update it found', async () => {
    const { service, updater } = setup({ available: { version: '0.3.0' } })
    await service.checkNow()

    const releaseSecond = updater.holdNextCheck()
    const second = service.checkNow()
    await service.install()
    releaseSecond()
    await second
    expect(updater.calls).toEqual(['check', 'check', 'downloadAndInstall', 'close'])
    expect(service.getState()).toEqual({ phase: 'ready', version: '0.3.0' })
  })

  it('install without a found update is a no-op', async () => {
    const { service, updater } = setup()
    await service.install()
    expect(service.getState()).toEqual({ phase: 'idle' })
    expect(updater.calls).toEqual([])
  })

  it('restart relaunches into the installed update', async () => {
    const { service, updater } = setup()
    await service.restart()
    expect(updater.calls).toEqual(['relaunch'])
  })

  it('retryAction installs again after a failed install', async () => {
    const { service, updater } = setup({ available: { version: '0.3.0' }, failInstall: 'boom' })
    await service.checkNow()
    await service.install()
    updater.configure({ available: { version: '0.3.0' } })
    await service.retryAction()
    expect(updater.calls).toEqual(['check', 'downloadAndInstall', 'downloadAndInstall'])
    expect(service.getState()).toEqual({ phase: 'ready', version: '0.3.0' })
  })

  it('retryAction checks again after a failed check', async () => {
    const { service, updater } = setup({ failCheck: 'offline' })
    await service.checkNow()
    updater.configure({})
    await service.retryAction()
    expect(updater.calls).toEqual(['check', 'check'])
    expect(service.getState()).toEqual({ phase: 'upToDate' })
  })

  it('dispose stops the interval', async () => {
    const { service, updater, clock } = setup()
    service.start()
    await clock.advance(0)
    service.dispose()
    await clock.advance(SIX_HOURS_MS * 2)
    expect(checkCount(updater)).toBe(1)
    expect(clock.pendingTimers()).toBe(0)
  })
})

describe('createUpdateService without an updater', () => {
  it('is unsupported and idle', async () => {
    const service = createUpdateService({
      updater: undefined,
      clock: createTestClockService(),
      logger: createTestLoggerService(),
      platform: createTestPlatformService({ isNativeShell: true }),
      window: createTestWindowService(),
    })
    service.start()
    await service.checkNow()
    expect(service.supported).toBe(false)
    expect(service.getState()).toEqual({ phase: 'idle' })
  })
})
describe('createTestUpdateService', () => {
  it('routes retryAction by the failed phase', async () => {
    const service = createTestUpdateService({ phase: 'error', message: 'x', during: 'install' })
    await service.retryAction()
    service.setState({ phase: 'error', message: 'x', during: 'check' })
    await service.retryAction()
    expect(service.calls).toEqual(['retryAction', 'install', 'retryAction', 'checkNow'])
  })
})
