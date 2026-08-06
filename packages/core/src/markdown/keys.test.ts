import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
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
    expect(foldFallbackTitleKey('🇬🇧\u{A0}Travel  Ideas')).toBe('travel ideas')
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

describe('foldKey parity corpus', () => {
  // The same corpus pins the CLI's `fold_key`; see `apps/cli/src/keys.rs`.
  const fixtures = z
    .array(z.object({ input: z.string(), key: z.string() }))
    .parse(
      JSON.parse(
        readFileSync(new URL('../../../../fixtures/fold-key-parity.json', import.meta.url), 'utf8'),
      ),
    )

  it.each(fixtures)('folds %j like the CLI does', ({ input, key }) => {
    expect(foldKey(input)).toBe(key)
  })
})
