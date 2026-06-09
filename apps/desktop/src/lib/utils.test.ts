import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('keeps the last of conflicting tailwind utilities', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
  })

  it('drops falsy class values', () => {
    expect(cn('text-sm', false, undefined, 'font-medium')).toBe('text-sm font-medium')
  })
})
