import { render } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import { Kbd } from './kbd'

describe('Kbd', () => {
  it('renders its children inside a kbd element', async () => {
    const view = await render(<Kbd>esc</Kbd>)
    const keycap = view.getByText('esc').element()
    expect(keycap.tagName).toBe('KBD')
    await view.unmount()
  })

  it('merges a custom className with the base cap styles', async () => {
    const view = await render(<Kbd className="custom-cap">K</Kbd>)
    const keycap = view.getByText('K').element()
    expect(keycap.className).toContain('custom-cap')
    expect(keycap.className).toContain('inline-flex')
    await view.unmount()
  })
})
