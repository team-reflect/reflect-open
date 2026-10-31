import { describe, expect, it } from 'vitest'
import {
  createTestPlatformService,
  createTestSettingsService,
  createTestStorageService,
  type TestStorageService,
} from '@reflect/core/testing'
import type { Settings } from '@reflect/core'
import { createThemeService, THEME_PREFERENCE_CACHE_KEY } from './theme-service.ts'

function setup(stored: Partial<Settings> = {}, options: { gateLoad?: boolean } = {}) {
  const settings = createTestSettingsService(stored)
  const gate = Promise.withResolvers<void>()
  if (options.gateLoad) {
    settings.ipc.onCommand('settings_load', async () => {
      await gate.promise
      return stored
    })
  }
  const storage = createTestStorageService()
  const platform = createTestPlatformService({ colorScheme: 'light' })
  const theme = createThemeService({ settings, storage, platform })
  return { theme, settings, storage, platform, releaseLoad: () => gate.resolve() }
}

function cached(storage: TestStorageService): string | null {
  return storage.local.get(THEME_PREFERENCE_CACHE_KEY)
}

describe('createThemeService', () => {
  it('does not load settings until first used', () => {
    const { settings } = setup()
    expect(settings.ipc.calls()).toEqual([])
  })

  it('reports the `system` default and does not cache until the load settles', async () => {
    const { theme, storage, releaseLoad } = setup({ theme: 'dark' }, { gateLoad: true })
    expect(theme.preference()).toBe('system')
    expect(theme.resolved()).toBe('light')
    expect(theme.settled()).toBe(false)
    expect(cached(storage)).toBeNull()

    let settled = false
    const waiting = theme.whenSettled().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseLoad()
    await waiting
    expect(theme.settled()).toBe(true)
    expect(theme.preference()).toBe('dark')
    expect(theme.resolved()).toBe('dark')
    expect(cached(storage)).toBe('dark')
  })

  it('notifies subscribers when the load settles', async () => {
    const { theme } = setup({ theme: 'dark' })
    let calls = 0
    theme.subscribe(() => {
      calls += 1
    })
    await theme.whenSettled()
    expect(calls).toBe(1)
  })

  it('caches `system` verbatim rather than the theme it resolved to', async () => {
    const { theme, storage, platform } = setup({ theme: 'system' })
    platform.setColorScheme('dark')
    await theme.whenSettled()
    expect(cached(storage)).toBe('system')
    expect(theme.resolved()).toBe('dark')
  })

  it('writes a new preference through the settings and caches it', async () => {
    const { theme, settings, storage } = setup({ theme: 'light' })
    await theme.whenSettled()
    expect(cached(storage)).toBe('light')

    theme.setPreference('dark')
    expect(theme.preference()).toBe('dark')
    expect(theme.resolved()).toBe('dark')
    expect(settings.get().theme).toBe('dark')
    expect(cached(storage)).toBe('dark')
    await settings.flush()
    expect(settings.saves().at(-1)?.theme).toBe('dark')
  })

  it('applies but does not cache a preference after a failed load', async () => {
    const { theme, settings, storage } = setup()
    settings.failLoad()
    await theme.whenSettled()
    expect(theme.settled()).toBe(true)
    expect(cached(storage)).toBeNull()

    theme.setPreference('dark')
    expect(theme.resolved()).toBe('dark')
    expect(cached(storage)).toBeNull()
  })

  it('follows the system color scheme only while the preference is `system`', async () => {
    const { theme, platform } = setup({ theme: 'system' })
    await theme.whenSettled()
    let calls = 0
    theme.subscribe(() => {
      calls += 1
    })

    platform.setColorScheme('dark')
    expect(theme.resolved()).toBe('dark')
    expect(calls).toBe(1)

    theme.setPreference('light')
    expect(calls).toBe(2)
    platform.setColorScheme('light')
    platform.setColorScheme('dark')
    expect(theme.resolved()).toBe('light')
    expect(calls).toBe(2)
  })

  it('stops notifying after unsubscribe', async () => {
    const { theme } = setup({ theme: 'light' })
    await theme.whenSettled()
    let calls = 0
    const unsubscribe = theme.subscribe(() => {
      calls += 1
    })
    unsubscribe()
    theme.setPreference('dark')
    expect(calls).toBe(0)
  })
})
