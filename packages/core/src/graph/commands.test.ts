import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeOwnWrites } from '../indexing/local-write-echo'
import { setBridge } from '../ipc/bridge'
import {
  assetPrivacySnapshot,
  cancelReflectV1Import,
  createNoteIfAbsent,
  importReflectV1Zip,
  deleteNote,
  listAttachments,
  listDir,
  markReflectV1ImportOwnWrites,
  openAsset,
  noteExists,
  readAsset,
  readNote,
  readManagedAsset,
  readManagedAssetDescription,
  resolveAttachment,
  subscribeImportProgress,
  writeNoteIfUnchanged,
  writeAsset,
  writeManagedAssetDescription,
  writeNote,
  IMPORT_PROGRESS_EVENT,
} from './commands'

afterEach(() => {
  setBridge(null)
})

describe('graph commands', () => {
  it('rejects ineligible note, asset, and directory paths before IPC', async () => {
    const invoke = vi.fn(async () => null)
    setBridge({ invoke, listen: async () => () => {} })

    for (const path of ['.git/config', '.hidden.md', 'assets/sidecar.md', 'README.MD']) {
      await expect(readNote(path)).rejects.toThrow()
      await expect(writeNote(path, 'no', 7)).rejects.toThrow()
      await expect(writeNoteIfUnchanged(path, null, 'no', 7)).rejects.toThrow()
      await expect(createNoteIfAbsent(path, 'no', 7)).rejects.toThrow()
      await expect(noteExists(path)).rejects.toThrow()
      await expect(deleteNote(path, 7)).rejects.toThrow()
    }
    for (const path of ['Media/a.png', 'assets/.hidden.png', 'assets/readme.txt']) {
      await expect(readAsset(path, 7)).rejects.toThrow()
      await expect(writeAsset(path, 'cG5n', 7)).rejects.toThrow()
    }
    for (const dir of ['.git', 'notes', 'assets/nested']) {
      await expect(listDir(dir, 7)).rejects.toThrow()
    }

    expect(invoke).not.toHaveBeenCalled()
  })

  it('conditionally writes and echoes only a landed native replacement', async () => {
    const invoke = vi.fn(async () => ({ kind: 'written', modifiedMs: 1_234 }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => ownWrites.push(path))

    try {
      await expect(
        writeNoteIfUnchanged('notes/source.md', 'before\n', 'after\n', 7),
      ).resolves.toEqual({ kind: 'written', modifiedMs: 1_234 })
      expect(invoke).toHaveBeenCalledWith('note_write_if_unchanged', {
        path: 'notes/source.md',
        expected: 'before\n',
        contents: 'after\n',
        generation: 7,
      })
      expect(ownWrites).toEqual(['notes/source.md'])
    } finally {
      unlisten()
    }
  })

  it('returns a changed conditional write without echoing a mutation', async () => {
    const invoke = vi.fn(async () => ({ kind: 'changed' }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => ownWrites.push(path))

    try {
      await expect(
        writeNoteIfUnchanged('notes/source.md', null, 'fresh\n', 7),
      ).resolves.toEqual({ kind: 'changed' })
      expect(ownWrites).toEqual([])
    } finally {
      unlisten()
    }
  })

  it('creates a note through the generation-pinned no-clobber boundary', async () => {
    const invoke = vi.fn(async () => ({ kind: 'created', modifiedMs: 1_234 }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => ownWrites.push(path))

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
    const unlisten = subscribeOwnWrites((path) => ownWrites.push(path))

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
    const unlisten = subscribeOwnWrites((path) => ownWrites.push(path))

    try {
      await expect(
        createNoteIfAbsent('notes/business-ideas.md', '# Replacement\n', 7),
      ).resolves.toEqual({ kind: 'collision' })
      expect(ownWrites).toEqual([])
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

  it('uses dedicated generation-pinned managed AI reads', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'managed_asset_read' ? 'cG5n' : null,
    )
    setBridge({ invoke, listen: async () => () => {} })

    await expect(readManagedAsset('assets/cat.png', 7)).resolves.toBe('cG5n')
    await expect(readManagedAssetDescription('assets/cat.png', 7)).resolves.toBeNull()
    await expect(
      writeManagedAssetDescription('assets/cat.png', '# Description\n', 7),
    ).resolves.toBeUndefined()
    expect(invoke).toHaveBeenNthCalledWith(1, 'managed_asset_read', {
      path: 'assets/cat.png',
      generation: 7,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, 'managed_asset_description_read', {
      path: 'assets/cat.png',
      generation: 7,
    })
    expect(invoke).toHaveBeenNthCalledWith(3, 'managed_asset_description_write', {
      path: 'assets/cat.png',
      contents: '# Description\n',
      generation: 7,
    })
  })

  it('resolves attachments through a validated generation-pinned request', async () => {
    const invoke = vi.fn(async () => ({
      kind: 'resolved',
      path: 'Media/cat.png',
      renderKind: 'image',
    }))
    setBridge({ invoke, listen: async () => () => {} })

    await expect(
      resolveAttachment({
        sourcePath: 'Projects/Plan.md',
        reference: '../Media/cat.png',
        referenceKind: 'markdown',
        generation: 7,
      }),
    ).resolves.toEqual({
      kind: 'resolved',
      path: 'Media/cat.png',
      renderKind: 'image',
    })
    expect(invoke).toHaveBeenCalledWith('attachment_resolve', {
      request: {
        sourcePath: 'Projects/Plan.md',
        reference: '../Media/cat.png',
        referenceKind: 'markdown',
        generation: 7,
      },
    })
  })

  it('rejects malformed attachment requests and native outcomes', async () => {
    const invoke = vi.fn(async () => ({
      kind: 'resolved',
      path: 'Media/movie.mp4',
      renderKind: 'video',
    }))
    setBridge({ invoke, listen: async () => () => {} })

    await expect(
      resolveAttachment({
        sourcePath: 'Plan.md',
        reference: 'movie.mp4',
        referenceKind: 'wikiEmbed',
        generation: -1,
      }),
    ).rejects.toBeDefined()
    expect(invoke).not.toHaveBeenCalled()

    await expect(
      resolveAttachment({
        sourcePath: 'Plan.md',
        reference: 'movie.mp4',
        referenceKind: 'wikiEmbed',
        generation: 7,
      }),
    ).rejects.toMatchObject({ kind: 'parse' })
  })

  it('lists the generation-pinned attachment catalog through IPC', async () => {
    const attachments = [
      { path: 'Media/cat.png', size: 4, modifiedMs: 9 },
      { path: 'Media/remote.pdf', size: 0, modifiedMs: 10, placeholder: true },
    ]
    const invoke = vi.fn(async () => attachments)
    setBridge({ invoke, listen: async () => () => {} })

    await expect(listAttachments(7)).resolves.toEqual(attachments)
    expect(invoke).toHaveBeenCalledWith('list_attachments', { generation: 7 })
  })

  it('captures the uncached privacy snapshot through one generation-pinned command', async () => {
    const snapshot = {
      revision: 4,
      notes: [{ path: 'Projects/private.md', source: '---\nprivate: true\n---\n' }],
      attachments: [{ path: 'assets/cat.png', size: 4, modifiedMs: 9 }],
    }
    const invoke = vi.fn(async () => snapshot)
    setBridge({ invoke, listen: async () => () => {} })

    await expect(assetPrivacySnapshot(7)).resolves.toEqual(snapshot)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('asset_privacy_snapshot', { generation: 7 })
  })

  it('rejects non-attachment paths in the native attachment catalog', async () => {
    const invoke = vi.fn(async () => [{ path: 'notes/Plan.md', size: 4, modifiedMs: 9 }])
    setBridge({ invoke, listen: async () => () => {} })

    await expect(listAttachments(7)).rejects.toMatchObject({ kind: 'parse' })
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
