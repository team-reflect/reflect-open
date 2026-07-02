import { describe, expect, it } from 'vitest'
import { DEEP_LINK_TEXT_MAX_LENGTH } from '@/lib/deep-links/deep-link'
import { parseDeepLink } from '@/lib/deep-links/parse'

describe('parseDeepLink', () => {
  it('parses the bare navigation verbs', () => {
    expect(parseDeepLink('reflect://today')).toEqual({
      kind: 'navigate',
      route: { kind: 'today' },
    })
    expect(parseDeepLink('reflect://tasks')).toEqual({
      kind: 'navigate',
      route: { kind: 'tasks' },
    })
  })

  it('tolerates a trailing slash and the host lower-casing of the parser', () => {
    expect(parseDeepLink('reflect://today/')).toEqual({
      kind: 'navigate',
      route: { kind: 'today' },
    })
    expect(parseDeepLink('reflect://Today')).toEqual({
      kind: 'navigate',
      route: { kind: 'today' },
    })
  })

  it('rejects stray path segments on bare verbs', () => {
    expect(parseDeepLink('reflect://today/extra')).toBeNull()
    expect(parseDeepLink('reflect://tasks/2026')).toBeNull()
  })

  it('parses calendar-valid daily dates and rejects impossible ones', () => {
    expect(parseDeepLink('reflect://daily/2026-07-01')).toEqual({
      kind: 'navigate',
      route: { kind: 'daily', date: '2026-07-01' },
    })
    expect(parseDeepLink('reflect://daily/2026-02-31')).toBeNull()
    expect(parseDeepLink('reflect://daily/not-a-date')).toBeNull()
    expect(parseDeepLink('reflect://daily')).toBeNull()
  })

  it('parses search queries, including an empty one', () => {
    expect(parseDeepLink('reflect://search?q=meeting%20notes')).toEqual({
      kind: 'navigate',
      route: { kind: 'search', query: 'meeting notes' },
    })
    expect(parseDeepLink('reflect://search?q=')).toEqual({
      kind: 'navigate',
      route: { kind: 'search', query: '' },
    })
    expect(parseDeepLink('reflect://search')).toBeNull()
  })

  it('parses note targets in encoded, raw-slash, and id forms', () => {
    expect(parseDeepLink('reflect://note/Project%20X')).toEqual({
      kind: 'openNote',
      target: 'Project X',
    })
    expect(parseDeepLink('reflect://note/notes/foo.md')).toEqual({
      kind: 'openNote',
      target: 'notes/foo.md',
    })
    expect(parseDeepLink('reflect://note/notes%2Ffoo.md')).toEqual({
      kind: 'openNote',
      target: 'notes/foo.md',
    })
    expect(parseDeepLink('reflect://note/x7Kp2q')).toEqual({
      kind: 'openNote',
      target: 'x7Kp2q',
    })
  })

  it('rejects an empty note target and malformed percent-encoding', () => {
    expect(parseDeepLink('reflect://note')).toBeNull()
    expect(parseDeepLink('reflect://note/')).toBeNull()
    expect(parseDeepLink('reflect://note/%E0%A4%A')).toBeNull()
  })

  it('parses write links into capture payloads', () => {
    expect(parseDeepLink('reflect://append?text=hello%20world')).toEqual({
      kind: 'capture',
      capture: 'append',
      text: 'hello world',
    })
    expect(parseDeepLink('reflect://task?text=Buy+milk')).toEqual({
      kind: 'capture',
      capture: 'task',
      text: 'Buy milk',
    })
  })

  it('folds capture text to a single trimmed line', () => {
    expect(parseDeepLink('reflect://append?text=%20line%20one%0A%0A%23%20line%20two%20')).toEqual({
      kind: 'capture',
      capture: 'append',
      text: 'line one # line two',
    })
  })

  it('rejects empty, whitespace-only, and over-long capture text', () => {
    expect(parseDeepLink('reflect://append')).toBeNull()
    expect(parseDeepLink('reflect://append?text=')).toBeNull()
    expect(parseDeepLink('reflect://append?text=%20%0A%20')).toBeNull()
    const oversized = 'a'.repeat(DEEP_LINK_TEXT_MAX_LENGTH + 1)
    expect(parseDeepLink(`reflect://append?text=${oversized}`)).toBeNull()
  })

  it('rejects write links carrying a path segment', () => {
    expect(parseDeepLink('reflect://append/extra?text=hi')).toBeNull()
  })

  it('rejects other schemes, unknown verbs, and non-URLs', () => {
    expect(parseDeepLink('https://today')).toBeNull()
    expect(parseDeepLink('reflect://settings')).toBeNull()
    expect(parseDeepLink('reflect://edit-notes?content=evil')).toBeNull()
    expect(parseDeepLink('not a url')).toBeNull()
    expect(parseDeepLink('')).toBeNull()
  })
})
