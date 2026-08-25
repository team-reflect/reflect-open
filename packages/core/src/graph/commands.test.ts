import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeOwnWrites } from '../indexing/local-write-echo'
import { setBridge } from '../ipc/bridge'
import {
  cancelReflectV1Import,
  claimNoteWindow,
  createNoteIfAbsent,
  importReflectV1Zip,
  markReflectV1ImportOwnWrites,
  openAsset,
  readNoteForAi,
  releaseNoteWindow,
  trashNoteIfRevision,
  subscribeImportProgress,
  IMPORT_PROGRESS_EVENT,
  writeNoteIfRevision,
} from './commands'

afterEach(() => {
  setBridge(null)
})

describe('graph commands', () => {
  it('claims and releases one native live-note owner token', async () => {
    const invoke = vi.fn(async () => null)
    setBridge({ invoke, listen: async () => () => {} })

    await claimNoteWindow('notes/a.md', 'owner-1', 7)
    await releaseNoteWindow('notes/a.md', 'owner-1')

    expect(invoke).toHaveBeenNthCalledWith(1, 'note_window_claim', {
      path: 'notes/a.md',
      ownerId: 'owner-1',
      generation: 7,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'note_window_release', {
      path: 'notes/a.md',
      ownerId: 'owner-1',
    })
  })

  it('validates the leakage-free guarded AI read outcome', async () => {
    const invoke = vi.fn(async () => ({ kind: 'blocked' }))
    setBridge({ invoke, listen: async () => () => {} })

    await expect(readNoteForAi('notes/private-live.md', 7)).resolves.toEqual({ kind: 'blocked' })
    expect(invoke).toHaveBeenCalledWith('note_read_for_ai', {
      path: 'notes/private-live.md',
      generation: 7,
    })
  })
  it('creates a note through the generation-pinned no-clobber boundary', async () => {
    const invoke = vi.fn(async () => ({ kind: 'created', modifiedMs: 1_234 }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })

    try {
      await expect(
        createNoteIfAbsent('notes/business-ideas.md', '# Business ideas\n', 7),
      ).resolves.toEqual({ kind: 'created', modifiedMs: 1_234 })
      expect(invoke).toHaveBeenCalledWith('note_create', {
        path: 'notes/business-ideas.md',
        contents: '# Business ideas\n',
        generation: 7,
      })
      expect(ownWrites).toEqual(['notes/business-ideas.md'])
    } finally {
      unlisten()
    }
  })

  it('propagates a note-create rejection without echoing a local write', async () => {
    // The failure side of the generation pin: a stale-generation bridge
    // rejection reaches the caller, and nothing pretends a file was written.
    const invoke = vi.fn(async () => {
      throw { kind: 'io', message: 'the graph changed since this command was issued; dropping it' }
    })
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })

    try {
      await expect(
        createNoteIfAbsent('notes/business-ideas.md', '# Business ideas\n', 6),
      ).rejects.toMatchObject({ kind: 'io' })
      expect(ownWrites).toEqual([])
    } finally {
      unlisten()
    }
  })

  it('returns a note-create collision without echoing a local write', async () => {
    const invoke = vi.fn(async () => ({ kind: 'collision' }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })

    try {
      await expect(
        createNoteIfAbsent('notes/business-ideas.md', '# Replacement\n', 7),
      ).resolves.toEqual({ kind: 'collision' })
      expect(ownWrites).toEqual([])
    } finally {
      unlisten()
    }
  })

  it('writes a note only at the expected complete-source revision', async () => {
    const invoke = vi.fn(async () => ({
      kind: 'written',
      revision: 'after-revision',
      modifiedMs: 1_234,
    }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })
    try {
      await expect(
        writeNoteIfRevision('notes/a.md', '# After\n', 'before-revision', 7),
      ).resolves.toEqual({
        kind: 'written',
        revision: 'after-revision',
        modifiedMs: 1_234,
      })
      expect(invoke).toHaveBeenCalledWith('note_write_if_revision', {
        path: 'notes/a.md',
        contents: '# After\n',
        expectedRevision: 'before-revision',
        generation: 7,
      })
      expect(ownWrites).toEqual(['notes/a.md'])
    } finally {
      unlisten()
    }
  })

  it('does not announce stale compare-and-swap writes', async () => {
    const invoke = vi.fn(async () => ({ kind: 'stale', currentRevision: 'newer' }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })
    try {
      await expect(
        writeNoteIfRevision('notes/a.md', '# After\n', 'before-revision', 7),
      ).resolves.toEqual({ kind: 'stale', currentRevision: 'newer' })
      expect(ownWrites).toEqual([])
    } finally {
      unlisten()
    }
  })

  it('parses contended guarded mutations without announcing a successful write', async () => {
    const responses = [
      { kind: 'contended', currentRevision: 'external-revision' },
      { kind: 'contended', currentRevision: null },
    ]
    const invoke = vi.fn(async () => responses.shift())
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })
    try {
      await expect(
        writeNoteIfRevision('notes/a.md', '# After\n', 'before-revision', 7),
      ).resolves.toEqual({ kind: 'contended', currentRevision: 'external-revision' })
      await expect(trashNoteIfRevision('notes/a.md', 'expected', 7)).resolves.toEqual({
        kind: 'contended',
        currentRevision: null,
      })
      expect(ownWrites).toEqual([])
    } finally {
      unlisten()
    }
  })

  it('moves a note to trash only at the expected revision', async () => {
    const invoke = vi.fn(async () => ({ kind: 'trashed' }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })
    try {
      await expect(trashNoteIfRevision('notes/a.md', 'expected', 7)).resolves.toEqual({
        kind: 'trashed',
      })
      expect(invoke).toHaveBeenCalledWith('note_trash_if_revision', {
        path: 'notes/a.md',
        expectedRevision: 'expected',
        generation: 7,
      })
      expect(ownWrites).toEqual(['notes/a.md'])
    } finally {
      unlisten()
    }
  })

  it('opens assets through the generation-pinned native command', async () => {
    const invoke = vi.fn(async () => null)
    setBridge({ invoke, listen: async () => () => {} })

    await openAsset('assets/cat.png', 7)

    expect(invoke).toHaveBeenCalledWith('asset_open', {
      path: 'assets/cat.png',
      generation: 7,
    })
  })

  it('imports Reflect V1 zips through the generation-pinned native command', async () => {
    const invoke = vi.fn(async () => ({
      importedFiles: 2,
      skippedFiles: 0,
      downloadedAssets: 0,
      failedAssetDownloads: 0,
      renamedFiles: 0,
      mergedFiles: 0,
      changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
    }))
    setBridge({ invoke, listen: async () => () => {} })
    const summary = await importReflectV1Zip('/tmp/reflect-v1.zip', 7)

    expect(invoke).toHaveBeenCalledWith('graph_import_reflect_v1_zip', {
      path: '/tmp/reflect-v1.zip',
      generation: 7,
    })
    expect(summary).toEqual({
      importedFiles: 2,
      skippedFiles: 0,
      downloadedAssets: 0,
      failedAssetDownloads: 0,
      renamedFiles: 0,
      mergedFiles: 0,
      changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
    })
  })

  it('surfaces validated import progress ticks and drops malformed ones', async () => {
    let emit: ((payload: unknown) => void) | null = null
    setBridge({
      invoke: async () => null,
      listen: async (event, handler) => {
        expect(event).toBe(IMPORT_PROGRESS_EVENT)
        emit = handler
        return () => {}
      },
    })
    const seen: unknown[] = []
    await subscribeImportProgress((progress) => {
      seen.push(progress)
    })
    if (emit === null) {
      throw new Error('expected the subscription to register a listener')
    }
    const publish: (payload: unknown) => void = emit

    publish({ stage: 'downloading', done: 1, total: 4 })
    publish({ stage: 'launching', done: 1, total: 4 })

    expect(seen).toEqual([{ stage: 'downloading', done: 1, total: 4 }])
  })

  it('cancels the running import through the native command', async () => {
    const invoke = vi.fn(async () => null)
    setBridge({ invoke, listen: async () => () => {} })

    await cancelReflectV1Import()

    expect(invoke).toHaveBeenCalledWith('graph_import_cancel', {})
  })

  it('marks completed import files as this device’s own writes', () => {
    const seen: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      seen.push(path)
    })
    try {
      markReflectV1ImportOwnWrites({
        importedFiles: 2,
        skippedFiles: 0,
        downloadedAssets: 0,
        failedAssetDownloads: 0,
        renamedFiles: 0,
        mergedFiles: 0,
        changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
      })

      expect(seen).toEqual(['notes/a.md', 'daily/2026-07-04.md'])
    } finally {
      unlisten()
    }
  })
})
