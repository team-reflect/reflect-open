import { describe, expect, it, vi } from 'vitest'
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
    authoredTitleKey: path,
    pathKey: path,
    basenameKey: path.replace(/^.*\//, '').replace(/\.md$/, ''),
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

describe('dev bridge background task parity', () => {
  it('reports native background assertions as unavailable and accepts cleanup', async () => {
    const bridge = createDevBridge({
      platform: 'ios',
      files: createDevFileStore({}),
      index: await createDevIndexDb(),
    })

    await expect(bridge.invoke('background_task_begin', {})).resolves.toBeNull()
    await expect(
      bridge.invoke('background_task_end', { token: 'already-expired' }),
    ).resolves.toBeNull()
  })
})

describe('dev bridge graph-path boundary parity', () => {
  it('rejects hidden, reserved, unsupported, and arbitrary command paths', async () => {
    const files = createDevFileStore({
      'notes/safe.md': '# Safe\n',
      '.hidden.md': '# Hidden\n',
      'assets/sidecar.md': 'not a note',
    })
    const bridge = createDevBridge({
      platform: 'ios',
      files,
      index: await createDevIndexDb(),
    })

    for (const path of ['.git/config', '.hidden.md', 'assets/sidecar.md', 'README.MD']) {
      await expect(bridge.invoke('note_read', { path })).rejects.toThrow()
      await expect(
        bridge.invoke('note_write', { path, contents: 'no', generation: 1 }),
      ).rejects.toThrow()
      await expect(
        bridge.invoke('note_create', { path, contents: 'no', generation: 1 }),
      ).rejects.toThrow()
      await expect(bridge.invoke('note_exists', { path })).rejects.toThrow()
      await expect(bridge.invoke('note_delete', { path, generation: 1 })).rejects.toThrow()
    }
    await expect(
      bridge.invoke('note_move_indexed', {
        request: { from: 'notes/safe.md', to: '.git/config', generation: 1 },
      }),
    ).rejects.toThrow()

    for (const path of ['Media/a.png', 'assets/.hidden.png', 'assets/readme.txt']) {
      await expect(bridge.invoke('asset_read', { path, generation: 1 })).rejects.toThrow()
      await expect(
        bridge.invoke('asset_write', { path, contentsBase64: 'cG5n', generation: 1 }),
      ).rejects.toThrow()
    }
    for (const dir of ['.git', 'notes', 'assets/nested']) {
      await expect(bridge.invoke('dir_list', { dir, generation: 1 })).rejects.toThrow()
    }

    expect(files.read('notes/safe.md')).toBe('# Safe\n')
  })
})

describe('dev bridge note_create parity', () => {
  it('claims a free path and returns its persisted modified time', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234)
    try {
      const files = createDevFileStore({})
      const bridge = createDevBridge({
        platform: 'ios',
        files,
        index: await createDevIndexDb(),
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

  it('reports a collision without replacing the existing file', async () => {
    const files = createDevFileStore({
      'notes/business-ideas.md': '# Original\n',
    })
    const originalModifiedMs = files.list()[0]!.modifiedMs
    const bridge = createDevBridge({
      platform: 'ios',
      files,
      index: await createDevIndexDb(),
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
      platform: 'ios',
      files,
      index: await createDevIndexDb(),
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

describe('dev bridge index-move parity', () => {
  it('passes derived destination keys through to the browser projection', async () => {
    const files = createDevFileStore({ 'notes/source.md': '# Source\n' })
    const index = await createDevIndexDb()
    index.applyNote(projection('notes/source.md', 1, 'settled-hash'))
    const bridge = createDevBridge({ platform: 'ios', files, index })

    await expect(
      bridge.invoke('note_move_indexed', {
        request: {
          from: 'notes/source.md',
          to: 'Archive/Renamed.md',
          fromPathKey: 'notes/source.md',
          fromBasenameKey: 'source',
          toPathKey: 'archive/renamed.md',
          toBasenameKey: 'renamed',
          generation: 1,
        },
      }),
    ).resolves.toBeNull()

    expect(files.read('notes/source.md')).toBeNull()
    expect(files.read('Archive/Renamed.md')).toBe('# Source\n')
    expect(index.query('SELECT path, path_key, basename_key, file_hash FROM notes', [])).toEqual([
      {
        path: 'Archive/Renamed.md',
        path_key: 'archive/renamed.md',
        basename_key: 'renamed',
        file_hash: '',
      },
    ])
  })
})

describe('dev bridge conditional note-write parity', () => {
  it('replaces matching bytes and leaves a changed source untouched', async () => {
    const files = createDevFileStore({ 'notes/source.md': 'before\n' })
    const bridge = createDevBridge({
      platform: 'ios',
      files,
      index: await createDevIndexDb(),
    })

    await expect(
      bridge.invoke('note_write_if_unchanged', {
        path: 'notes/source.md',
        expected: 'before\n',
        contents: 'after\n',
        generation: 1,
      }),
    ).resolves.toMatchObject({ kind: 'written' })
    expect(files.read('notes/source.md')).toBe('after\n')

    await expect(
      bridge.invoke('note_write_if_unchanged', {
        path: 'notes/source.md',
        expected: 'before\n',
        contents: 'clobber\n',
        generation: 1,
      }),
    ).resolves.toEqual({ kind: 'changed' })
    expect(files.read('notes/source.md')).toBe('after\n')
  })

  it('uses expected-absent creation without clobbering a racing owner', async () => {
    const files = createDevFileStore({})
    const bridge = createDevBridge({
      platform: 'ios',
      files,
      index: await createDevIndexDb(),
    })
    const request = {
      path: 'notes/fresh.md',
      expected: null,
      contents: 'first\n',
      generation: 1,
    }

    await expect(bridge.invoke('note_write_if_unchanged', request)).resolves.toMatchObject({
      kind: 'written',
    })
    await expect(
      bridge.invoke('note_write_if_unchanged', { ...request, contents: 'replacement\n' }),
    ).resolves.toEqual({ kind: 'changed' })
    expect(files.read('notes/fresh.md')).toBe('first\n')
  })

  it('rejects a stale generation before comparing or writing', async () => {
    const files = createDevFileStore({ 'notes/source.md': 'before\n' })
    const bridge = createDevBridge({
      platform: 'ios',
      files,
      index: await createDevIndexDb(),
    })

    await expect(
      bridge.invoke('note_write_if_unchanged', {
        path: 'notes/source.md',
        expected: 'before\n',
        contents: 'after\n',
        generation: 0,
      }),
    ).rejects.toMatchObject({ kind: 'io' })
    expect(files.read('notes/source.md')).toBe('before\n')
  })
})

describe('dev bridge streamed attachment parity', () => {
  it('streams bytes, suffixes collisions, and exposes the attachment catalog', async () => {
    const bridge = createDevBridge({
      platform: 'ios',
      files: createDevFileStore({ 'Projects/Plan.md': '# Plan\n' }),
      index: await createDevIndexDb(),
    })
    const invokeBinary = bridge.invokeBinary
    if (invokeBinary === undefined) {
      throw new Error('dev bridge must expose its binary asset transport')
    }

    const firstId = await bridge.invoke('asset_upload_begin', { generation: 1 })
    expect(firstId).toBe('upload-1')
    await invokeBinary('asset_upload_append', new TextEncoder().encode('hello '), {
      'x-upload-id': String(firstId),
    })
    await invokeBinary('asset_upload_append', new TextEncoder().encode('world'), {
      'x-upload-id': String(firstId),
    })
    await expect(
      bridge.invoke('asset_upload_commit', {
        id: firstId,
        desiredName: 'report.pdf',
        generation: 1,
      }),
    ).resolves.toBe('assets/report.pdf')

    const secondId = await bridge.invoke('asset_upload_begin', { generation: 1 })
    await invokeBinary('asset_upload_append', new Uint8Array([1, 2]), {
      'x-upload-id': String(secondId),
    })
    await expect(
      bridge.invoke('asset_upload_commit', {
        id: secondId,
        desiredName: 'report.pdf',
        generation: 1,
      }),
    ).resolves.toBe('assets/report-2.pdf')

    await expect(
      bridge.invoke('asset_read', { path: 'assets/report.pdf', generation: 1 }),
    ).resolves.toBe(btoa('hello world'))
    await expect(bridge.invoke('list_attachments', { generation: 1 })).resolves.toEqual([
      expect.objectContaining({ path: 'assets/report.pdf', size: 11 }),
      expect.objectContaining({ path: 'assets/report-2.pdf', size: 2 }),
    ])
    await expect(
      bridge.invoke('attachment_resolve', {
        request: {
          sourcePath: 'Projects/Plan.md',
          reference: '/assets/report.pdf',
          referenceKind: 'markdown',
          generation: 1,
        },
      }),
    ).resolves.toEqual({
      kind: 'resolved',
      path: 'assets/report.pdf',
      renderKind: 'file',
    })
  })

  it('rejects stale upload generations and unsafe destination names', async () => {
    const bridge = createDevBridge({
      platform: 'ios',
      files: createDevFileStore({}),
      index: await createDevIndexDb(),
    })

    await expect(bridge.invoke('asset_upload_begin', { generation: 0 })).rejects.toMatchObject({
      kind: 'io',
    })
    await expect(bridge.invoke('list_attachments', { generation: 0 })).rejects.toMatchObject({
      kind: 'io',
    })
    const id = await bridge.invoke('asset_upload_begin', { generation: 1 })
    await expect(
      bridge.invoke('asset_upload_commit', {
        id,
        desiredName: '../escape.pdf',
        generation: 1,
      }),
    ).rejects.toMatchObject({ kind: 'traversal' })
    await expect(bridge.invoke('list_attachments', { generation: 1 })).resolves.toEqual([])
  })
})
