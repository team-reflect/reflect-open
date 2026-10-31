import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { MobileScreenHeader } from './screen-header.tsx'

describe('MobileScreenHeader', () => {
  it('centers the title between balanced header action slots', async () => {
    const view = await render(
      <MobileScreenHeader
        title="Roadmap"
        onBack={vi.fn()}
        trailing={<button type="button" aria-label="More actions" />}
      />,
    )

    const header = view.container.querySelector('header')
    if (header === null) {
      throw new Error('expected a header')
    }
    const bar = header.getBoundingClientRect()
    const title = view.getByRole('heading', { name: 'Roadmap' }).element().getBoundingClientRect()
    expect(title.left + title.width / 2).toBeCloseTo(bar.left + bar.width / 2, 1)

    const back = view.getByRole('button', { name: 'Back' }).element().getBoundingClientRect()
    const more = view
      .getByRole('button', { name: 'More actions' })
      .element()
      .getBoundingClientRect()
    expect(back.left + back.width / 2 - bar.left).toBeCloseTo(
      bar.right - (more.left + more.width / 2),
      1,
    )
  })

  it('keeps header actions clear of an uneven side inset', async () => {
    document.documentElement.style.setProperty('--twsa-safe-area-inset-right', '84px')
    try {
      const view = await render(
        <MobileScreenHeader
          title="Roadmap"
          onBack={vi.fn()}
          trailing={<button type="button" aria-label="More actions" />}
        />,
      )
      const header = view.container.querySelector('header')
      if (header === null) {
        throw new Error('expected a header')
      }
      const more = view.getByRole('button', { name: 'More actions' }).element()
      expect(more.getBoundingClientRect().right).toBeLessThanOrEqual(
        header.getBoundingClientRect().right - 84,
      )
    } finally {
      document.documentElement.style.removeProperty('--twsa-safe-area-inset-right')
    }
  })
})
