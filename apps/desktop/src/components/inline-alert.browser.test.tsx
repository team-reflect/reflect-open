import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { InlineAlert } from './inline-alert'

const alert = page.getByRole('alert')

describe('InlineAlert', () => {
  it('announces its content with role=alert', async () => {
    render(<InlineAlert>Save failed.</InlineAlert>)
    await expect.element(alert).toHaveTextContent('Save failed.')
  })

  // TONE_CLASSES is the contract under test, so class substrings are asserted here.
  it('defaults to the warning (amber) tone', async () => {
    render(<InlineAlert>Heads up.</InlineAlert>)
    await expect.element(alert).toBeVisible()
    expect(alert.element().className).toContain('amber')
  })

  it('renders the error tone in red', async () => {
    render(<InlineAlert tone="error">It broke.</InlineAlert>)
    await expect.element(alert).toHaveTextContent('It broke.')
    const { className } = alert.element()
    expect(className).toContain('red')
    expect(className).not.toContain('amber')
  })

  it('passes a custom className through', async () => {
    render(<InlineAlert className="mb-4">Spaced.</InlineAlert>)
    await expect.element(alert).toBeVisible()
    expect(alert.element().className).toContain('mb-4')
  })
})
