import { describe, expect, it } from 'vitest'
import { notePrivate, retitleDailyEntry, withTitle } from './capture-note'

const BASE = 'capture-2026-06-11-153022-845-7c9e'

describe('notePrivate', () => {
  it('fails closed when frontmatter is malformed or unterminated', () => {
    expect(notePrivate('---\nprivate: [\n---\n# Capture\n')).toBe(true)
    expect(notePrivate('---\nprivate: false\n# Capture\n')).toBe(true)
    expect(notePrivate('---\nprivate: false\n---\n# Capture\n')).toBe(false)
  })
})

describe('retitleDailyEntry', () => {
  it('rewrites the entry when the link text still mirrors the old title', () => {
    const daily = `## Links\n\n- [[${BASE}|Old Title]]\n`
    expect(retitleDailyEntry(daily, BASE, 'Old Title', 'New Title')).toBe(
      `## Links\n\n- [[${BASE}|New Title]]\n`,
    )
  })

  it('leaves an edited link text alone — the user’s text wins', () => {
    const daily = `## Links\n\n- [[${BASE}|my own words]]\n`
    expect(retitleDailyEntry(daily, BASE, 'Old Title', 'New Title')).toBe(daily)
  })

  it('is a no-op when the title did not change', () => {
    const daily = `## Links\n\n- [[${BASE}|Same]]\n`
    expect(retitleDailyEntry(daily, BASE, 'Same', 'Same')).toBe(daily)
  })

  it('keeps `$` sequences in titles literal', () => {
    const daily = `## Links\n\n- [[${BASE}|Old Title]]\n`
    expect(retitleDailyEntry(daily, BASE, 'Old Title', 'Costs $& more')).toBe(
      `## Links\n\n- [[${BASE}|Costs $& more]]\n`,
    )
  })
})

describe('withTitle', () => {
  it('rewrites the H1 and the mirrored screenshot alt text', () => {
    const body = `# Old Title\n\n- URL: https://a.com\n- Type: #link\n\n## Screenshot\n\n![Old Title](assets/x.jpg)\n`
    expect(withTitle(body, 'New Title')).toBe(
      `# New Title\n\n- URL: https://a.com\n- Type: #link\n\n## Screenshot\n\n![New Title](assets/x.jpg)\n`,
    )
  })

  it('returns the body unchanged for an identical title', () => {
    const body = '# Same\n\n- Type: #link\n'
    expect(withTitle(body, 'Same')).toBe(body)
  })

  it('throws on a body without the drain-written heading', () => {
    expect(() => withTitle('- Type: #link\n', 'New Title')).toThrow(
      'capture note is missing its title heading',
    )
  })
})
