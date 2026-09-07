import { describe, expect, it } from 'vitest'
import { hasSearchableChar } from './searchable-char'

describe('hasSearchableChar', () => {
  it('is false for nothing and for whitespace', () => {
    expect(hasSearchableChar('')).toBe(false)
    expect(hasSearchableChar(' \t\n')).toBe(false)
  })

  it('is false for bare Markdown scaffolding', () => {
    // `+` and `>` are Unicode math symbols, not punctuation, so a predicate
    // written as "not whitespace and not punctuation" would call these true.
    expect(hasSearchableChar('+ [ ] ')).toBe(false)
    expect(hasSearchableChar('> ')).toBe(false)
    expect(hasSearchableChar('- ')).toBe(false)
    expect(hasSearchableChar('* * *')).toBe(false)
    expect(hasSearchableChar('---')).toBe(false)
    expect(hasSearchableChar('| |')).toBe(false)
    expect(hasSearchableChar('`` ')).toBe(false)
    expect(hasSearchableChar('# ')).toBe(false)
  })

  it('is true for letters in any script', () => {
    expect(hasSearchableChar('a')).toBe(true)
    expect(hasSearchableChar('今天去了東京')).toBe(true)
    expect(hasSearchableChar('こんにちは')).toBe(true)
    expect(hasSearchableChar('한국어')).toBe(true)
    expect(hasSearchableChar('Здравствуйте')).toBe(true)
    expect(hasSearchableChar('مرحبا')).toBe(true)
  })

  it('is true for digits, Latin and not', () => {
    expect(hasSearchableChar('7')).toBe(true)
    expect(hasSearchableChar('٣')).toBe(true)
    expect(hasSearchableChar('一二三')).toBe(true)
  })

  it('is false for punctuation, symbols, and emoji even when a reader sees them', () => {
    expect(hasSearchableChar('。。。')).toBe(false)
    expect(hasSearchableChar('！？')).toBe(false)
    expect(hasSearchableChar('《》')).toBe(false)
    expect(hasSearchableChar('🎉')).toBe(false)
    expect(hasSearchableChar('㊗')).toBe(false)
    expect(hasSearchableChar('™')).toBe(false)
  })

  it('is true for a body that only references something', () => {
    expect(hasSearchableChar('![](assets/beach.png)')).toBe(true)
    expect(hasSearchableChar('![](assets/海滩.png)')).toBe(true)
    expect(hasSearchableChar('https://example.com/shop')).toBe(true)
    expect(hasSearchableChar('<person@example.com>')).toBe(true)
  })

  it('does not carry state between calls', () => {
    // A `g`-flagged regex would advance `lastIndex` and alternate results here.
    expect(hasSearchableChar('abc')).toBe(true)
    expect(hasSearchableChar('abc')).toBe(true)
  })
})
