import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from '@/test-utils/act.ts'
import { createThemeService, THEME_PREFERENCE_CACHE_KEY, type ThemeService } from '@reflect/app'
import { createTestSystemPreferencesService } from '@reflect/app/testing'
import type { CoreServices, Settings } from '@reflect/core'
import {
  createTestCoreServices,
  createTestSettingsService,
  createTestStorageService,
  type TestSettingsService,
  type TestStorageService,
} from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { ThemeEffect } from './theme-provider.tsx'

/**
 * Covers the startup-flash contract: `public/theme-init.js` paints the cached
 * preference before React boots, so the effect must leave the document alone
 * until the settings load settles.
 */

let settings: TestSettingsService
let storage: TestStorageService
let theme: ThemeService
let core: CoreServices
let releaseLoad: () => void
let originalClassName: string
let originalColorScheme: string

function install(stored: Partial<Settings>, options: { gateLoad?: boolean } = {}): void {
  settings = createTestSettingsService(stored)
  const gate = Promise.withResolvers<void>()
  releaseLoad = () => gate.resolve()
  if (options.gateLoad) {
    settings.ipc.onCommand('settings_load', async () => {
      await gate.promise
      return stored
    })
  }
  storage = createTestStorageService()
  const systemPreferences = createTestSystemPreferencesService({ colorScheme: 'light' })
  theme = createThemeService({ settings, storage, systemPreferences })
  core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    settings,
    storage,
  })
}

/**
 * Mount the effect over the services of the last `install`, without awaiting the settings load.
 */
async function renderTheme(): Promise<void> {
  await renderInApp(<ThemeEffect />, { core, appServices: { theme }, servicesOnly: true })
}

/**
 * Runs the settings load to completion inside `act`, so its updates land attached.
 */
async function settleLoad(): Promise<void> {
  await act(async () => {
    await theme.whenSettled()
  })
}

/**
 * What `theme-init.js` would have applied for a dark first paint.
 */
function paintDarkFirstFrame(): void {
  document.documentElement.classList.add('dark')
  document.documentElement.style.colorScheme = 'dark'
}

beforeEach(() => {
  originalClassName = document.documentElement.className
  originalColorScheme = document.documentElement.style.colorScheme
})

afterEach(() => {
  document.documentElement.className = originalClassName
  document.documentElement.style.colorScheme = originalColorScheme
})

describe('ThemeEffect', () => {
  it('leaves the first-paint theme alone until the settings load settles', async () => {
    // A `light`-pinned user on a dark first paint: before the load lands the
    // preference is the `system` default, which resolves to light here.
    paintDarkFirstFrame()
    install({ theme: 'light' }, { gateLoad: true })

    await renderTheme()
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')

    releaseLoad()
    await settleLoad()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('exposes the resolved theme of the loaded preference', async () => {
    install({ theme: 'system' })

    await renderTheme()
    await settleLoad()
    expect(theme.get().preference).toBe('system')
    expect(theme.get().resolved).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('applies and persists a preference chosen during the session', async () => {
    install({ theme: 'light' })

    await renderTheme()
    await settleLoad()
    await act(() => {
      theme.setPreference('dark')
    })
    expect(theme.get().resolved).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(settings.get().theme).toBe('dark')
    expect(storage.local.get(THEME_PREFERENCE_CACHE_KEY)).toBe('dark')
  })

  it('still applies the theme after a failed load', async () => {
    // A failed load must unblock applying the theme, or the app would be stuck
    // on theme-init.js's guess with no way to change it.
    paintDarkFirstFrame()
    install({})
    settings.failLoad()

    await renderTheme()
    await settleLoad()
    expect(document.documentElement.style.colorScheme).toBe('light')

    await act(() => {
      theme.setPreference('dark')
    })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
