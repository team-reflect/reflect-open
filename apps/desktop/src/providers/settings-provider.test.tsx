import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import { SettingsProvider, useSettings } from './settings-provider'

/**
 * Exercises the instant-apply contract: defaults while the load is in flight,
 * updates winning over a racing initial load, full-document persistence
 * (unknown keys included), and a failed save leaving the applied value alone.
 */

let stored: Record<string, unknown>
let saved: unknown[]
let failSaves: boolean
/** When set, `settings_load` blocks until {@link releaseLoad} is called. */
let pendingLoad: (() => void) | null
let gateLoad: boolean

function releaseLoad(): void {
  pendingLoad?.()
  pendingLoad = null
}

function installFakeBridge(): void {
  saved = []
  failSaves = false
  gateLoad = false
  pendingLoad = null
  setBridge({
    invoke: async (command, args) => {
      switch (command) {
        case 'settings_load':
          if (gateLoad) {
            await new Promise<void>((resolve) => {
              pendingLoad = resolve
            })
          }
          return stored
        case 'settings_save':
          if (failSaves) {
            throw { kind: 'io', message: 'disk full' }
          }
          saved.push(args.settings)
          return null
        default:
          return null
      }
    },
    listen: async () => () => {},
  })
}

let queryClient: QueryClient

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <SettingsProvider>{children}</SettingsProvider>
  </QueryClientProvider>
)

beforeEach(() => {
  stored = {}
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  installFakeBridge()
})

afterEach(() => {
  cleanup() // `globals: false` disables testing-library's automatic cleanup
  setBridge(null)
  queryClient.clear()
})

describe('SettingsProvider', () => {
  it('serves defaults immediately, then the persisted document', async () => {
    stored = { editorMarkMode: 'show' }
    const { result } = renderHook(() => useSettings(), { wrapper })
    // Defaults are usable before the IPC load settles — no loading gate.
    expect(result.current.settings.editorMarkMode).toBe('focus')
    await waitFor(() => expect(result.current.settings.editorMarkMode).toBe('show'))
  })

  it('normalizes an invalid persisted value to its default', async () => {
    stored = { editorMarkMode: 'sideways' }
    const { result } = renderHook(() => useSettings(), { wrapper })
    await waitFor(() =>
      expect(queryClient.getQueryData(['settings'])).toBeDefined(),
    )
    expect(result.current.settings.editorMarkMode).toBe('focus')
  })

  it('applies an update and persists the full document, unknown keys included', async () => {
    stored = { editorMarkMode: 'focus', futureKey: true }
    const { result } = renderHook(() => useSettings(), { wrapper })
    await waitFor(() => expect(result.current.settings).toMatchObject({ futureKey: true }))

    act(() => {
      result.current.updateSettings({ editorMarkMode: 'show' })
    })
    // Applied without waiting for any IO — the cache is written synchronously
    // (consumers re-render on the next notification tick).
    expect(queryClient.getQueryData(['settings'])).toMatchObject({ editorMarkMode: 'show' })
    await waitFor(() => expect(result.current.settings.editorMarkMode).toBe('show'))
    // The persisted document keeps unknown keys (newer-version settings survive).
    await waitFor(() =>
      expect(saved).toEqual([{ editorMarkMode: 'show', futureKey: true }]),
    )
  })

  it('an update racing the initial load wins over the load result', async () => {
    stored = { editorMarkMode: 'focus' }
    gateLoad = true
    const { result } = renderHook(() => useSettings(), { wrapper })

    // Update while settings_load is still in flight…
    act(() => {
      result.current.updateSettings({ editorMarkMode: 'show' })
    })
    // …then let the (now stale) load finish. It must not clobber the update.
    act(() => {
      releaseLoad()
    })
    await waitFor(() => expect(saved).toEqual([{ editorMarkMode: 'show' }]))
    await waitFor(() => expect(result.current.settings.editorMarkMode).toBe('show'))
  })

  it('keeps the applied value when the save fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { result } = renderHook(() => useSettings(), { wrapper })
      await waitFor(() =>
        expect(queryClient.getQueryData(['settings'])).toBeDefined(),
      )

      failSaves = true
      act(() => {
        result.current.updateSettings({ editorMarkMode: 'show' })
      })
      await waitFor(() => expect(errorSpy).toHaveBeenCalled())
      expect(result.current.settings.editorMarkMode).toBe('show')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
