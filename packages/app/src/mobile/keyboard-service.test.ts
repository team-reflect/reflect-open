import { describe, expect, it } from 'vitest'
import { createKeyboardService } from './keyboard-service.ts'

describe('KeyboardService', () => {
  it('starts closed and reflects the last published height', () => {
    const keyboard = createKeyboardService()
    expect(keyboard.get()).toBe(0)

    keyboard.publish(316)
    expect(keyboard.get()).toBe(316)

    keyboard.publish(0)
    expect(keyboard.get()).toBe(0)
  })

  it('notifies subscribers of a changed height only', () => {
    const keyboard = createKeyboardService()
    let changes = 0
    keyboard.subscribe(() => {
      changes += 1
    })

    keyboard.publish(0)
    expect(changes).toBe(0)
    keyboard.publish(316)
    keyboard.publish(316)
    expect(changes).toBe(1)
    keyboard.publish(280)
    expect(changes).toBe(2)
  })

  it('keeps notifying after an unrelated subscriber left', () => {
    const keyboard = createKeyboardService()
    const seen: string[] = []
    const unlisten = keyboard.subscribe(() => {
      seen.push('first')
    })
    keyboard.subscribe(() => {
      seen.push('second')
    })

    unlisten()
    keyboard.publish(280)

    expect(seen).toEqual(['second'])
  })
})
