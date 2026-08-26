import { render } from 'vitest-browser-react'
import { describe, expect, it } from 'vitest'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

/**
 * The popup's horizontal position is not set by CSS: Base UI measures the
 * selected item's text against the trigger's value text and translates the
 * popup by the difference. The two boxes therefore only line up while the
 * popup's `border + padding` plus the item's `padding-left` equal the
 * trigger's `border + padding-left`, and nothing in the type system says so.
 */

const OPTIONS = [
  { value: 'sunday', label: 'Sunday' },
  { value: 'monday', label: 'Monday' },
  { value: 'saturday', label: 'Saturday' },
]

function el(selector: string): HTMLElement {
  const element = document.querySelector(selector)
  if (!(element instanceof HTMLElement)) {
    throw new TypeError(`no element for ${selector}`)
  }
  return element
}

async function openProbeSelect(): Promise<void> {
  // Base UI abandons item-with-trigger alignment within 20px of a viewport
  // edge, so the trigger has to sit well clear of the top.
  await render(
    <div style={{ paddingTop: 200, paddingLeft: 300 }}>
      <Select defaultValue="monday" items={OPTIONS}>
        <SelectTrigger aria-label="Week start" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OPTIONS.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>,
  )
  el('[data-slot="select-trigger"]').click()
}

describe('Select', () => {
  it('lays the options card exactly over the trigger box', async () => {
    await openProbeSelect()

    await expect
      .poll(() => {
        const content = el('[data-slot="select-content"]')
        // `none` is Base UI's marker for item-with-trigger alignment being live.
        if (content.dataset.side !== 'none') {
          return null
        }
        const trigger = el('[data-slot="select-trigger"]').getBoundingClientRect()
        const popup = content.getBoundingClientRect()
        return {
          left: Math.round(popup.left - trigger.left),
          right: Math.round(popup.right - trigger.right),
        }
      })
      .toEqual({ left: 0, right: 0 })
  })

  it('lands the selected option text on the trigger value text', async () => {
    await openProbeSelect()

    await expect
      .poll(() => {
        const value = el('[data-slot="select-value"]').getBoundingClientRect()
        const selected = el('[data-slot="select-item"][data-selected]')
        const text = selected.firstElementChild
        if (!(text instanceof HTMLElement)) {
          return null
        }
        return Math.round(text.getBoundingClientRect().left - value.left)
      })
      .toBe(0)
  })
})
