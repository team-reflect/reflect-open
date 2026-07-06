import { describe, expect, it } from 'vitest'
import type { IndexedNote } from '@reflect/core'
import { createDevBridge } from '@/dev/dev-bridge'
import { createDevFileStore } from '@/dev/dev-file-store'
import { createDevIndexDb } from '@/dev/dev-index-db'

/**
 * The dev bridge's `index_reconcile_scan` mirrors the native scan in
 * `src-tauri/src/db/scan.rs`; the mobile boot path calls it on every open,
 * so a drifted stand-in would rot the `?platform=ios` harness loudly.
 */

function projection(path: string, mtime: number, fileHash: string): IndexedNote {
  return {
    path,
    id: null,
    title: path,
    titleKey: path,
    kind: 'note',
    dailyDate: null,
    isPrivate: false,
    isPinned: false,
    pinnedOrder: null,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
    fileHash,
    mtime,
    text: 'body',
    assetText: '',
    preview: 'body',
    links: [],
    tags: [],
    aliases: [],
    emails: [],
    assets: [],
    tasks: [],
  }
}

describe('dev bridge index_reconcile_scan', () => {
  it('classifies candidates and orphans like the native scan', async () => {
    const files = createDevFileStore({ 'notes/settled.md': '# Settled' })
    const index = await createDevIndexDb()
    const bridge = createDevBridge({ platform: 'ios', files, index })

    // The seeded file's row matches its listed mtime and has settled.
    const settledMtime = files.list()[0]!.modifiedMs
    index.applyNote(projection('notes/settled.md', settledMtime, 'settled-hash'))
    // A row whose file is gone is an orphan.
    index.applyNote(projection('notes/gone.md', 1_000, 'gone-hash'))
    // A file with no row is an arrival candidate (fresh mtime, so it would be
    // a candidate on both grounds).
    files.write('notes/new.md', '# New')

    const scan = (await bridge.invoke('index_reconcile_scan', { generation: 1 })) as {
      total: number
      candidates: Array<{ path: string; storedHash: string | null }>
      orphans: Array<{ path: string; storedHash: string }>
    }

    expect(scan.total).toBe(2)
    expect(scan.candidates.map((candidate) => candidate.path)).toEqual(['notes/new.md'])
    expect(scan.candidates[0]!.storedHash).toBeNull()
    expect(scan.orphans).toEqual([
      { path: 'notes/gone.md', storedMtime: 1_000, storedHash: 'gone-hash' },
    ])
  })
})
