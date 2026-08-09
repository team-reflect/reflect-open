import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnnotationItem } from '@/lib/annotations/annotations-store'
import { AnnotationContextMenu, type AnnotationMenuAnchor } from './annotation-context-menu'

const ITEM: AnnotationItem = {
  id: 'a1',
  pageIndex: 2,
  type: 'border',
  rects: [[0.1, 0.1, 0.2, 0.2]],
  color: '#FFD400',
  text: 'A key claim',
}

function anchor(x = 120, y = 90): AnnotationMenuAnchor {
  return { x, y, item: ITEM }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AnnotationContextMenu', () => {
  it('renders nothing without an anchor and the three actions with one', async () => {
    const onClose = vi.fn()
    const view = await render(
      <AnnotationContextMenu
        anchor={null}
        onClose={onClose}
        onCopyText={vi.fn()}
        onCopyReference={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    expect(view.getByRole('menu').query()).toBeNull()

    await view.rerender(
      <AnnotationContextMenu
        anchor={anchor()}
        onClose={onClose}
        onCopyText={vi.fn()}
        onCopyReference={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    await expect.element(page.getByRole('menu', { name: 'Annotation actions' })).toBeInTheDocument()
    await expect.element(page.getByRole('menuitem', { name: 'Copy text' })).toBeInTheDocument()
    await expect.element(page.getByRole('menuitem', { name: 'Copy reference' })).toBeInTheDocument()
    await expect.element(page.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  })

  it('keeps Copy text enabled for an empty-text border annotation (region extraction)', async () => {
    await render(
      <AnnotationContextMenu
        anchor={{ x: 120, y: 90, item: { ...ITEM, text: '' } }}
        onClose={vi.fn()}
        onCopyText={vi.fn()}
        onCopyReference={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    // border 标注无文本时仍可复制：从矩形覆盖区域提取 PDF 文本。
    await expect.element(page.getByRole('menuitem', { name: 'Copy text' })).toBeEnabled()
  })

  it('disables Copy text only for an empty-text text-type annotation', async () => {
    const view = await render(
      <AnnotationContextMenu
        anchor={anchor()}
        onClose={vi.fn()}
        onCopyText={vi.fn()}
        onCopyReference={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    await expect.element(page.getByRole('menuitem', { name: 'Copy text' })).toBeEnabled()

    await view.rerender(
      <AnnotationContextMenu
        anchor={{ x: 120, y: 90, item: { ...ITEM, type: 'text', text: '' } }}
        onClose={vi.fn()}
        onCopyText={vi.fn()}
        onCopyReference={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    // text 类型标注无文本：无法提取，禁用。
    await expect.element(page.getByRole('menuitem', { name: 'Copy text' })).toBeDisabled()
  })

  it('runs an action with the anchored item and closes', async () => {
    const onCopyReference = vi.fn()
    const onRemove = vi.fn()
    const onClose = vi.fn()
    await render(
      <AnnotationContextMenu
        anchor={anchor()}
        onClose={onClose}
        onCopyText={vi.fn()}
        onCopyReference={onCopyReference}
        onRemove={onRemove}
      />,
    )

    await page.getByRole('menuitem', { name: 'Copy reference' }).click()
    expect(onCopyReference).toHaveBeenCalledWith(ITEM)
    expect(onClose).toHaveBeenCalledTimes(1)

    await page.getByRole('menuitem', { name: 'Delete' }).click()
    expect(onRemove).toHaveBeenCalledWith('a1')
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('closes on Escape and on a click outside the menu', async () => {
    const onClose = vi.fn()
    const view = await render(
      <AnnotationContextMenu
        anchor={anchor()}
        onClose={onClose}
        onCopyText={vi.fn()}
        onCopyReference={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    await expect.element(page.getByRole('menu')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)

    await view.rerender(
      <AnnotationContextMenu
        anchor={anchor()}
        onClose={onClose}
        onCopyText={vi.fn()}
        onCopyReference={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    await expect.element(page.getByRole('menu')).toBeInTheDocument()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('clamps the menu inside the viewport near the cursor', async () => {
    await page.viewport(400, 300)
    // 光标贴住右下角：菜单应翻折回窗口内。
    await render(
      <AnnotationContextMenu
        anchor={anchor(399, 299)}
        onClose={vi.fn()}
        onCopyText={vi.fn()}
        onCopyReference={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    const menu = page.getByRole('menu', { name: 'Annotation actions' }).element()
    if (menu === null) {
      throw new Error('menu missing')
    }
    const rect = menu.getBoundingClientRect()
    expect(rect.left).toBeLessThan(400)
    expect(rect.top).toBeLessThan(300)
  })
})
