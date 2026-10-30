import { describe, expect, it, vi } from 'vitest'
import type { SizeClassService } from '@reflect/app'
import type { GraphInfo, HorizontalSizeClass } from '@reflect/core'
import { act } from '@/test-utils/act.ts'
import '@/test-utils/locator.ts'
import { IPAD_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { TabletShell } from './tablet-shell.tsx'

vi.mock('@/mobile/mobile-shell.tsx', () => ({
  MobileShell: () => <div data-testid="phone-shell" />,
}))
vi.mock('@/mobile/tablet-workspace.tsx', () => ({
  TabletWorkspace: () => <div data-testid="desktop-workspace" />,
}))

const GRAPH: GraphInfo = { root: '/graphs/test', name: 'test', generation: 1 }

/** A size class the test moves between, like a window crossing widths. */
function scriptedSizeClass(initial: HorizontalSizeClass | null) {
  let current = initial
  const listeners = new Set<() => void>()
  const service: SizeClassService = {
    current: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start: () => {},
  }
  const resize = (next: HorizontalSizeClass): void => {
    current = next
    for (const listener of listeners) {
      listener()
    }
  }
  return { service, resize }
}

async function renderShell(initial: HorizontalSizeClass | null) {
  const sizeClass = scriptedSizeClass(initial)
  const view = await renderInApp(<TabletShell graph={GRAPH} />, {
    platform: IPAD_PLATFORM,
    appServices: { sizeClass: sizeClass.service },
  })
  return { view, resize: sizeClass.resize }
}

describe('TabletShell', () => {
  it('renders neither surface until the window reports its size class', async () => {
    const { view } = await renderShell(null)
    expect(view.getByTestId('desktop-workspace').query()).toBeNull()
    expect(view.getByTestId('phone-shell').query()).toBeNull()
  })

  it('is the desktop workspace while regular and the phone shell while compact', async () => {
    const { view, resize } = await renderShell('regular')
    await expect.element(view.getByTestId('desktop-workspace')).toBeInTheDocument()

    await act(() => resize('compact'))
    await expect.element(view.getByTestId('phone-shell')).toBeInTheDocument()
    expect(view.getByTestId('desktop-workspace').query()).toBeNull()

    await act(() => resize('regular'))
    await expect.element(view.getByTestId('desktop-workspace')).toBeInTheDocument()
  })

  it('keeps the history across a switch but drops the other surface’s scroll offsets', async () => {
    const { view, resize } = await renderShell('regular')
    const { navigation } = view.appServices
    navigation.navigate({ kind: 'note', path: 'notes/a.md' })
    navigation.saveScrollState(480)

    await act(() => resize('compact'))
    await expect.element(view.getByTestId('phone-shell')).toBeInTheDocument()

    expect(navigation.getState().route).toEqual({ kind: 'note', path: 'notes/a.md' })
    expect(navigation.getState().canBack).toBe(true)
    expect(navigation.savedScroll()).toBeNull()
  })
})
