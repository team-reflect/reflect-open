import { describe, expect, it } from 'vitest'
import { createDirtySet } from './dirty-set.ts'
import { markFileChanges } from './live.ts'

describe('markFileChanges', () => {
  it('marks the reported notes and asset files dirty, with their kind and mtime', () => {
    const dirty = createDirtySet()

    markFileChanges(dirty, [
      { path: 'notes/a.md', kind: 'upsert', modifiedMs: 1234 },
      { path: 'notes/gone.md', kind: 'remove' },
      { path: 'assets/x.png', kind: 'upsert' },
    ])

    expect(dirty.take().map((entry) => [entry.path, entry.kind, entry.modifiedMs])).toEqual([
      ['notes/a.md', 'upsert', 1234],
      ['notes/gone.md', 'remove', undefined],
      ['assets/x.png', 'upsert', undefined],
    ])
  })

  it('skips files the index does not track', () => {
    const dirty = createDirtySet()

    markFileChanges(dirty, [
      { path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a', kind: 'upsert' },
    ])

    expect(dirty.size()).toBe(0)
  })
})
