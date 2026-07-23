import { render } from 'vitest-browser-react'
import { describe, expect, it, vi } from 'vitest'
import { MobileScreenHeader } from './screen-header'

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
    expect(Array.from(header.classList)).toContain('grid')
    expect(Array.from(header.classList)).toContain('h-11')
    expect(Array.from(header.classList)).toContain(
      'grid-cols-[2.5rem_minmax(0,1fr)_2.5rem]',
    )
    expect(Array.from(header.classList)).toContain('items-center')

    expect(
      Array.from(view.getByRole('button', { name: 'Back' }).element().classList),
    ).toContain('justify-self-center')
    expect(
      Array.from(view.getByRole('heading', { name: 'Roadmap' }).element().classList),
    ).toContain('text-center')
  })
})
