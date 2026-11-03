import { describe, expect, it } from 'vitest'
import {
  createTestSettingsService,
  createTestStorageService,
  type TestStorageService,
} from '@reflect/core/testing'
import type { Settings } from '@reflect/core'
import { createTestSystemPreferencesService } from '../testing/system-preferences.ts'
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
  const systemPreferences = createTestSystemPreferencesService({ colorScheme: 'light' })
  const theme = createThemeService({ settings, storage, systemPreferences })
  return { theme, settings, storage, systemPreferences, releaseLoad: () => gate.resolve() }
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
    expect(theme.get().preference).toBe('system')
    expect(theme.get().resolved).toBe('light')
    expect(theme.get().settled).toBe(false)
    expect(cached(storage)).toBeNull()

    let settled = false
    const waiting = theme.whenSettled().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseLoad()
    await waiting
    expect(theme.get().settled).toBe(true)
    expect(theme.get().preference).toBe('dark')
    expect(theme.get().resolved).toBe('dark')
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
    const { theme, storage, systemPreferences } = setup({ theme: 'system' })
    systemPreferences.colorScheme.set('dark')
    await theme.whenSettled()
    expect(cached(storage)).toBe('system')
    expect(theme.get().resolved).toBe('dark')
  })

  it('writes a new preference through the settings and caches it', async () => {
    const { theme, settings, storage } = setup({ theme: 'light' })
    await theme.whenSettled()
    expect(cached(storage)).toBe('light')

    theme.setPreference('dark')
    expect(theme.get().preference).toBe('dark')
    expect(theme.get().resolved).toBe('dark')
    expect(settings.get().theme).toBe('dark')
    expect(cached(storage)).toBe('dark')
    await settings.flush()
    expect(settings.saves().at(-1)?.theme).toBe('dark')
  })

  it('toggles the preference to the opposite of the resolved theme', async () => {
    const { theme, systemPreferences } = setup({ theme: 'system' })
    systemPreferences.colorScheme.set('dark')
    await theme.whenSettled()

    theme.toggleTheme()
    expect(theme.get().preference).toBe('light')
    theme.toggleTheme()
    expect(theme.get().preference).toBe('dark')
  })

  it('applies but does not cache a preference after a failed load', async () => {
    const { theme, settings, storage } = setup()
    settings.failLoad()
    await theme.whenSettled()
    expect(theme.get().settled).toBe(true)
    expect(cached(storage)).toBeNull()

    theme.setPreference('dark')
    expect(theme.get().resolved).toBe('dark')
    expect(cached(storage)).toBeNull()
  })

  it('follows the system color scheme only while the preference is `system`', async () => {
    const { theme, systemPreferences } = setup({ theme: 'system' })
    await theme.whenSettled()
    let calls = 0
    theme.subscribe(() => {
      calls += 1
    })

    systemPreferences.colorScheme.set('dark')
    expect(theme.get().resolved).toBe('dark')
    expect(calls).toBe(1)

    theme.setPreference('light')
    expect(calls).toBe(2)
    systemPreferences.colorScheme.set('light')
    systemPreferences.colorScheme.set('dark')
    expect(theme.get().resolved).toBe('light')
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

  it('keeps the same state until a field changes', async () => {
    const { theme, systemPreferences } = setup({ theme: 'light' })
    await theme.whenSettled()
    const state = theme.get()
    expect(theme.get()).toBe(state)

    systemPreferences.colorScheme.set('dark')
    expect(theme.get()).toBe(state)

    theme.setPreference('dark')
    expect(theme.get()).not.toBe(state)
  })

  it('does not notify when the system scheme changes under a pinned preference', async () => {
    const { theme, systemPreferences } = setup({ theme: 'light' })
    await theme.whenSettled()
    let calls = 0
    theme.subscribe(() => {
      calls += 1
    })
    systemPreferences.colorScheme.set('dark')
    expect(calls).toBe(0)
  })

  it('does not notify when an unrelated setting changes', async () => {
    const { theme, settings } = setup({ theme: 'light' })
    await theme.whenSettled()
    const state = theme.get()
    let calls = 0
    theme.subscribe(() => {
      calls += 1
    })
    settings.update({ dateFormat: 'dmy' })
    expect(calls).toBe(0)
    expect(theme.get()).toBe(state)
  })
})
