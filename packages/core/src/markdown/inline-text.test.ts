import { describe, expect, it } from 'vitest'
import { renderInlineText } from './inline-text.ts'

describe('renderInlineText', () => {
  it('drops emphasis, strikethrough, highlight, and math marks', () => {
    expect(renderInlineText('a **b** _c_ ~~d~~ ==e== $f$')).toBe('a b c d e f')
  })

  it('reduces links and images to their text', () => {
    expect(renderInlineText('see [text](https://x.com "T") and ![alt](i.png)')).toBe(
      'see text and alt',
    )
    expect(renderInlineText('a [ref][r] b')).toBe('a ref b')
  })

  it('keeps bare URLs and autolinks visible', () => {
    expect(renderInlineText('<https://a.com> and https://b.com/x')).toBe(
      'https://a.com and https://b.com/x',
    )
  })

  it('renders a wiki link as its alias, else its target', () => {
    expect(renderInlineText('[[Ada Lovelace|Ada]] ![[pic.png]] [[2026-10-01]]')).toBe(
      'Ada pic.png 2026-10-01',
    )
    expect(renderInlineText('[[a|]]')).toBe('a')
    expect(renderInlineText('call [[Bob]] about **billing**')).toBe('call Bob about billing')
  })

  it('keeps tags and code literal and resolves escapes outside code', () => {
    const code = '`' + String.raw`code \* x` + '`'
    expect(renderInlineText(String.raw`tag #urgent and ${code} and \* esc`)).toBe(
      String.raw`tag #urgent and code \* x and * esc`,
    )
  })

  it('collapses hard breaks, soft breaks, and runs of whitespace', () => {
    expect(renderInlineText('line one  \nline two\\\nthree')).toBe('line one line two three')
    expect(renderInlineText('  spaced \n  out  ')).toBe('spaced out')
    expect(renderInlineText('')).toBe('')
  })

  it('keeps entities literal and drops HTML comments and tags', () => {
    expect(renderInlineText('a &amp; b')).toBe('a &amp; b')
    expect(renderInlineText('x<!-- c -->y <b>z</b>')).toBe('xy z')
  })
})
