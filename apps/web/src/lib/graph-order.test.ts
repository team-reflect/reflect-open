import type { RecentGraph } from '@reflect/core'
import { describe, expect, it } from 'vitest'
import { sortGraphsByName } from './graph-order.ts'

function recentGraph(root: string, openedMs: number, name: string = root): RecentGraph {
  return { root, name, openedMs }
}

describe('sortGraphsByName', () => {
  it('orders graphs alphabetically by name, ignoring the recents (most-recently-used) order', () => {
    const banana = recentGraph('/graphs/2', 2, 'Banana')
    const apple = recentGraph('/graphs/1', 1, 'Apple')
    const input = [banana, apple]

    expect(sortGraphsByName(input)).toEqual([apple, banana])
    expect(input).toEqual([banana, apple])
  })

  it('sorts case-insensitively and breaks ties by root path', () => {
    const lower = recentGraph('/graphs/z', 1, 'alpha')
    const upper = recentGraph('/graphs/a', 2, 'Alpha')

    expect(sortGraphsByName([lower, upper])).toEqual([upper, lower])
  })

  it('keeps a stable order for roots that collate as equal but differ in encoding', () => {
    const composed = recentGraph('/graphs/\u{E9}', 1, 'Notes')
    const decomposed = recentGraph('/graphs/e\u{301}', 2, 'Notes')

    expect(composed.root.localeCompare(decomposed.root)).toBe(0)
    expect(sortGraphsByName([composed, decomposed])).toEqual([decomposed, composed])
    expect(sortGraphsByName([decomposed, composed])).toEqual([decomposed, composed])
  })
})
