import { describe, expect, it, vi } from 'vitest'
import {
  createTestClockService,
  createTestFileChangeService,
  createTestIpcBridgeService,
  createTestNoteFileService,
  type TestIpcBridgeService,
} from '../testing/index.ts'
import type { FileChange } from '../indexing/file-change-service.ts'
import { createNoteFileService } from './note-file-service.ts'

function setup(ipc: TestIpcBridgeService = createTestIpcBridgeService()) {
  const fileChanges = createTestFileChangeService()
  const clock = createTestClockService({ now: 9_000 })
  return { ipc, fileChanges, noteFile: createNoteFileService({ ipc, clock, fileChanges }) }
}

describe('createNoteFileService', () => {
  it('reads through the optionally pinned commands', async () => {
    const { ipc, noteFile } = setup(
      createTestIpcBridgeService({
        commands: {
          note_read: () => '# A\n',
          note_read_local: () => ({ kind: 'evicted' }),
          note_exists: () => true,
        },
      }),
    )

    await expect(noteFile.read('notes/a.md', 4)).resolves.toBe('# A\n')
    await expect(noteFile.readLocal('notes/a.md', 4)).resolves.toEqual({ kind: 'evicted' })
    await expect(noteFile.exists('notes/a.md')).resolves.toBe(true)
    expect(ipc.calls()).toEqual([
      { command: 'note_read', args: { path: 'notes/a.md', generation: 4 } },
      { command: 'note_read_local', args: { path: 'notes/a.md', generation: 4 } },
      { command: 'note_exists', args: { path: 'notes/a.md' } },
    ])
  })

  it('reports a write as an own write', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_write', () => ({ modifiedMs: 1_234, merged: null }))

    await expect(noteFile.write('notes/a.md', 'new', 7)).resolves.toEqual({ merged: null })

    expect(ipc.calls()).toEqual([
      { command: 'note_write', args: { path: 'notes/a.md', contents: 'new', generation: 7 } },
    ])
    expect(fileChanges.ownWrites()).toEqual([['notes/a.md']])
  })

  it('returns the merged text of a checked write that merged with the disk', async () => {
    const { ipc, noteFile } = setup()
    ipc.onCommand('note_write', () => ({
      modifiedMs: 1_234,
      merged: 'a\nB\nc',
    }))

    await expect(noteFile.write('notes/a.md', 'a\nB', 7, 'a\nb')).resolves.toEqual({
      merged: 'a\nB\nc',
    })
  })

  it('sends `expectedContents` for a checked write and does not report a rejected one', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_write', () => {
      throw { kind: 'io', message: 'Note changed on disk; reload before retrying' }
    })

    await expect(noteFile.write('notes/a.md', 'new', 7, null)).rejects.toMatchObject({
      kind: 'io',
    })

    expect(ipc.calls()[0]?.args).toEqual({
      path: 'notes/a.md',
      contents: 'new',
      generation: 7,
      checkContents: true,
      expectedContents: null,
    })
    expect(fileChanges.ownWrites()).toEqual([])
  })

  it('creates a note through the generation-pinned no-clobber command', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_create', () => ({ kind: 'created', modifiedMs: 1_234 }))

    await expect(noteFile.create('notes/ideas.md', '# Ideas\n', 7)).resolves.toEqual({
      kind: 'created',
      modifiedMs: 1_234,
    })

    expect(ipc.calls()).toEqual([
      {
        command: 'note_create',
        args: { path: 'notes/ideas.md', contents: '# Ideas\n', generation: 7 },
      },
    ])
    expect(fileChanges.ownWrites()).toEqual([['notes/ideas.md']])
  })

  it('returns a create collision as data without reporting a write', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_create', () => ({ kind: 'collision' }))

    await expect(noteFile.create('notes/ideas.md', '# Other\n', 7)).resolves.toEqual({
      kind: 'collision',
    })
    expect(fileChanges.ownWrites()).toEqual([])
  })

  it('propagates a create rejection without reporting a write', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_create', () => {
      throw { kind: 'io', message: 'the graph changed since this command was issued; dropping it' }
    })

    await expect(noteFile.create('notes/ideas.md', '# Ideas\n', 6)).rejects.toMatchObject({
      kind: 'io',
    })
    expect(fileChanges.ownWrites()).toEqual([])
  })

  it('reports a delete as an own remove', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_delete', () => null)
    const batches: unknown[] = []
    fileChanges.subscribe((batch) => {
      batches.push(batch)
    })

    await noteFile.delete('notes/a.md', 7)

    expect(ipc.calls()).toEqual([
      { command: 'note_delete', args: { path: 'notes/a.md', generation: 7 } },
    ])
    expect(fileChanges.ownWrites()).toEqual([['notes/a.md']])
    expect(batches).toEqual([])
  })

  it('validates the listings', async () => {
    const entry = { path: 'notes/a.md', size: 2, modifiedMs: 5 }
    const { ipc, noteFile } = setup(
      createTestIpcBridgeService({
        commands: {
          list_files: () => [entry],
          list_attachments: () => [],
          dir_list: () => [entry],
          vault_scan_stats: () => ({ notes: 1, attachments: 0, skipped: 2 }),
        },
      }),
    )

    await expect(noteFile.listNotes(3)).resolves.toEqual([entry])
    await expect(noteFile.listAttachments(3)).resolves.toEqual([])
    await expect(noteFile.listDir('notes', 3)).resolves.toEqual([entry])
    await expect(noteFile.vaultScanStats(3)).resolves.toEqual({
      notes: 1,
      attachments: 0,
      skipped: 2,
    })
    expect(ipc.calls()[2]).toEqual({ command: 'dir_list', args: { dir: 'notes', generation: 3 } })

    ipc.onCommand('list_files', () => [{ path: 'notes/a.md' }])
    await expect(noteFile.listNotes(3)).rejects.toMatchObject({ kind: 'parse' })
  })
})
describe('createTestNoteFileService', () => {
  it('keeps files in memory and records writes', async () => {
    const noteFile = createTestNoteFileService({ files: { 'notes/a.md': 'old' } })

    await noteFile.write('notes/a.md', 'new', 1, 'old')
    await expect(noteFile.write('notes/a.md', 'newer', 1, 'old')).rejects.toMatchObject({
      kind: 'io',
    })
    await expect(noteFile.create('notes/a.md', 'other', 1)).resolves.toEqual({
      kind: 'collision',
    })
    await noteFile.delete('notes/a.md', 1)

    expect(noteFile.getWrites('notes/a.md')).toEqual(['new'])
    expect(noteFile.trashed()).toEqual(['notes/a.md'])
    expect(noteFile.files().size).toBe(0)
  })

  it('reports evicted notes and rejects other generations', async () => {
    const noteFile = createTestNoteFileService({
      files: { 'notes/a.md': 'a' },
      evicted: ['notes/a.md'],
      generation: 2,
    })

    await expect(noteFile.readLocal('notes/a.md', 2)).resolves.toEqual({ kind: 'evicted' })
    await expect(noteFile.listNotes(2)).resolves.toEqual([
      { path: 'notes/a.md', size: 1, modifiedMs: 0, placeholder: true },
    ])
    await expect(noteFile.read('notes/a.md', 1)).rejects.toMatchObject({ kind: 'io' })
  })
})

/**
 * A note file service over a bridge answering `invoke` and a file-change fake with the given echo setting.
 */
function installEcho(
  echoOwnWrites: boolean,
  invoke: (command: string) => unknown = (command) =>
    command === 'note_write' ? { modifiedMs: null, merged: null } : null,
) {
  const ipc = createTestIpcBridgeService()
  for (const command of ['note_write', 'note_delete']) {
    ipc.onCommand(command, () => invoke(command))
  }
  const fileChanges = createTestFileChangeService({ echoOwnWrites })
  const noteFile = createNoteFileService({ ipc, clock: createTestClockService(), fileChanges })
  return { noteFile, fileChanges }
}

describe('local write echo (Plan 19, decision 5)', () => {
  it('emits an upsert to file-change subscribers after a note write', async () => {
    const { noteFile, fileChanges } = installEcho(true)
    const seen: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      seen.push([...changes])
    })

    await noteFile.write('daily/2026-06-12.md', 'hello', 1)

    // The platform reported no mtime: the echo carries the clock's time.
    expect(seen).toEqual([[{ path: 'daily/2026-06-12.md', kind: 'upsert', modifiedMs: 0 }]])
    unlisten()
  })

  it('emits a remove after a delete', async () => {
    const { noteFile, fileChanges } = installEcho(true)
    const seen: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      seen.push([...changes])
    })

    await noteFile.delete('notes/gone.md', 1)

    expect(seen).toEqual([[{ path: 'notes/gone.md', kind: 'remove' }]])
    unlisten()
  })

  it('stamps the echo with the on-disk mtime the write returned', async () => {
    // The reconcile's read-free skip compares the stored row's mtime against
    // the file listing — only the write's own on-disk stamp can ever match.
    const { noteFile, fileChanges } = installEcho(true, (command) =>
      command === 'note_write' ? { modifiedMs: 1_234, merged: null } : null,
    )
    const seen: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      seen.push([...changes])
    })

    await noteFile.write('notes/a.md', 'hello', 1)

    expect(seen).toEqual([[{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1_234 }]])
    unlisten()
  })

  it('stays silent when disabled (the desktop default — the watcher covers it)', async () => {
    const { noteFile, fileChanges } = installEcho(false)
    const handler = vi.fn()
    const unlisten = fileChanges.subscribe(handler)

    await noteFile.write('daily/2026-06-12.md', 'hello', 1)

    expect(handler).not.toHaveBeenCalled()
    unlisten()
  })

  it('does not emit when the write itself fails', async () => {
    const { noteFile, fileChanges } = installEcho(true, () => {
      throw new Error('disk full')
    })
    const handler = vi.fn()
    const unlisten = fileChanges.subscribe(handler)

    await expect(noteFile.write('daily/2026-06-12.md', 'hello', 1)).rejects.toThrow()

    expect(handler).not.toHaveBeenCalled()
    unlisten()
  })
})
