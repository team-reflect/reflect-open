import { describe, expect, it } from 'vitest'
import { retitleWikiLinks } from './retitle'

/** Repoint only: the shape the pre-stable-display rewrite always used. */
function repointOnly(fromKey: string, to: string) {
  return { repoint: { fromKey, to }, display: null, subjectTargetKeys: new Set<string>() }
}

describe('retitleWikiLinks', () => {
  it('rewrites matching targets, preserves displays, skips code and non-matches', () => {
    const source = '[[Foo]] and [[foo|bar]] and `[[Foo]]` and [[Other]]'
    expect(retitleWikiLinks(source, repointOnly('foo', 'Baz'))).toBe(
      '[[Baz]] and [[Baz|bar]] and `[[Foo]]` and [[Other]]',
    )
  })

  it('is a byte-identical no-op when nothing matches', () => {
    const source = 'see [[Alpha]] and [[Beta]]'
    expect(retitleWikiLinks(source, repointOnly('gamma', 'Delta'))).toBe(source)
  })

  it('matches on the trimmed, case-folded target', () => {
    const source = '[[ Foo ]] and [[Foo]] and [[ foo|bar]]'
    expect(retitleWikiLinks(source, repointOnly('foo', 'Baz'))).toBe(
      '[[Baz]] and [[Baz]] and [[Baz|bar]]',
    )
  })

  it('rejects a destination target containing wiki-link syntax', () => {
    expect(() => retitleWikiLinks('[[Foo]]', repointOnly('foo', 'A|B'))).toThrow(
      /invalid wiki-link target/i,
    )
  })

  it('syncs only a display that exactly mirrors the old title', () => {
    const source = '[[stable|Old Title]] [[stable|Mum]] [[stable|old title]] [[stable]]'
    expect(
      retitleWikiLinks(source, {
        repoint: null,
        display: { from: 'Old Title', to: 'New Title' },
        subjectTargetKeys: new Set(['stable']),
      }),
    ).toBe('[[stable|New Title]] [[stable|Mum]] [[stable|old title]] [[stable]]')
  })

  it('leaves a mirroring display alone when its target is not the subject', () => {
    const source = '[[other|Old Title]]'
    expect(
      retitleWikiLinks(source, {
        repoint: null,
        display: { from: 'Old Title', to: 'New Title' },
        subjectTargetKeys: new Set(['stable']),
      }),
    ).toBe(source)
  })

  it('leaves every display alone when the new one is not writable', () => {
    const source = '[[stable|Old Title]]'
    expect(
      retitleWikiLinks(source, {
        repoint: null,
        display: null,
        subjectTargetKeys: new Set(['stable']),
      }),
    ).toBe(source)
  })

  it('repoints a target and syncs a stable display in one pass', () => {
    expect(
      retitleWikiLinks('[[Old Title]] and [[stable|Old Title]]\n', {
        repoint: { fromKey: 'old title', to: 'New Title' },
        display: { from: 'Old Title', to: 'New Title' },
        subjectTargetKeys: new Set(['old title', 'stable']),
      }),
    ).toBe('[[New Title]] and [[stable|New Title]]\n')
  })

  it('keeps an untouched target byte-identical when only the display changes', () => {
    expect(
      retitleWikiLinks('[[stable\\_addr|Old Title]]\n', {
        repoint: null,
        display: { from: 'Old Title', to: 'New Title' },
        subjectTargetKeys: new Set(['stable_addr']),
      }),
    ).toBe('[[stable\\_addr|New Title]]\n')
  })

  it('keeps display padding when only the target changes', () => {
    expect(retitleWikiLinks('[[Foo| bar ]]', repointOnly('foo', 'Baz'))).toBe('[[Baz| bar ]]')
  })
})

