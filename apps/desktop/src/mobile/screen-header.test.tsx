import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileScreenHeader } from './screen-header'

afterEach(() => {
  cleanup()
})

describe('MobileScreenHeader', () => {
  it('centers the title between balanced header action slots', () => {
    const view = render(
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

    expect(Array.from(screen.getByRole('button', { name: 'Back' }).classList)).toContain(
      'justify-self-center',
    )
    expect(Array.from(screen.getByRole('heading', { name: 'Roadmap' }).classList)).toContain(
      'text-center',
    )
  })
})
