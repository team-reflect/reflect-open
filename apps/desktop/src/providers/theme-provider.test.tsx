import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import { resetOperations } from '@/lib/operations'
import { THEME_PREFERENCE_CACHE_KEY } from '@/lib/theme-cache'
import { SETTINGS_QUERY_KEY, SettingsProvider } from './settings-provider'
import { ThemeProvider, useTheme } from './theme-provider'

/**
 * Covers the startup-flash contract: `public/theme-init.js` paints the cached
 * preference before React boots, so this provider must leave the document alone
 * until the settings load settles — and must mirror the loaded preference back
 * for the next launch.
 */

let stored: Record<string, unknown>
let failLoad: boolean
/** When set, `settings_load` blocks until {@link releaseLoad} is called. */
let gateLoad: boolean
let pendingLoad: (() => void) | null

/**
 * Let the gated `settings_load` return. Awaiting the gate first matters: the
 * bridge call is async, so a release that ran before `invoke` reached its
 * `await` would be a silent no-op and the load would never settle.
 */
async function releaseLoad(): Promise<void> {
  await vi.waitFor(() => expect(pendingLoad).not.toBeNull())
  pendingLoad?.()
  pendingLoad = null
}

function installFakeBridge(): void {
  failLoad = false
  gateLoad = false
  pendingLoad = null
  setBridge({
    invoke: async (command) => {
      if (command === 'settings_load') {
        if (failLoad) {
          throw { kind: 'io', message: 'corrupt store' }
        }
        if (gateLoad) {
          await new Promise<void>((resolve) => {
            pendingLoad = resolve
          })
        }
        return stored
      }
      return null
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <SettingsProvider>
      <ThemeProvider>{children}</ThemeProvider>
    </SettingsProvider>
  </QueryClientProvider>
)

type Act = (callback: () => unknown) => Promise<void>

/**
 * Run the settings load to completion and flush every React update it cascades
 * into, so assertions after this see the settled provider.
 *
 * The wait polls the query cache rather than the document: React defers the
 * updates queued inside an `act` scope until the scope exits, so polling
 * rendered output from in here would never observe it. Staying inside `act`
 * matters because the load-settled state update would otherwise land
 * unattached, and React's warning about that fails the test on console output.
 */
async function settleLoad(act: Act): Promise<void> {
  await act(async () => {
    await vi.waitFor(() => {
      // A query that has not been registered yet reads as `undefined`, which is
      // also "not pending" — require the real settled state, or this returns
      // before the load has even started.
      const state = queryClient.getQueryState(SETTINGS_QUERY_KEY)
      expect(state).toBeDefined()
      expect(state?.status).not.toBe('pending')
    })
  })
}

/** What `theme-init.js` would have applied for a dark first paint. */
function paintDarkFirstFrame(): void {
  document.documentElement.classList.add('dark')
  document.documentElement.style.colorScheme = 'dark'
}

function cachedPreference(): string | null {
  return localStorage.getItem(THEME_PREFERENCE_CACHE_KEY)
}

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

let originalClassName: string
let originalColorScheme: string

beforeEach(() => {
  originalClassName = document.documentElement.className
  originalColorScheme = document.documentElement.style.colorScheme
  stored = {}
  localStorage.removeItem(THEME_PREFERENCE_CACHE_KEY)
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  installFakeBridge()
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
  localStorage.removeItem(THEME_PREFERENCE_CACHE_KEY)
  document.documentElement.className = originalClassName
  document.documentElement.style.colorScheme = originalColorScheme
  resetOperations() // failed-load entries linger on a timer otherwise
})

describe('ThemeProvider', () => {
  it('leaves the first-paint theme alone until the settings load settles', async () => {
    // A `dark`-pinned user: theme-init.js painted dark, but `settings.theme` is
    // the `system` default until the load lands. Reacting to that default is
    // what used to flash the window.
    paintDarkFirstFrame()
    stored = { theme: 'dark' }
    gateLoad = true

    const { act } = await renderHook(() => useTheme(), { wrapper })
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    await releaseLoad()
    await settleLoad(act)
    expect(cachedPreference()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('applies the loaded preference over the first-paint guess', async () => {
    // The mismatch case: OS is dark, the user pinned light.
    paintDarkFirstFrame()
    stored = { theme: 'light' }

    const { act } = await renderHook(() => useTheme(), { wrapper })
    await settleLoad(act)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('caches `system` verbatim rather than the theme it resolved to', async () => {
    // Caching the resolved value would replay a stale answer on the next launch
    // if the OS theme changed while the app was closed.
    stored = { theme: 'system' }

    const { result, act } = await renderHook(() => useTheme(), { wrapper })
    await settleLoad(act)
    expect(cachedPreference()).toBe('system')
    expect(result.current.resolvedTheme).toBe(systemTheme())
  })

  it('caches a preference chosen during the session', async () => {
    stored = { theme: 'light' }

    const { result, act } = await renderHook(() => useTheme(), { wrapper })
    await settleLoad(act)
    expect(cachedPreference()).toBe('light')

    await act(() => {
      result.current.setTheme('dark')
    })
    expect(cachedPreference()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('applies but does not cache a preference after a failed load', async () => {
    // Changes are session-only once the load fails, so caching one would have
    // the next launch paint a preference that never reached disk. A failed load
    // must still unblock applying the theme, or the app would be stuck on
    // theme-init.js's guess with no way to change it.
    failLoad = true

    const { result, act } = await renderHook(() => useTheme(), { wrapper })
    await settleLoad(act)
    expect(document.documentElement.style.colorScheme).toBe(systemTheme())
    expect(cachedPreference()).toBeNull()

    await act(() => {
      result.current.setTheme('dark')
    })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(cachedPreference()).toBeNull()
  })
})
