// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parsePageMeta } from './meta-scrape'

const BASE_URL = 'https://example.com/article'

describe('parsePageMeta', () => {
  it('prefers OpenGraph tags over the document fallbacks', () => {
    const meta = parsePageMeta(
      `
      <html><head>
        <title>Doc title</title>
        <meta name="description" content="Plain description">
        <meta property="og:title" content="OG title">
        <meta property="og:description" content="OG description">
        <meta property="og:site_name" content="Example">
      </head><body></body></html>
    `,
      BASE_URL,
    )
    expect(meta).toEqual({
      title: 'OG title',
      description: 'OG description',
      siteName: 'Example',
      image: null,
    })
  })

  it('parses the OpenGraph shape returned for an Instagram reel', () => {
    const meta = parsePageMeta(
      `
      <html><head>
        <meta property="og:title" content="First Chair on Instagram: &quot;A walnut lounge chair&quot;">
        <meta property="og:description" content="Furniture &amp; decor from an independent studio.">
        <meta property="og:site_name" content="Instagram">
        <meta property="og:image" content="https://scontent.cdninstagram.com/v/cover.jpg?stp=dst-jpg_e35">
      </head><body></body></html>
    `,
      'https://www.instagram.com/reel/example/',
    )

    expect(meta).toEqual({
      title: 'First Chair on Instagram: "A walnut lounge chair"',
      description: 'Furniture & decor from an independent studio.',
      siteName: 'Instagram',
      image: 'https://scontent.cdninstagram.com/v/cover.jpg?stp=dst-jpg_e35',
    })
  })

  it('falls back to <title> and the meta description', () => {
    const meta = parsePageMeta(
      '<html><head><title>Doc title</title><meta name="description" content="Plain"></head></html>',
      BASE_URL,
    )
    expect(meta).toEqual({ title: 'Doc title', description: 'Plain', siteName: null, image: null })
  })

  it('reads a page with no metadata as all nulls', () => {
    expect(parsePageMeta('<p>hello</p>', BASE_URL)).toEqual({
      title: null,
      description: null,
      siteName: null,
      image: null,
    })
  })

  it('collapses whitespace and treats blank values as absent', () => {
    const meta = parsePageMeta(
      `
      <html><head>
        <title>  A
        wrapped   title </title>
        <meta name="description" content="   ">
      </head></html>
    `,
      BASE_URL,
    )
    expect(meta).toEqual({ title: 'A wrapped title', description: null, siteName: null, image: null })
  })

  it('caps runaway values', () => {
    const meta = parsePageMeta(
      `<html><head><meta name="description" content="${'x'.repeat(2000)}"></head></html>`,
      BASE_URL,
    )
    expect(meta.description).toHaveLength(500)
  })

  it('resolves a relative preview image against the page URL, uncapped', () => {
    const longPath = `/covers/${'a'.repeat(600)}.jpg`
    const meta = parsePageMeta(
      `<html><head><meta property="og:image" content="${longPath}"></head></html>`,
      BASE_URL,
    )
    expect(meta.image).toBe(`https://example.com${longPath}`)
  })

  it('falls back to twitter:image when og:image is blank or invalid', () => {
    const meta = parsePageMeta(
      `<html><head>
        <meta property="og:image" content="   ">
        <meta name="twitter:image" content="https://example.com/card.png">
      </head></html>`,
      BASE_URL,
    )
    expect(meta.image).toBe('https://example.com/card.png')
  })

  it('falls back to twitter:image when og:image is absent', () => {
    const meta = parsePageMeta(
      '<html><head><meta name="twitter:image" content="https://example.com/card.png"></head></html>',
      BASE_URL,
    )
    expect(meta.image).toBe('https://example.com/card.png')
  })

  it('refuses non-http(s) preview images', () => {
    const meta = parsePageMeta(
      '<html><head><meta property="og:image" content="data:image/png;base64,aGk="></head></html>',
      BASE_URL,
    )
    expect(meta.image).toBeNull()
  })
})
