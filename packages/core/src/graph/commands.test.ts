import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeOwnWrites } from '../indexing/local-write-echo'
import { setBridge } from '../ipc/bridge'
import {
  cancelReflectV1Import,
  createNoteIfAbsent,
  importReflectV1Zip,
  markReflectV1ImportOwnWrites,
  openAsset,
  subscribeImportProgress,
  IMPORT_PROGRESS_EVENT,
} from './commands'

afterEach(() => {
  setBridge(null)
})

describe('graph commands', () => {
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
