import { describe, expect, it } from 'vitest'
import { scanInlineImages, scanInlineSegments, scanInlineWikiLinks } from './scan'

describe('scanInlineWikiLinks', () => {
  it('finds plain and aliased links with display spans', () => {
    const text = 'See [[Charlotte]] and [[Project X|the project]].'
    const links = scanInlineWikiLinks(text)
    expect(links).toHaveLength(2)

    const plain = links[0]!
    const aliased = links[1]!
    expect(plain.target).toBe('Charlotte')
    expect(plain.alias).toBeNull()
    expect(text.slice(plain.from, plain.to)).toBe('[[Charlotte]]')
    expect(text.slice(plain.displayFrom, plain.displayTo)).toBe('Charlotte')

    expect(aliased.target).toBe('Project X')
    expect(aliased.alias).toBe('the project')
    expect(text.slice(aliased.from, aliased.to)).toBe('[[Project X|the project]]')
    expect(text.slice(aliased.displayFrom, aliased.displayTo)).toBe('the project')
  })

  it('falls back to the target when the alias is blank', () => {
    const text = 'see [[Target|   ]] here'
    const link = scanInlineWikiLinks(text)[0]!
    expect(link.alias).toBeNull()
    expect(text.slice(link.displayFrom, link.displayTo)).toBe('Target')
  })

  it('respects code contexts, same as the indexer grammar', () => {
    expect(scanInlineWikiLinks('code `[[NotALink]]` stays literal')).toEqual([])
    expect(scanInlineWikiLinks('and [[]] is not a link')).toEqual([])
  })

  it('returns [] quickly for text without brackets', () => {
    expect(scanInlineWikiLinks('no links here')).toEqual([])
  })
})

describe('scanInlineImages', () => {
  it('finds images with alt and src spans', () => {
    const text = 'A pic ![screenshot](assets/shot.png) and ![](https://x.com/i.jpg "t").'
    const images = scanInlineImages(text)
    expect(images).toHaveLength(2)
    expect(images[0]).toMatchObject({ alt: 'screenshot', src: 'assets/shot.png' })
    expect(text.slice(images[0]!.from, images[0]!.to)).toBe('![screenshot](assets/shot.png)')
    expect(images[1]).toMatchObject({ alt: '', src: 'https://x.com/i.jpg' })
  })

  it('respects code contexts and plain links', () => {
    expect(scanInlineImages('code `![x](y.png)` stays literal')).toEqual([])
    expect(scanInlineImages('a [link](not-an-image.png) only')).toEqual([])
    expect(scanInlineImages('no images')).toEqual([])
  })
})

describe('scanInlineSegments', () => {
  it('returns a single text segment for plain content', () => {
    expect(scanInlineSegments('just buy milk')).toEqual([{ kind: 'text', text: 'just buy milk' }])
  })

  it('interleaves text, wiki links, and markdown links in document order', () => {
    expect(scanInlineSegments('call [[Bob]] re [the doc](https://x.com/d) today')).toEqual([
      { kind: 'text', text: 'call ' },
      { kind: 'wikiLink', target: 'Bob', alias: null },
      { kind: 'text', text: ' re ' },
      { kind: 'link', text: 'the doc', href: 'https://x.com/d' },
      { kind: 'text', text: ' today' },
    ])
  })

  it('keeps a wiki link target and alias separate', () => {
    expect(scanInlineSegments('[[2026-06-20|Friday]] ship')).toEqual([
      { kind: 'wikiLink', target: '2026-06-20', alias: 'Friday' },
      { kind: 'text', text: ' ship' },
    ])
  })

  it('segments a bare autolinked URL as a link', () => {
    expect(scanInlineSegments('read https://example.com/x now')).toEqual([
      { kind: 'text', text: 'read ' },
      { kind: 'link', text: 'https://example.com/x', href: 'https://example.com/x' },
      { kind: 'text', text: ' now' },
    ])
  })

  it('leaves links inside a code span as literal text (no regex false-positive)', () => {
    expect(scanInlineSegments('code `[[NotALink]]` stays literal')).toEqual([
      { kind: 'text', text: 'code `[[NotALink]]` stays literal' },
    ])
  })
})
