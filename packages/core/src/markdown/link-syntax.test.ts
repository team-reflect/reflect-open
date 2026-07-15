import { describe, expect, it } from 'vitest'
import { parseInlineLink } from './link-syntax'

describe('parseInlineLink', () => {
  it('decomposes a plain inline link', () => {
    expect(parseInlineLink('[text](https://example.com/page)')).toEqual({
      isImage: false,
      text: 'text',
      href: 'https://example.com/page',
      destination: { from: 7, to: 31 },
    })
  })

  it('drops a quoted title suffix from the href', () => {
    expect(parseInlineLink('[x](https://example.com "the title")')).toEqual({
      isImage: false,
      text: 'x',
      href: 'https://example.com',
      destination: { from: 4, to: 23 },
    })
    expect(parseInlineLink("[x](assets/a.png 'single quoted')")).toEqual({
      isImage: false,
      text: 'x',
      href: 'assets/a.png',
      destination: { from: 4, to: 16 },
    })
  })

  it('strips angle brackets from a bracketed href', () => {
    expect(parseInlineLink('[t](<assets/with space.png>)')).toEqual({
      isImage: false,
      text: 't',
      href: 'assets/with space.png',
      destination: { from: 5, to: 26 },
    })
  })

  it('flags the image form and allows an empty alt', () => {
    expect(parseInlineLink('![](assets/a.png)')).toEqual({
      isImage: true,
      text: '',
      href: 'assets/a.png',
      destination: { from: 4, to: 16 },
    })
    expect(parseInlineLink('![alt text](assets/b.png)')).toEqual({
      isImage: true,
      text: 'alt text',
      href: 'assets/b.png',
      destination: { from: 12, to: 24 },
    })
  })

  it('returns null for reference-style and malformed sources', () => {
    expect(parseInlineLink('[text][ref]')).toBeNull()
    expect(parseInlineLink('[text]')).toBeNull()
    expect(parseInlineLink('[text](unclosed')).toBeNull()
    expect(parseInlineLink('not a link at all')).toBeNull()
  })
})
