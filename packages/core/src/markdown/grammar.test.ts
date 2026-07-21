import { describe, expect, it } from 'vitest'
import { parseBody } from './grammar'

/** Collect `[from, to)` spans of every node named `name` in `body`. */
function nodeSpans(body: string, name: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  parseBody(body).iterate({
    enter(node) {
      if (node.name === name) {
        spans.push([node.from, node.to])
      }
    },
  })
  return spans
}

function wikiLinkSpans(body: string): Array<[number, number]> {
  return nodeSpans(body, 'Wikilink')
}

describe('parseBody (meowdown gfmParser)', () => {
  it('parses a wiki link with exact source positions', () => {
    const body = 'See [[Target Note]] here'
    expect(wikiLinkSpans(body)).toEqual([[4, 19]])
  })

  it('parses aliased links and multiple links per line', () => {
    const spans = wikiLinkSpans('[[A|Alias]] and [[B]]')
    expect(spans).toHaveLength(2)
  })

  it('wins over the standard markdown Link rule', () => {
    const body = '[[Not A Link]](http://example.com)'
    const spans = wikiLinkSpans(body)
    expect(spans).toEqual([[0, 14]])
  })

  it('ignores empty, unclosed, and multi-line candidates', () => {
    expect(wikiLinkSpans('[[]]')).toEqual([])
    expect(wikiLinkSpans('[[ ]]')).toEqual([]) // whitespace-only target is not a link
    expect(wikiLinkSpans('[[never closed')).toEqual([])
    expect(wikiLinkSpans('[[spans\nlines]]')).toEqual([])
  })

  it('never matches inside code spans or fences', () => {
    expect(wikiLinkSpans('`[[in code]]`')).toEqual([])
    expect(wikiLinkSpans('```\n[[in fence]]\n```')).toEqual([])
  })

  it('requires the first `]` to pair into `]]`', () => {
    expect(wikiLinkSpans('[[a]b]]')).toEqual([])
  })

  it('resolves a nested opener to the inner link', () => {
    expect(wikiLinkSpans('[[a [[b]]')).toEqual([[4, 9]])
  })

  it('parses `![[x]]` as a WikiEmbed node with no Wikilink inside', () => {
    const body = 'See ![[photo.png]] here'
    expect(nodeSpans(body, 'WikiEmbed')).toEqual([[4, 18]])
    expect(wikiLinkSpans(body)).toEqual([])
  })
})
