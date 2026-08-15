import { describe, expect, it } from 'vitest'
import { buildFtsMatch, containsUnsegmentedScript, titleRecallNeedles } from './search-query'

describe('buildFtsMatch', () => {
  it('returns null for an empty or whitespace-only query', () => {
    expect(buildFtsMatch('')).toBeNull()
    expect(buildFtsMatch('   \t \n ')).toBeNull()
  })

  it('prefix-matches title and body tokens', () => {
    expect(buildFtsMatch('hello')).toBe('(title : "hello"* OR body : "hello"*)')
  })

  it('quotes each term before adding controlled FTS5 operators', () => {
    expect(buildFtsMatch('cats AND (dogs*)')).toBe(
      '(title : "cats"* OR body : "cats"*) AND (title : "AND"* OR body : "AND"*) AND (title : "(dogs*)"* OR body : "(dogs*)"*)',
    )
  })

  it('doubles embedded double-quotes (FTS5 escaping)', () => {
    expect(buildFtsMatch('say "hi"')).toBe(
      '(title : "say"* OR body : "say"*) AND (title : """hi"""* OR body : """hi"""*)',
    )
  })

  it('collapses runs of whitespace between terms', () => {
    expect(buildFtsMatch('  alpha   beta ')).toBe(
      '(title : "alpha"* OR body : "alpha"*) AND (title : "beta"* OR body : "beta"*)',
    )
  })

  it('drops a term that tokenizes to nothing rather than emptying the query', () => {
    expect(buildFtsMatch('meeting - notes')).toBe(
      '(title : "meeting"* OR body : "meeting"*) AND (title : "notes"* OR body : "notes"*)',
    )
    expect(buildFtsMatch('c++ +')).toBe('(title : "c++"* OR body : "c++"*)')
  })

  it('keeps unsegmented-script terms, whose characters are Unicode letters', () => {
    expect(buildFtsMatch('東京 ・')).toBe('(title : "東京"* OR body : "東京"*)')
    expect(buildFtsMatch('中文')).toBe('(title : "中文"* OR body : "中文"*)')
  })

  it('falls back to the quoted join when no term tokenizes', () => {
    expect(buildFtsMatch('-')).toBe('"-"')
    expect(buildFtsMatch('. -')).toBe('"." "-"')
  })

  it('classifies terms by the tokenizer categories, not by `is alphabetic`', () => {
    // Private use is a token character (`L* N* Co`), so the term constrains.
    expect(buildFtsMatch('\u{F8FF}')).toBe('(title : "\u{F8FF}"* OR body : "\u{F8FF}"*)')
    // A combining mark and an enclosed alphanumeric are separators, even
    // though both carry the Unicode `Alphabetic` property.
    expect(buildFtsMatch('hello \u{345}')).toBe('(title : "hello"* OR body : "hello"*)')
    expect(buildFtsMatch('hello \u{24B6}')).toBe('(title : "hello"* OR body : "hello"*)')
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
