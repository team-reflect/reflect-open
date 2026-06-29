import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Kbd } from './kbd'

describe('Kbd', () => {
  it('renders its children inside a kbd element', async () => {
    render(<Kbd>esc</Kbd>)
    await expect.element(page.locate('kbd')).toHaveTextContent('esc')
  })

  it('merges a custom className with the base cap styles', async () => {
    render(<Kbd className="custom-cap">K</Kbd>)
    await expect.element(page.locate('kbd')).toHaveClass('custom-cap', 'inline-flex')
  })
})
