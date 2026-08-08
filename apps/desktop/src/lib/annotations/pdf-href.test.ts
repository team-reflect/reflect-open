import { describe, expect, it } from 'vitest'
import { parsePdfHref } from './pdf-href'

describe('parsePdfHref', () => {
  it('parses an assets PDF link with a page fragment', () => {
    expect(parsePdfHref('assets/paper.pdf#page=3')).toEqual({
      path: 'assets/paper.pdf',
      page: 3,
    })
  })

  it('parses an assets PDF link without a page fragment', () => {
    expect(parsePdfHref('assets/paper.pdf')).toEqual({ path: 'assets/paper.pdf' })
  })

  it('matches case-insensitively and preserves the authored path casing', () => {
    expect(parsePdfHref('Assets/Paper.PDF#PAGE=2')).toEqual({
      path: 'Assets/Paper.PDF',
      page: 2,
    })
  })

  it('strips a query string before matching the extension', () => {
    expect(parsePdfHref('assets/paper.pdf?raw=1#page=4')).toEqual({
      path: 'assets/paper.pdf',
      page: 4,
    })
  })

  it('rejects non-PDF assets', () => {
    expect(parsePdfHref('assets/notes.docx')).toBeNull()
    expect(parsePdfHref('assets/cat.png#page=2')).toBeNull()
  })

  it('rejects paths outside assets/ and links with a scheme', () => {
    expect(parsePdfHref('notes/paper.pdf')).toBeNull()
    expect(parsePdfHref('https://example.com/assets/paper.pdf#page=3')).toBeNull()
    expect(parsePdfHref('reflect://preview/open?path=notes%2Ffoo.md')).toBeNull()
  })

  it('rejects malformed or non-page fragments', () => {
    expect(parsePdfHref('assets/paper.pdf#page=0')).toBeNull()
    expect(parsePdfHref('assets/paper.pdf#page=abc')).toBeNull()
    expect(parsePdfHref('assets/paper.pdf#page=-1')).toBeNull()
    expect(parsePdfHref('assets/paper.pdf#foo')).toBeNull()
  })

  it('rejects empty hrefs', () => {
    expect(parsePdfHref('')).toBeNull()
  })
})
