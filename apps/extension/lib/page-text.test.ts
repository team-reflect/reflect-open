import { describe, expect, it } from 'vitest'
import { formatParagraphs, normalizeParagraphText, samePageUrl } from './page-text'

describe('normalizeParagraphText', () => {
  it('collapses inline whitespace inside one paragraph', () => {
    expect(normalizeParagraphText('  First\n paragraph\t with   spaces.  ')).toBe(
      'First paragraph with spaces.',
    )
  })
})

describe('formatParagraphs', () => {
  it('keeps paragraph breaks while dropping empty paragraphs', () => {
    expect(formatParagraphs([' First paragraph. ', ' ', 'Second\nparagraph.'])).toBe(
      'First paragraph.\n\nSecond paragraph.',
    )
  })
})

describe('samePageUrl', () => {
  it('accepts normalized-equivalent page URLs', () => {
    expect(samePageUrl('https://example.com:443/article#intro', 'https://example.com/article')).toBe(
      true,
    )
  })

  it('rejects different pages', () => {
    expect(samePageUrl('https://example.com/article', 'https://example.com/other')).toBe(false)
  })
})
