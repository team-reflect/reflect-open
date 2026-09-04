import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { gitMergeRemote } from './commands'

afterEach(() => {
  setBridge(null)
})

function respondWithChanges(changedFiles: unknown[]) {
  const invoke = vi.fn(async () => ({
    kind: 'merged',
    conflictedPaths: [],
    skippedLargeFiles: [],
    changedFiles,
  }))
  setBridge({ invoke, listen: async () => () => {} })
  return invoke
}

describe('gitMergeRemote', () => {
  it('normalizes native deletion timestamps without changing upsert timestamps', async () => {
    const invoke = respondWithChanges([
      { path: 'notes/deleted.md', kind: 'remove', modifiedMs: null },
      { path: 'notes/updated.md', kind: 'upsert', modifiedMs: 1788540000123 },
    ])

    const result = await gitMergeRemote(7)

    expect(invoke).toHaveBeenCalledWith('git_merge_remote', { generation: 7 })
    expect(result.changedFiles).toEqual([
      { path: 'notes/deleted.md', kind: 'remove', modifiedMs: undefined },
      { path: 'notes/updated.md', kind: 'upsert', modifiedMs: 1788540000123 },
    ])
  })

  it('accepts unavailable and omitted upsert timestamps for downstream fallback', async () => {
    respondWithChanges([
      { path: 'notes/no-metadata.md', kind: 'upsert', modifiedMs: null },
      { path: 'notes/omitted.md', kind: 'upsert' },
    ])

    const result = await gitMergeRemote(7)

    expect(result.changedFiles.map((change) => change.modifiedMs)).toEqual([undefined, undefined])
  })

  it('still rejects malformed timestamps at the IPC boundary', async () => {
    respondWithChanges([{ path: 'notes/invalid.md', kind: 'upsert', modifiedMs: 'yesterday' }])

    await expect(gitMergeRemote(7)).rejects.toMatchObject({ kind: 'parse' })
  })
})
