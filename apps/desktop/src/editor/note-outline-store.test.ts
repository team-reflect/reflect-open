import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearOutline,
  getOutline,
  publishOutline,
  publishOutlineFromMarkdown,
  subscribeOutline,
} from './note-outline-store'

const NOTE = 'notes/a.md'

afterEach(() => {
  clearOutline(NOTE)
  clearOutline('notes/b.md')
})

describe('note-outline-store', () => {
  it('returns a stable empty reference for an unknown path', () => {
    expect(getOutline(NOTE)).toEqual([])
    expect(getOutline(NOTE)).toBe(getOutline('notes/b.md'))
  })

  it('publishes headings and notifies subscribers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOutline(NOTE, listener)
    publishOutline(NOTE, [{ level: 1, text: 'A', slug: 'a', from: 0, to: 1 }])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getOutline(NOTE).map((heading) => heading.text)).toEqual(['A'])
    unsubscribe()
  })

  it('keeps the same reference until the next publish', () => {
    publishOutline(NOTE, [{ level: 1, text: 'A', slug: 'a', from: 0, to: 1 }])
    const first = getOutline(NOTE)
    expect(getOutline(NOTE)).toBe(first)
    publishOutline(NOTE, [{ level: 2, text: 'B', slug: 'b', from: 2, to: 3 }])
    expect(getOutline(NOTE)).not.toBe(first)
  })

  it('isolates paths and stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeOutline(NOTE, listener)
    publishOutline('notes/b.md', [])
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
    publishOutline(NOTE, [])
    expect(listener).not.toHaveBeenCalled()
  })

  it('parses markdown headings via publishOutlineFromMarkdown', () => {
    publishOutlineFromMarkdown(NOTE, '# Title\n\n## Section one\n\ntext\n\n### Nested')
    expect(getOutline(NOTE).map((heading) => [heading.level, heading.text])).toEqual([
      [1, 'Title'],
      [2, 'Section one'],
      [3, 'Nested'],
    ])
  })
})
