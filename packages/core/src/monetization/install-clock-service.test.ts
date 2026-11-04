import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppPlatform } from '../ports/platform-facts.ts'
import type { SecretStoreService } from '../secrets/secret-store-service.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestPlatformService } from '../testing/platform.ts'
import { createTestSecretStoreService, type TestSecretStoreService } from '../testing/secrets.ts'
import { createTestActivityPort, type TestActivityPort } from '../testing/shell.ts'
import {
  INSTALL_CLOCK_SECRET,
  createInstallClockService,
  type InstallClockService,
} from './install-clock-service.ts'
import { DAY_MS, PAYWALL_HIDDEN_DAYS, PAYWALL_SKIPPABLE_DAYS } from './paywall-phase.ts'

const NOW = Date.UTC(2026, 10, 4, 12)
const HOUR_MS = 60 * 60 * 1000

let activity: TestActivityPort
let clock: TestClockService
let secrets: TestSecretStoreService

beforeEach(() => {
  activity = createTestActivityPort()
  clock = createTestClockService({ now: NOW })
  secrets = createTestSecretStoreService()
})

function service(options?: {
  secretStore?: SecretStoreService
  appPlatform?: AppPlatform
}): InstallClockService {
  return createInstallClockService({
    secretStore: options?.secretStore ?? secrets,
    clock,
    activity,
    platform: createTestPlatformService({ appPlatform: options?.appPlatform ?? 'ios' }),
    logger: createTestLoggerService(),
  })
}

function stored(): unknown {
  return JSON.parse(secrets.snapshot()[INSTALL_CLOCK_SECRET] ?? 'null')
}

function withStored(firstLaunchAt: number, lastSeenAt = firstLaunchAt): void {
  secrets = createTestSecretStoreService({
    [INSTALL_CLOCK_SECRET]: JSON.stringify({ firstLaunchAt, lastSeenAt }),
  })
}

async function settled(installClock: InstallClockService): Promise<void> {
  installClock.subscribe(() => {})
  await vi.waitFor(() => expect(installClock.get().isLoading).toBe(false))
}

describe('InstallClockService', () => {
  it('records the first launch and starts hidden', async () => {
    const installClock = service()
    expect(installClock.get()).toMatchObject({ phase: null, isLoading: true })

    await settled(installClock)

    expect(installClock.get()).toMatchObject({ phase: 'hidden', firstLaunchAt: NOW })
    expect(stored()).toEqual({ firstLaunchAt: NOW, lastSeenAt: NOW })
  })

  it('keeps an existing record', async () => {
    const firstLaunchAt = NOW - PAYWALL_HIDDEN_DAYS * DAY_MS
    withStored(firstLaunchAt, NOW)
    const installClock = service()

    await settled(installClock)

    expect(installClock.get()).toMatchObject({ phase: 'skippable', firstLaunchAt })
    expect(stored()).toEqual({ firstLaunchAt, lastSeenAt: NOW })
  })

  it('moves to the next phase when the page turns visible', async () => {
    const installClock = service()
    await settled(installClock)

    await clock.advance((PAYWALL_HIDDEN_DAYS + PAYWALL_SKIPPABLE_DAYS) * DAY_MS)
    activity.emitVisible()

    await vi.waitFor(() => expect(installClock.get().phase).toBe('required'))
    expect(installClock.get().today).toBe('2026-11-18')
  })

  it('never rewinds when the clock is set back', async () => {
    const firstLaunchAt = NOW - PAYWALL_HIDDEN_DAYS * DAY_MS
    withStored(firstLaunchAt, NOW)
    clock.setNow(firstLaunchAt)
    const installClock = service()

    await settled(installClock)

    expect(installClock.get().phase).toBe('skippable')
  })

  it('writes the last seen time at most once an hour', async () => {
    const installClock = service()
    await settled(installClock)

    await clock.advance(HOUR_MS - 1)
    activity.emitVisible()
    await vi.waitFor(() => expect(installClock.get().isLoading).toBe(false))
    expect(stored()).toEqual({ firstLaunchAt: NOW, lastSeenAt: NOW })

    await clock.advance(1)
    activity.emitVisible()
    await vi.waitFor(() => {
      expect(stored()).toEqual({ firstLaunchAt: NOW, lastSeenAt: NOW + HOUR_MS })
    })
  })

  it('reads as hidden without writing when the keychain fails, then retries', async () => {
    const get = vi.fn(() => Promise.reject(new Error('keychain locked')))
    const set = vi.fn(() => Promise.resolve())
    const installClock = service({
      secretStore: { get, set, delete: vi.fn(() => Promise.resolve()) },
    })

    await settled(installClock)

    expect(installClock.get()).toMatchObject({ phase: 'hidden', firstLaunchAt: null })
    expect(set).not.toHaveBeenCalled()

    activity.emitVisible()
    await vi.waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2)
    })
    expect(set).not.toHaveBeenCalled()
  })

  it('replaces an unreadable record', async () => {
    secrets = createTestSecretStoreService({ [INSTALL_CLOCK_SECRET]: '{"broken"' })
    const installClock = service()

    await settled(installClock)

    expect(stored()).toEqual({ firstLaunchAt: NOW, lastSeenAt: NOW })
  })

  it('stays hidden off iOS without touching the keychain', () => {
    const reads = vi.spyOn(secrets, 'get')
    const installClock = service({ appPlatform: 'desktop' })

    installClock.subscribe(() => {})

    expect(installClock.get()).toMatchObject({ phase: 'hidden', isLoading: false })
    expect(reads).not.toHaveBeenCalled()
  })
})
