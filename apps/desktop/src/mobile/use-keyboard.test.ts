import { afterEach, describe, expect, it } from 'vitest'
import { getKeyboardHeight, publishKeyboardHeight } from './use-keyboard'

/**
 * The keyboard-height store behind `--keyboard-height`: imperative consumers
 * (the day carousel's drag guard fires at drag start, outside React) read the
 * last published overlap through {@link getKeyboardHeight}.
 */
describe('keyboard height store', () => {
  afterEach(() => {
    publishKeyboardHeight(0)
  })

  it('starts closed and reflects the last published height', () => {
    expect(getKeyboardHeight()).toBe(0)
    publishKeyboardHeight(316)
    expect(getKeyboardHeight()).toBe(316)
    publishKeyboardHeight(0)
    expect(getKeyboardHeight()).toBe(0)
  })
})
