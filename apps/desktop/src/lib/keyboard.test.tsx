import { describe, expect, it } from 'vitest'
import { isKeyboardEventComposing } from './keyboard'

function keydown(init?: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: 'Enter', ...init })
}

describe('isKeyboardEventComposing', () => {
  it('reports false for a plain keydown', () => {
    expect(isKeyboardEventComposing(keydown())).toBe(false)
  })

  it('reports true while composing', () => {
    expect(isKeyboardEventComposing(keydown({ isComposing: true }))).toBe(true)
  })

  it('reports true for the keydown WebKit fires right after compositionend', () => {
    window.dispatchEvent(new CompositionEvent('compositionend'))
    expect(isKeyboardEventComposing(keydown())).toBe(true)
  })

  it('reports false again once the composition end is in the past', async () => {
    window.dispatchEvent(new CompositionEvent('compositionend'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(isKeyboardEventComposing(keydown())).toBe(false)
  })
})
