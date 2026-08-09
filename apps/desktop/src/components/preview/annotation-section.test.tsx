import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationItem } from '@/lib/annotations/annotations-store'

const ANNOTATIONS: AnnotationItem[] = [
  {
    id: 'a1',
    pageIndex: 0,
    type: 'border',
    rects: [[0.1, 0.1, 0.2, 0.2]],
    color: '#FFD400',
    text: 'First highlight',
  },
  {
    id: 'a2',
    pageIndex: 1,
    type: 'border',
    rects: [[0.3, 0.3, 0.4, 0.4]],
    color: '#8CE99A',
    text: 'Second highlight',
  },
]

const settingsState = vi.hoisted(() => ({
  settings: { annotationListHeight: 180 },
  updateSettings: vi.fn(),
}))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => settingsState,
}))
// The list reads the pdf.js viewer to jump pages; the section's own tests
// (collapse, resize) don't need a real document.
vi.mock('./pdf-viewer-shell', () => ({
  usePdfViewer: () => ({ viewer: null }),
}))

const { AnnotationSection } = await import('./annotation-section')

function rootVariable(name: string): string {
  return document.documentElement.style.getPropertyValue(name)
}

function firePointer(element: Element, type: string, init: PointerEventInit): void {
  element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, ...init }))
}

beforeEach(async () => {
  // 测试里没有 SidebarWidthEffect，直接写死清单高度让布局与拖拽基准确定。
  document.documentElement.style.setProperty('--annotation-list-height', '200px')
  await page.viewport(1280, 800)
})

afterEach(() => {
  document.documentElement.style.removeProperty('--annotation-list-height')
  document.documentElement.style.removeProperty('cursor')
  document.documentElement.style.removeProperty('user-select')
  document.documentElement.style.removeProperty('-webkit-user-select')
  settingsState.settings = { annotationListHeight: 180 }
  settingsState.updateSettings.mockReset()
})

describe('AnnotationSection', () => {
  it('collapses and expands the list without ever closing the panel', async () => {
    await render(
      <AnnotationSection
        annotations={ANNOTATIONS}
        mode="browse"
        onModeChange={vi.fn()}
        color="#FFD400"
        onColorChange={vi.fn()}
        selectedId={null}
        onSelect={vi.fn()}
        onDeleteSelected={vi.fn()}
      />,
    )
    await expect.element(page.getByText('First highlight')).toBeInTheDocument()

    // 折叠只收起清单：行还在（清单头部的工具按钮与分隔条消失）。
    await page.getByRole('button', { name: 'Collapse annotation list' }).click()
    expect(page.getByText('First highlight').query()).toBeNull()
    expect(page.getByRole('separator', { name: 'Resize annotation list' }).query()).toBeNull()
    await expect.element(page.getByRole('button', { name: 'Browse' })).toBeInTheDocument()
    expect(settingsState.updateSettings).not.toHaveBeenCalled()

    // 展开后清单回来，分隔条也回来。
    await page.getByRole('button', { name: 'Expand annotation list' }).click()
    await expect.element(page.getByText('Second highlight')).toBeInTheDocument()
    await expect
      .element(page.getByRole('separator', { name: 'Resize annotation list' }))
      .toBeInTheDocument()
  })

  it('drags the divider to resize the list and persists the height on release', async () => {
    await render(
      <AnnotationSection
        annotations={ANNOTATIONS}
        mode="browse"
        onModeChange={vi.fn()}
        color="#FFD400"
        onColorChange={vi.fn()}
        selectedId={null}
        onSelect={vi.fn()}
        onDeleteSelected={vi.fn()}
      />,
    )
    const handle = page.getByRole('separator', { name: 'Resize annotation list' }).element()
    if (!handle) {
      throw new Error('handle missing')
    }

    // 向上拖 40px：清单增高，拖拽期间全局 row-resize 光标。
    firePointer(handle, 'pointerdown', { pointerId: 5, button: 0, clientY: 200 })
    firePointer(handle, 'pointermove', { pointerId: 5, clientY: 160 })
    expect(rootVariable('cursor')).toBe('row-resize')
    expect(rootVariable('--annotation-list-height')).toBe('240px')
    expect(settingsState.updateSettings).not.toHaveBeenCalled()

    firePointer(handle, 'pointerup', { pointerId: 5, clientY: 160 })
    expect(settingsState.updateSettings).toHaveBeenCalledTimes(1)
    expect(settingsState.updateSettings).toHaveBeenCalledWith({ annotationListHeight: 240 })
    expect(rootVariable('--annotation-list-height')).toBe('240px')
    expect(rootVariable('cursor')).toBe('')
  })

  it('nudges the height with arrow keys and resets on double-click', async () => {
    await render(
      <AnnotationSection
        annotations={ANNOTATIONS}
        mode="browse"
        onModeChange={vi.fn()}
        color="#FFD400"
        onColorChange={vi.fn()}
        selectedId={null}
        onSelect={vi.fn()}
        onDeleteSelected={vi.fn()}
      />,
    )
    const handle = page.getByRole('separator', { name: 'Resize annotation list' }).element()
    if (!handle) {
      throw new Error('handle missing')
    }

    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    )
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ annotationListHeight: 216 })

    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    )
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ annotationListHeight: 184 })

    handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    expect(settingsState.updateSettings).toHaveBeenLastCalledWith({ annotationListHeight: 180 })
  })

  it('exposes a horizontal separator controlling the list with the clamp range', async () => {
    await render(
      <AnnotationSection
        annotations={ANNOTATIONS}
        mode="browse"
        onModeChange={vi.fn()}
        color="#FFD400"
        onColorChange={vi.fn()}
        selectedId={null}
        onSelect={vi.fn()}
        onDeleteSelected={vi.fn()}
      />,
    )
    const handle = page.getByRole('separator', { name: 'Resize annotation list' }).element()

    expect(handle?.getAttribute('aria-orientation')).toBe('horizontal')
    expect(handle?.getAttribute('aria-controls')).toBe('annotation-list')
    expect(handle?.getAttribute('aria-valuemin')).toBe('120')
    expect(handle?.getAttribute('aria-valuemax')).toBe('480')
    // 未拖拽时报告视口有效高度（180 偏好在此窗口内全额生效）。
    expect(handle?.getAttribute('aria-valuenow')).toBe('180')
  })
})
