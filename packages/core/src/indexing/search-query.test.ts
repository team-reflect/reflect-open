import { describe, expect, it } from 'vitest'
import {
  buildFtsMatch,
  containsUnsegmentedScript,
  titleRecallNeedles,
} from './search-query'

describe('buildFtsMatch', () => {
  it('returns null for an empty or whitespace-only query', () => {
    expect(buildFtsMatch('')).toBeNull()
    expect(buildFtsMatch('   \t \n ')).toBeNull()
  })

  it('quotes a single term as a literal phrase', () => {
    expect(buildFtsMatch('hello')).toBe('"hello"')
  })

  it('quotes each term so FTS5 operators are treated as literal text', () => {
    expect(buildFtsMatch('cats AND (dogs*)')).toBe('"cats" "AND" "(dogs*)"')
  })

  it('doubles embedded double-quotes (FTS5 escaping)', () => {
    expect(buildFtsMatch('say "hi"')).toBe('"say" """hi"""')
  })

  it('collapses runs of whitespace between terms', () => {
    expect(buildFtsMatch('  alpha   beta ')).toBe('"alpha" "beta"')
  })
})

describe('containsUnsegmentedScript', () => {
  // The Rust CLI mirrors this classification (`apps/cli/src/keys.rs`) — the
  // same inputs must classify the same way there.
  it('detects scripts written without word separators', () => {
    expect(containsUnsegmentedScript('東京')).toBe(true) // Han
    expect(containsUnsegmentedScript('とうきょう')).toBe(true) // Hiragana
    expect(containsUnsegmentedScript('トウキョウ')).toBe(true) // Katakana
    expect(containsUnsegmentedScript('人々')).toBe(true) // iteration mark
    expect(containsUnsegmentedScript('서울')).toBe(true) // Hangul
    expect(containsUnsegmentedScript('กรุงเทพ')).toBe(true) // Thai
    expect(containsUnsegmentedScript('𠮷野')).toBe(true) // CJK Extension B
    expect(containsUnsegmentedScript('東京trip')).toBe(true) // mixed runs count
  })

  it('rejects space-delimited scripts', () => {
    expect(containsUnsegmentedScript('tokyo')).toBe(false)
    expect(containsUnsegmentedScript('café')).toBe(false)
    expect(containsUnsegmentedScript('Москва')).toBe(false)
    expect(containsUnsegmentedScript('')).toBe(false)
  })
})

describe('titleRecallNeedles', () => {
  it('anchors space-delimited terms at word starts and leaves unsegmented terms free', () => {
    // The leading space pairs with `instr(' ' || title_key, needle)`: `car`
    // may match `Car log` but never mid-word in `Oscar party`, while `東京`
    // must match anywhere — `unicode61` gives its title run no word starts.
    expect(titleRecallNeedles('Tokyo 東京')).toEqual([' tokyo', '東京'])
    expect(titleRecallNeedles('car')).toEqual([' car'])
  })

  it('folds terms the way titles were folded at index time', () => {
    expect(titleRecallNeedles('  QuOkKa   Habitat ')).toEqual([' quokka', ' habitat'])
  })

  it('returns no needles for a blank query', () => {
    expect(titleRecallNeedles('   ')).toEqual([])
  })
})
