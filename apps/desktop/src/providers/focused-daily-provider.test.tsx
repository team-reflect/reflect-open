import { act } from '@/test-utils/act.ts'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import {
  FocusedDailyProvider,
  useDailyContextTarget,
  useFocusedDailyDate,
  useSetFocusedDailyDate,
} from './focused-daily-provider.tsx'

function wrapper(children: ReactNode) {
  return <FocusedDailyProvider>{children}</FocusedDailyProvider>
}

function useFocusedDaily() {
  return { date: useFocusedDailyDate(), set: useSetFocusedDailyDate() }
}

describe('FocusedDailyProvider', () => {
  it('reads back the focused day, and clears it with null', async () => {
    const { result } = await renderHookInApp(useFocusedDaily, { wrapper })
    expect(result.current.date).toBeNull()

    await act(() => result.current.set('2026-06-01'))
    expect(result.current.date).toBe('2026-06-01')

    await act(() => result.current.set(null))
    expect(result.current.date).toBeNull()
  })

  it('defaults to null with a no-op setter when no provider is mounted', async () => {
    const { result } = await renderHookInApp(useFocusedDaily)
    expect(result.current.date).toBeNull()
    await act(() => result.current.set('2026-06-01'))
    expect(result.current.date).toBeNull()
  })
})

describe('useDailyContextTarget', () => {
  const ROUTED = { kind: 'daily', date: '2026-06-09' } as const

  // The router sits above the focus provider in the real tree (GraphWorkspace).
  // A fixed daily route keeps the assertions clock-independent.
  const routed = { route: ROUTED, wrapper }

  function useHarness() {
    return {
      target: useDailyContextTarget(),
      setFocused: useSetFocusedDailyDate(),
      navigate: useRouter().navigate,
    }
  }

  it('follows the focused day, then snaps to the new routed day on navigation', async () => {
    const { result } = await renderHookInApp(useHarness, routed)
    // Nothing focused yet → the routed subject.
    expect(result.current.target).toEqual(ROUTED)

    await act(() => result.current.setFocused('2026-06-01'))
    expect(result.current.target).toEqual({ kind: 'daily', date: '2026-06-01' })

    // Navigating to another day clears focus pre-paint, onto the new routed day.
    await act(() => result.current.navigate({ kind: 'daily', date: '2026-06-05' }))
    expect(result.current.target).toEqual({ kind: 'daily', date: '2026-06-05' })
  })

  it('resets even when re-targeting the current entry (⌘D / calendar pick on it)', async () => {
    const { result } = await renderHookInApp(useHarness, routed)
    await act(() => result.current.setFocused('2026-06-01'))
    expect(result.current.target).toEqual({ kind: 'daily', date: '2026-06-01' })

    // A no-op re-navigation bumps `arrivalSeq` without changing the entry; the
    // reset keys off that, so focus still clears.
    await act(() => result.current.navigate(ROUTED))
    expect(result.current.target).toEqual(ROUTED)
  })

  it('ignores the focused day off the daily views (a note route keeps its note)', async () => {
    const { result } = await renderHookInApp(useHarness, routed)
    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    // Focus set while on a note route is irrelevant — the sidebar stays the note.
    await act(() => result.current.setFocused('2026-06-01'))
    expect(result.current.target).toEqual({ kind: 'note', path: 'notes/a.md' })
  })
})
