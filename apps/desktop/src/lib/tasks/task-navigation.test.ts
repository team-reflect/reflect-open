import { describe, expect, it } from 'vitest'
import type { OpenTask } from '@reflect/core'
import { makeOpenTask } from './open-task-fixture.ts'
import { previousTaskKey } from './task-navigation.ts'
import { getTaskKey } from './task-identity.ts'

function task(over: Partial<OpenTask> = {}): OpenTask {
  return makeOpenTask({ text: 'x', ...over })
}

describe('previousTaskKey', () => {
  const a = task({ notePath: 'a.md', astPath: [1] })
  const b = task({ notePath: 'b.md', astPath: [1] })
  const c = task({ notePath: 'c.md', astPath: [1] })
  const ordered = [a, b, c]

  it('selects the row above a middle row', () => {
    expect(previousTaskKey(ordered, b)).toBe(getTaskKey(a))
  })

  it('selects the next row when deleting the first (it becomes the new first)', () => {
    expect(previousTaskKey(ordered, a)).toBe(getTaskKey(b))
  })

  it('returns null for the only row', () => {
    expect(previousTaskKey([a], a)).toBeNull()
  })

  it('returns null when the row is not in the order', () => {
    expect(previousTaskKey(ordered, task({ notePath: 'z.md', astPath: [9] }))).toBeNull()
  })
})
