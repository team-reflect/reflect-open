import { describe, expect, it, vi } from 'vitest'
import {
  createAssetStoreService,
  createIpcBridgeService,
  foldGraphPath,
  type IndexedNote,
} from '@reflect/core'
import {
  createTestClockService,
  createTestFileChangeService,
  createTestIndexedNote,
  createTestLoggerService,
} from '@reflect/core/testing'
import { createDevAssetStore } from '@/dev/dev-asset-store.ts'
import { createDevBridge } from '@/dev/dev-bridge.ts'
import { createDevFileStore } from '@/dev/dev-file-store.ts'

function projection(path: string, mtime: number, fileHash: string): IndexedNote {
  return createTestIndexedNote({
    path,
    title: path,
    titleKey: path,
    pathKey: foldGraphPath(path),
    fileHash,
    mtime,
  })
}

describe('dev bridge index_reconcile_scan', () => {
  it('classifies candidates and orphans like the native scan', async () => {
    const files = createDevFileStore({ 'notes/settled.md': '# Settled' })
    const bridge = createDevBridge({ files, assets: createDevAssetStore() })
    const generation = await bridge.invoke('index_open', {})
    const apply = (note: IndexedNote) => bridge.invoke('index_apply', { note, generation })

    // The seeded file's row matches its listed mtime and has settled.
    const settledMtime = files.list()[0]!.modifiedMs
    await apply(projection('notes/settled.md', settledMtime, 'settled-hash'))
    // A row whose file is gone is an orphan.
    await apply(projection('notes/gone.md', 1_000, 'gone-hash'))
    // A file with no row is an arrival candidate (fresh mtime, so it would be
    // a candidate on both grounds).
    files.write('notes/new.md', '# New')

    const scan = (await bridge.invoke('index_reconcile_scan', { generation })) as {
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

describe('dev bridge index events', () => {
  it('announces an index commit and stays silent for a stale generation', async () => {
    const bridge = createDevBridge({ files: createDevFileStore({}), assets: createDevAssetStore() })
    const committed = vi.fn()
    const unlisten = await bridge.listen('index:committed', committed)
    const generation = (await bridge.invoke('index_open', {})) as number
    const commit = { seq: 1, paths: ['notes/a.md'] }

    await bridge.invoke('index_announce', { ...commit, generation: generation + 1 })
    expect(committed).not.toHaveBeenCalled()

    // The event arrives after the command has replied.
    const reply = bridge.invoke('index_announce', { ...commit, generation })
    expect(committed).not.toHaveBeenCalled()
    await reply
    expect(committed).toHaveBeenCalledExactlyOnceWith(commit)

    unlisten()
    await bridge.invoke('index_announce', { ...commit, generation })
    expect(committed).toHaveBeenCalledOnce()
  })

  it('announces a note move with both paths, and nothing for a stale graph generation', async () => {
    const files = createDevFileStore({ 'notes/a.md': '# A' })
    const bridge = createDevBridge({ files, assets: createDevAssetStore() })
    const generation = (await bridge.invoke('index_open', {})) as number
    await bridge.invoke('index_apply', { note: projection('notes/a.md', 1, 'hash'), generation })
    const committed = vi.fn()
    const moved = vi.fn()
    await bridge.listen('index:committed', committed)
    await bridge.listen('note:moved', moved)
    const address = (stem: string) => ({
      pathKey: `notes/${stem}.md`,
      basenameKey: stem,
      dailyDate: null,
    })
    const request = {
      from: 'notes/a.md',
      to: 'notes/b.md',
      fromAddress: address('a'),
      toAddress: address('b'),
    }

    await expect(bridge.invoke('note_move_indexed', { request, generation: 2 })).rejects.toThrow(
      'the graph changed',
    )
    expect(moved).not.toHaveBeenCalled()
    expect(files.exists('notes/a.md')).toBe(true)

    await bridge.invoke('note_move_indexed', { request, generation: 1 })
    expect(committed).toHaveBeenCalledExactlyOnceWith({
      seq: 2,
      paths: ['notes/a.md', 'notes/b.md'],
    })
    expect(moved).toHaveBeenCalledExactlyOnceWith({ from: 'notes/a.md', to: 'notes/b.md' })
    expect(files.exists('notes/b.md')).toBe(true)
  })
})

describe('dev bridge desktop boot surface', () => {
  it('answers the desktop chooser and workspace queries with honest stand-ins', async () => {
    const files = createDevFileStore({
      'notes/one.md': '# One',
      'notes/two.md': '# Two',
    })
    const bridge = createDevBridge({
      files,
      assets: createDevAssetStore(),
    })

    const recents = (await bridge.invoke('recent_graphs', {})) as Array<Record<string, unknown>>
    expect(recents).toHaveLength(1)
    expect(recents[0]).toMatchObject({ root: '/dev-graph', name: 'Dev Graph' })
    expect(recents[0]!['openedMs']).toEqual(expect.any(Number))

    await expect(bridge.invoke('icloud_status', {})).resolves.toEqual({
      available: false,
      documentsRoot: null,
      existingGraphRoots: [],
    })
    await expect(bridge.invoke('embed_status', {})).resolves.toEqual({ status: 'unsupported' })
    await expect(bridge.invoke('vault_scan_stats', { generation: 1 })).resolves.toEqual({
      notes: 2,
      attachments: 0,
      skipped: 0,
    })
    await expect(bridge.invoke('list_attachments', { generation: 1 })).resolves.toEqual([])
  })
})

describe('dev bridge background task parity', () => {
  it('reports native background assertions as unavailable and accepts cleanup', async () => {
    const bridge = createDevBridge({
      files: createDevFileStore({}),
      assets: createDevAssetStore(),
    })

    await expect(bridge.invoke('background_task_begin', {})).resolves.toBeNull()
    await expect(
      bridge.invoke('background_task_end', { token: 'already-expired' }),
    ).resolves.toBeNull()
  })
})

describe('dev bridge note_create parity', () => {
  it('claims a free path and returns its persisted modified time', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234)
    try {
      const files = createDevFileStore({})
      const bridge = createDevBridge({
        files,
        assets: createDevAssetStore(),
      })

      await expect(
        bridge.invoke('note_create', {
          path: 'notes/business-ideas.md',
          contents: '# Business ideas\n',
          generation: 1,
        }),
      ).resolves.toEqual({ kind: 'created', modifiedMs: 1_234 })
      expect(files.read('notes/business-ideas.md')).toBe('# Business ideas\n')
      expect(files.list()[0]?.modifiedMs).toBe(1_234)
    } finally {
      now.mockRestore()
    }
  })

  it('refuses a checked write when the note changed on disk', async () => {
    const files = createDevFileStore({ 'notes/a.md': '# Disk\n' })
    const bridge = createDevBridge({
      files,
      assets: createDevAssetStore(),
    })

    await expect(
      bridge.invoke('note_write', {
        path: 'notes/a.md',
        contents: '# Mine\n',
        checkContents: true,
        expectedContents: '# Old\n',
      }),
    ).rejects.toThrow('Note changed on disk')
    expect(files.read('notes/a.md')).toBe('# Disk\n')

    await bridge.invoke('note_write', {
      path: 'notes/a.md',
      contents: '# Mine\n',
      checkContents: true,
      expectedContents: '# Disk\n',
    })
    expect(files.read('notes/a.md')).toBe('# Mine\n')
  })

  it('reports a collision without replacing the existing file', async () => {
    const files = createDevFileStore({
      'notes/business-ideas.md': '# Original\n',
    })
    const originalModifiedMs = files.list()[0]!.modifiedMs
    const bridge = createDevBridge({
      files,
      assets: createDevAssetStore(),
    })

    await expect(
      bridge.invoke('note_create', {
        path: 'notes/business-ideas.md',
        contents: '# Replacement\n',
        generation: 1,
      }),
    ).resolves.toEqual({ kind: 'collision' })
    expect(files.read('notes/business-ideas.md')).toBe('# Original\n')
    expect(files.list()[0]!.modifiedMs).toBe(originalModifiedMs)
  })

  it('rejects a stale generation before creating or replacing anything', async () => {
    const files = createDevFileStore({
      'notes/existing.md': '# Existing\n',
    })
    const bridge = createDevBridge({
      files,
      assets: createDevAssetStore(),
    })

    await expect(
      bridge.invoke('note_create', {
        path: 'notes/new.md',
        contents: '# New\n',
        generation: 0,
      }),
    ).rejects.toMatchObject({
      kind: 'io',
      message: 'the graph changed since this command was issued; dropping it',
    })
    expect(files.read('notes/new.md')).toBeNull()
    expect(files.read('notes/existing.md')).toBe('# Existing\n')
  })
})

describe('dev bridge assets', () => {
  it('serves the asset store end to end', async () => {
    const assets = createDevAssetStore()
    const bridge = createDevBridge({
      files: createDevFileStore({}),
      assets,
    })
    const assetStore = createAssetStoreService({
      ipc: createIpcBridgeService({ transport: bridge, logger: createTestLoggerService() }),
      clock: createTestClockService(),
      fileChanges: createTestFileChangeService(),
    })
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })

    await expect(assetStore.uploadBlob('cat.png', image, 1)).resolves.toBe('assets/cat.png')
    await expect(assetStore.uploadBlob('cat.png', image, 1)).resolves.toBe('assets/cat-2.png')
    await assetStore.uploadToPath('assets/dog.png', image, 1)
    await expect(assetStore.uploadToPath('assets/dog.png', image, 1)).rejects.toThrow(
      'target already exists',
    )
    await expect(assetStore.uploadBlob('cat.png', image, 0)).rejects.toThrow('graph changed')

    await expect(assetStore.readBytes('assets/cat-2.png', 1)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    )
    await expect(assetStore.readBase64('assets/dog.png', 1)).resolves.toBe('AQID')
    const listed = (await bridge.invoke('list_attachments', { generation: 1 })) as Array<{
      path: string
    }>
    expect(listed.map((file) => file.path)).toEqual([
      'assets/cat.png',
      'assets/cat-2.png',
      'assets/dog.png',
    ])
    expect(assets.convertFileSrc('1/assets/cat.png', 'reflect-asset')).toMatch(/^blob:/)
  })
})
