import { renderHook } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import {
  PreviewPanelProvider,
  usePreviewPanel,
  usePreviewPanelTarget,
  useSetPreviewPanelTarget,
} from './preview-panel-provider'

function wrapper({ children }: { children: ReactNode }) {
  return (
    <RouterProvider initialRoute={{ kind: 'today' }}>
      <PreviewPanelProvider>{children}</PreviewPanelProvider>
    </RouterProvider>
  )
}

function useHarness() {
  return {
    panel: usePreviewPanel(),
    set: useSetPreviewPanelTarget(),
  }
}

describe('PreviewPanelProvider', () => {
  it('opens and closes a target, and defaults to no-op without a provider', async () => {
    const { result, act } = await renderHook(useHarness, { wrapper })
    expect(result.current.panel.target).toBeNull()

    await act(() => result.current.panel.open({ kind: 'pdf', assetPath: 'assets/paper.pdf' }))
    expect(result.current.panel.target).toEqual({
      kind: 'pdf',
      assetPath: 'assets/paper.pdf',
    })

    await act(() => result.current.panel.close())
    expect(result.current.panel.target).toBeNull()
  })

  it('carries an optional page on a PDF target and sets a note target', async () => {
    const { result, act } = await renderHook(useHarness, { wrapper })
    await act(() =>
      result.current.panel.open({ kind: 'pdf', assetPath: 'assets/paper.pdf', page: 3 }),
    )
    expect(result.current.panel.target).toEqual({
      kind: 'pdf',
      assetPath: 'assets/paper.pdf',
      page: 3,
    })

    await act(() => result.current.panel.open({ kind: 'note', path: 'notes/foo.md' }))
    expect(result.current.panel.target).toEqual({ kind: 'note', path: 'notes/foo.md' })
  })

  it('defaults to null with a no-op setter when no provider is mounted', async () => {
    const { result, act } = await renderHook(useHarness)
    expect(result.current.panel.target).toBeNull()
    await act(() => result.current.set({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.panel.target).toBeNull()
  })
})

describe('usePreviewPanel route clearing', () => {
  function routed({ children }: { children: ReactNode }) {
    return (
      <RouterProvider initialRoute={{ kind: 'today' }}>
        <PreviewPanelProvider>{children}</PreviewPanelProvider>
      </RouterProvider>
    )
  }

  function useHarnessWithRouter() {
    return {
      target: usePreviewPanelTarget(),
      set: useSetPreviewPanelTarget(),
      navigate: useRouter().navigate,
    }
  }

  it('closes the panel on a route change', async () => {
    const { result, act } = await renderHook(useHarnessWithRouter, { wrapper: routed })

    await act(() => result.current.set({ kind: 'pdf', assetPath: 'assets/paper.pdf' }))
    expect(result.current.target).toEqual({ kind: 'pdf', assetPath: 'assets/paper.pdf' })

    await act(() => result.current.navigate({ kind: 'note', path: 'notes/a.md' }))
    expect(result.current.target).toBeNull()
  })

  it('keeps the panel across a re-navigation to the same route', async () => {
    const { result, act } = await renderHook(useHarnessWithRouter, { wrapper: routed })

    await act(() => result.current.set({ kind: 'note', path: 'notes/a.md' }))
    await act(() => result.current.navigate({ kind: 'today' }))
    expect(result.current.target).toEqual({ kind: 'note', path: 'notes/a.md' })
  })
})
