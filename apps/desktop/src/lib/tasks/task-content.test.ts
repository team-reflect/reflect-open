import { describe, expect, it } from 'vitest'
import { resolveTaskEdit, taskContent } from './task-content'

describe('taskContent', () => {
  it('strips the open marker and its separating space', () => {
    expect(taskContent('[ ] buy milk')).toBe('buy milk')
  })

  it('strips the open marker and a tab separator', () => {
    expect(taskContent('[ ]\tbuy milk')).toBe('buy milk')
  })

  it('strips a checked marker', () => {
    expect(taskContent('[x] done')).toBe('done')
    expect(taskContent('[X] done')).toBe('done')
  })

  it('keeps link and tag markdown intact for the editor and chips', () => {
    expect(taskContent('[ ] ship [[2026-07-01]] #release')).toBe('ship [[2026-07-01]] #release')
  })

  it('handles an empty task', () => {
    expect(taskContent('[ ]')).toBe('')
  })

  it('returns a non-marker line verbatim (defensive)', () => {
    expect(taskContent('not a task line')).toBe('not a task line')
  })
})

describe('resolveTaskEdit', () => {
  it('commits a real, trimmed change', () => {
    expect(resolveTaskEdit('buy milk', '  buy oat milk ')).toEqual({
      type: 'commit',
      content: 'buy oat milk',
    })
  })

  it('cancels a whitespace-only difference', () => {
    expect(resolveTaskEdit('buy milk', '  buy milk  ')).toEqual({ type: 'cancel' })
  })

  it('deletes when the content is cleared', () => {
    expect(resolveTaskEdit('buy milk', '   ')).toEqual({ type: 'delete' })
  })

  it('cancels leaving an already-empty task empty', () => {
    expect(resolveTaskEdit('', '')).toEqual({ type: 'cancel' })
  })
})
