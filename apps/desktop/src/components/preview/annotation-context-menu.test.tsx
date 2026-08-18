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
    expect(page.getByRole('menu').query()).toBeNull()

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
    // A border annotation without text still copies: the covered region's PDF
    // text is extracted instead.
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
    // A text-type annotation without text cannot be extracted from; disabled.
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
    // base-ui closes the menu on item select, routing through onClose.
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))

    await page.getByRole('menuitem', { name: 'Delete' }).click()
    expect(onRemove).toHaveBeenCalledWith('a1')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(2))
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    await render(
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
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })
})
