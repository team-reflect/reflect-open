import { describe, expect, it } from 'vitest'
import { resolveTaskEdit } from './task-content.ts'

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
