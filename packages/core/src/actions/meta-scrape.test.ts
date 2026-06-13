// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parsePageMeta } from './meta-scrape'

describe('parsePageMeta', () => {
  it('prefers OpenGraph tags over the document fallbacks', () => {
    const meta = parsePageMeta(`
      <html><head>
        <title>Doc title</title>
        <meta name="description" content="Plain description">
        <meta property="og:title" content="OG title">
        <meta property="og:description" content="OG description">
        <meta property="og:site_name" content="Example">
      </head><body></body></html>
    `)
    expect(meta).toEqual({
      title: 'OG title',
      description: 'OG description',
      siteName: 'Example',
    })
  })

  it('falls back to <title> and the meta description', () => {
    const meta = parsePageMeta(
      '<html><head><title>Doc title</title><meta name="description" content="Plain"></head></html>',
    )
    expect(meta).toEqual({ title: 'Doc title', description: 'Plain', siteName: null })
  })

  it('reads a page with no metadata as all nulls', () => {
    expect(parsePageMeta('<p>hello</p>')).toEqual({
      title: null,
      description: null,
      siteName: null,
    })
  })

  it('collapses whitespace and treats blank values as absent', () => {
    const meta = parsePageMeta(`
      <html><head>
        <title>  A
        wrapped   title </title>
        <meta name="description" content="   ">
      </head></html>
    `)
    expect(meta).toEqual({ title: 'A wrapped title', description: null, siteName: null })
  })

  it('caps runaway values', () => {
    const meta = parsePageMeta(
      `<html><head><meta name="description" content="${'x'.repeat(2000)}"></head></html>`,
    )
    expect(meta.description).toHaveLength(500)
  })
})
