import { describe, expect, it } from 'vitest'
import { foldFallbackTitleKey, foldKey, foldTag } from './keys'

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

describe('foldFallbackTitleKey', () => {
  it('tolerates a leading emoji with or without following whitespace', () => {
    expect(foldFallbackTitleKey('🧠 Business ideas')).toBe('business ideas')
    expect(foldFallbackTitleKey('🧠Business ideas')).toBe('business ideas')
    expect(foldFallbackTitleKey('Business ideas')).toBe('business ideas')
  })

  it('handles emoji sequences and collapses Unicode whitespace', () => {
    expect(foldFallbackTitleKey('👩🏽‍💻  Product\tIdeas')).toBe('product ideas')
    expect(foldFallbackTitleKey('🇬🇧\u00a0Travel  Ideas')).toBe('travel ideas')
    expect(foldFallbackTitleKey('1️⃣  First idea')).toBe('first idea')
  })

  it('keeps non-prefix punctuation significant', () => {
    expect(foldFallbackTitleKey('C')).toBe('c')
    expect(foldFallbackTitleKey('C++')).toBe('c++')
    expect(foldFallbackTitleKey('# Project')).toBe('# project')
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
