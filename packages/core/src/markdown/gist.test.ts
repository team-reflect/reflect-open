import { describe, expect, it } from 'vitest'
import { gistBodyHash, gistFilename } from './gist'

describe('gistBodyHash', () => {
  it('is deterministic and 16 hex chars', () => {
    const hash = gistBodyHash('# Note\n\nbody\n')
    expect(hash).toBe(gistBodyHash('# Note\n\nbody\n'))
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('changes when the body changes', () => {
    expect(gistBodyHash('a')).not.toBe(gistBodyHash('b'))
    expect(gistBodyHash('')).not.toBe(gistBodyHash(' '))
  })

  it('hashes by UTF-8 bytes, so multi-byte edits register', () => {
    expect(gistBodyHash('café')).not.toBe(gistBodyHash('cafe'))
  })
})

describe('gistFilename', () => {
  it('appends .md to the title (dailies are already their ISO date)', () => {
    expect(gistFilename('Project X')).toBe('Project X.md')
    expect(gistFilename('2026-06-12')).toBe('2026-06-12.md')
  })

  it('folds path separators to dashes', () => {
    expect(gistFilename('a/b\\c')).toBe('a-b-c.md')
  })

  it('falls back to Untitled for an empty or whitespace title', () => {
    expect(gistFilename('')).toBe('Untitled.md')
    expect(gistFilename('   ')).toBe('Untitled.md')
  })
})
