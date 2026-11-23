import { describe, expect, it } from 'vitest'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createDirtySet } from './dirty-set.ts'
import { followFileChanges } from './live.ts'

describe('followFileChanges', () => {
  it('marks the reported notes and asset files dirty, with their kind and mtime', () => {
    const fileChanges = createTestFileChangeService()
    const dirty = createDirtySet()
    followFileChanges(fileChanges, dirty)

    fileChanges.emit({
      changes: [
        { path: 'notes/a.md', kind: 'upsert', modifiedMs: 1234 },
        { path: 'notes/gone.md', kind: 'remove' },
        { path: 'assets/x.png', kind: 'upsert' },
      ],
      source: 'external',
    })

    expect(dirty.take().map((entry) => [entry.path, entry.kind, entry.modifiedMs])).toEqual([
      ['notes/a.md', 'upsert', 1234],
      ['notes/gone.md', 'remove', undefined],
      ['assets/x.png', 'upsert', undefined],
    ])
  })

  it('skips files the index does not track', () => {
    const fileChanges = createTestFileChangeService()
    const dirty = createDirtySet()
    followFileChanges(fileChanges, dirty)

    fileChanges.emit({
      changes: [{ path: 'audio-memos/audio-memo-2026-06-12-090000-000.m4a', kind: 'upsert' }],
      source: 'external',
    })

    expect(dirty.size()).toBe(0)
  })

  it('stops once unlistened', () => {
    const fileChanges = createTestFileChangeService()
    const dirty = createDirtySet()
    followFileChanges(fileChanges, dirty)()

    fileChanges.emit({ changes: [{ path: 'notes/a.md', kind: 'upsert' }], source: 'external' })

    expect(dirty.size()).toBe(0)
  })
})
