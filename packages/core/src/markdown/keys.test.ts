import { describe, expect, it } from 'vitest'
import { foldKey, foldTag } from './keys'

describe('foldKey', () => {
  it('trims and lowercases', () => {
    expect(foldKey('  Project X  ')).toBe('project x')
  })

  it('is idempotent', () => {
    const once = foldKey('  Charlotte ')
    expect(foldKey(once)).toBe(once)
  })

  it('leaves an already-folded key unchanged', () => {
    expect(foldKey('charlotte')).toBe('charlotte')
  })
})

describe('foldTag', () => {
  it('case-folds Unicode-aware (SQLite lower() could not fold the É)', () => {
    expect(foldTag('Book')).toBe('book')
    expect(foldTag('CAFÉ')).toBe('café')
    expect(foldTag('Project/Reflect_2')).toBe('project/reflect_2')
  })

  it('is idempotent', () => {
    expect(foldTag(foldTag('Book'))).toBe('book')
  })
})
