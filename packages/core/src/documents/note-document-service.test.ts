import { sha256HexSync } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import {
  createTestNoteSession,
  type TestNoteSessionOptions,
  createTestNoteSessionService,
} from '../testing/documents.ts'
import {
  createTestNoteFileService,
  overrideNoteFileService,
  type TestNoteFileServiceOptions,
} from '../testing/graph.ts'
import { createTestIndexLifecycleService } from '../testing/index-lifecycle.ts'
import { createNoteDocumentService } from './note-document-service.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestLoggerService } from '../testing/logger.ts'

function setup(options?: {
  files?: TestNoteFileServiceOptions['files']
  generation?: number
  session?: Omit<TestNoteSessionOptions, 'path'>
  indexGeneration?: number | null
}) {
  const noteFile = createTestNoteFileService({
    files: options?.files,
    generation: options?.generation,
  })
  // Each queued text lands in `notes/a.md` right before one write, like an external writer.
  const externalWrites: string[] = []
  const racedNoteFile = overrideNoteFileService(noteFile, {
    write: (path, ...rest) => {
      const external = externalWrites.shift()
      if (external !== undefined) {
        noteFile.set(path, external)
      }
      return noteFile.write(path, ...rest)
    },
  })
  const session =
    options?.session === undefined
      ? null
      : createTestNoteSession({ path: 'notes/a.md', ...options.session })
  const noteSessions = createTestNoteSessionService()
  if (session !== null) {
    noteSessions.register({ session })
  }
  const indexLifecycle = createTestIndexLifecycleService()
  const indexNote = vi.spyOn(indexLifecycle, 'indexNote').mockResolvedValue(12)
  const logger = createTestLoggerService()
  const noteDocuments = createNoteDocumentService({
    noteSessions,
    noteFile: racedNoteFile,
    graphSession: createTestGraphSessionService({
      graph: {
        generation: 3,
        indexGeneration: options?.indexGeneration === undefined ? 5 : options.indexGeneration,
      },
    }),
    indexLifecycle,
    logger,
  })
  return { noteDocuments, noteFile, session, externalWrites, indexNote, logger }
}

describe('readSource', () => {
  it("reads the open session's loaded buffer, not disk", async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# disk\n' },
      session: { content: '# live\n' },
    })
    await expect(noteDocuments.readSource('notes/a.md')).resolves.toBe('# live\n')
  })

  it('falls back to disk while the session is still loading (liveContent null)', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# disk\n' },
      session: { content: '', loaded: false },
    })
    await expect(noteDocuments.readSource('notes/a.md')).resolves.toBe('# disk\n')
  })

  it('reads disk when no session is open', async () => {
    const { noteDocuments } = setup({ files: { 'notes/a.md': '# disk\n' } })
    await expect(noteDocuments.readSource('notes/a.md')).resolves.toBe('# disk\n')
  })

  it('reads a missing file as an empty note', async () => {
    const { noteDocuments } = setup()
    await expect(noteDocuments.readSource('notes/a.md')).resolves.toBe('')
  })
})

describe('commitFrontmatter', () => {
  it('lands the patch through the live session when it can take it', async () => {
    const { noteDocuments, noteFile, session } = setup({
      files: { 'notes/a.md': '# A\n' },
      session: { content: '# A\n' },
    })

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(session?.getCalls('commitFrontmatter')).toEqual([[{ pinned: true }]])
    expect(noteFile.writes()).toEqual([])
  })

  it('writes a session patch through to the index', async () => {
    const { noteDocuments, indexNote } = setup({
      files: { 'notes/a.md': '# A\n' },
      session: { content: '# A\n' },
    })

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(indexNote.mock.calls).toEqual([
      ['notes/a.md', { generation: 5, fileGeneration: 3, note: undefined, mtime: undefined }],
    ])
  })

  it('falls back to a disk patch when the session declines the patch', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': '# A\n' },
      session: { content: '# A\n', accepts: false },
    })

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(noteFile.writes()).toEqual([
      { path: 'notes/a.md', contents: '---\npinned: true\n---\n\n# A\n', generation: 3 },
    ])
  })

  it('patches disk directly when no session is open', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': '# A\n' } })

    await noteDocuments.commitFrontmatter('notes/a.md', { private: true }, 3)

    expect(noteFile.writes()).toEqual([
      { path: 'notes/a.md', contents: '---\nprivate: true\n---\n\n# A\n', generation: 3 },
    ])
  })

  it('writes nothing when the patch changes nothing', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': '---\npinned: true\n---\n\n# A\n' },
    })

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(noteFile.writes()).toEqual([])
  })

  it('patches the text of a concurrent external write instead of overwriting it', async () => {
    const { noteDocuments, noteFile, externalWrites } = setup({ files: { 'notes/a.md': '# A\n' } })
    externalWrites.push('# A\n\ntheirs\n')

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(noteFile.files().get('notes/a.md')).toBe('---\npinned: true\n---\n\n# A\n\ntheirs\n')
  })

  it('creates a missing file from the patch', async () => {
    const { noteDocuments, noteFile } = setup()

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(noteFile.files().get('notes/a.md')).toContain('pinned: true')
  })
})

describe('commitSourceEdit', () => {
  const shout = (source: string): string => source.toUpperCase()

  it('applies the transform through the live session and leaves disk alone', async () => {
    const { noteDocuments, noteFile, session } = setup({
      files: { 'notes/a.md': 'disk\n' },
      session: { content: 'live\n' },
    })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).resolves.toEqual({
      content: 'LIVE\n',
      revision: sha256HexSync('LIVE\n'),
      merged: false,
      indexSeq: null,
    })
    expect(session!.content()).toBe('LIVE\n')
    expect(noteFile.writes()).toEqual([])
  })

  it('writes disk when a session without unsaved edits declines', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': 'disk\n' },
      session: { content: 'disk\n', accepts: false },
    })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).resolves.toMatchObject({ content: 'DISK\n', revision: sha256HexSync('DISK\n') })
    expect(noteFile.writes()).toEqual([{ path: 'notes/a.md', contents: 'DISK\n', generation: 7 }])
  })

  it('refuses as not writable when a session with unsaved edits declines', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': 'disk\n' },
      session: { content: 'live\n', accepts: false, dirty: true },
    })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).rejects.toMatchObject({ kind: 'notWritable' })
    expect(noteFile.writes()).toEqual([])
  })

  it('reads, transforms and writes disk when no session is open', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'disk\n' } })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).resolves.toEqual({
      content: 'DISK\n',
      revision: sha256HexSync('DISK\n'),
      merged: false,
      indexSeq: null,
    })
    expect(noteFile.writes()).toEqual([{ path: 'notes/a.md', contents: 'DISK\n', generation: 7 }])
  })

  it('reruns the transform on a concurrent external write instead of overwriting it', async () => {
    const { noteDocuments, noteFile, externalWrites } = setup({ files: { 'notes/a.md': 'disk\n' } })
    externalWrites.push('disk\ntheirs\n')
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).resolves.toMatchObject({ content: 'DISK\nTHEIRS\n', merged: false })
    expect(noteFile.files().get('notes/a.md')).toBe('DISK\nTHEIRS\n')
    expect(noteFile.getWrites('notes/a.md')).toEqual(['DISK\nTHEIRS\n'])
  })

  it('gives up with a conflict when the file changes during every attempt', async () => {
    const { noteDocuments, noteFile, externalWrites } = setup({ files: { 'notes/a.md': 'disk\n' } })
    externalWrites.push('one\n', 'two\n', 'three\n')
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).rejects.toMatchObject({ kind: 'conflict' })
    expect(noteFile.files().get('notes/a.md')).toBe('three\n')
    expect(noteFile.writes()).toEqual([])
  })

  it('writes a disk commit through to the index of its graph session', async () => {
    const { noteDocuments, indexNote } = setup({ files: { 'notes/a.md': 'disk\n' } })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 3 }),
    ).resolves.toMatchObject({ content: 'DISK\n', indexSeq: 12 })
    expect(indexNote.mock.calls).toEqual([
      [
        'notes/a.md',
        {
          generation: 5,
          fileGeneration: 3,
          note: { content: 'DISK\n', hash: sha256HexSync('DISK\n') },
          mtime: 1,
        },
      ],
    ])
  })

  it('writes a session commit through to the index', async () => {
    const { noteDocuments, indexNote } = setup({ session: { content: 'live\n' } })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 3 }),
    ).resolves.toMatchObject({ content: 'LIVE\n', indexSeq: 12 })
    expect(indexNote.mock.calls).toEqual([
      [
        'notes/a.md',
        {
          generation: 5,
          fileGeneration: 3,
          note: { content: 'LIVE\n', hash: sha256HexSync('LIVE\n') },
          mtime: undefined,
        },
      ],
    ])
  })

  it('returns a null indexSeq while the index is closed', async () => {
    const { noteDocuments, indexNote } = setup({
      files: { 'notes/a.md': 'disk\n' },
      indexGeneration: null,
    })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 3 }),
    ).resolves.toMatchObject({ content: 'DISK\n', indexSeq: null })
    expect(indexNote).not.toHaveBeenCalled()
  })

  it('keeps the commit and logs when the index write fails', async () => {
    const { noteDocuments, noteFile, indexNote, logger } = setup({
      files: { 'notes/a.md': 'disk\n' },
    })
    indexNote.mockRejectedValue(new Error('index on fire'))
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 3 }),
    ).resolves.toMatchObject({ content: 'DISK\n', indexSeq: null })
    expect(noteFile.files().get('notes/a.md')).toBe('DISK\n')
    expect(logger.getErrors()).toHaveLength(1)
  })

  it('writes nothing when the transform changes nothing', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'disk\n' } })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', (source) => source, { generation: 7 }),
    ).resolves.toMatchObject({ content: 'disk\n', revision: sha256HexSync('disk\n') })
    expect(noteFile.writes()).toEqual([])
  })

  it('rejects a missing note unless createIfMissing is set', async () => {
    const { noteDocuments, noteFile } = setup()
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).rejects.toMatchObject({ kind: 'notFound' })
    expect(noteFile.writes()).toEqual([])

    await noteDocuments.commitSourceEdit('notes/a.md', (source) => `${source}new\n`, {
      generation: 7,
      createIfMissing: true,
    })
    expect(noteFile.getWrites('notes/a.md')).toEqual(['new\n'])
  })

  it('keeps both texts when another writer creates the note first', async () => {
    const { noteDocuments, noteFile, externalWrites } = setup()
    externalWrites.push('theirs\n')

    await noteDocuments.commitSourceEdit('notes/a.md', (source) => `${source}mine\n`, {
      generation: 7,
      createIfMissing: true,
    })

    expect(noteFile.files().get('notes/a.md')).toBe('theirs\nmine\n')
  })

  it('propagates a transform error and writes nothing', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'disk\n' } })
    const fail = (): string => {
      throw new Error('stale')
    }
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', fail, { generation: 7 }),
    ).rejects.toThrow('stale')
    expect(noteFile.writes()).toEqual([])
  })

  it('serializes edits to one path, so the second reads what the first wrote', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'a' } })
    const append = (source: string): string => `${source}+`
    await Promise.all([
      noteDocuments.commitSourceEdit('notes/a.md', append, { generation: 7 }),
      noteDocuments.commitSourceEdit('notes/a.md', append, { generation: 7 }),
    ])
    expect(noteFile.getWrites('notes/a.md')).toEqual(['a+', 'a++'])
  })

  it('keeps the chain alive after a failed edit', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'a' } })
    const fail = (): string => {
      throw new Error('stale')
    }
    const first = noteDocuments.commitSourceEdit('notes/a.md', fail, { generation: 7 })
    const second = noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 })
    await expect(first).rejects.toThrow('stale')
    await second
    expect(noteFile.getWrites('notes/a.md')).toEqual(['A'])
  })
})

describe('readExisting', () => {
  it('reads the live buffer of an open, ready session', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# On disk' },
      generation: 7,
      session: { content: '# Live' },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 7)).resolves.toBe('# Live')
  })

  it('preserves an authoritative empty live buffer', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# On disk' },
      generation: 7,
      session: { content: '' },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 7)).resolves.toBe('')
  })

  it('refuses a stale live buffer when its generation-pinned file is gone', async () => {
    const { noteDocuments } = setup({ generation: 7, session: { content: '# Stale' } })

    await expect(noteDocuments.readExisting('notes/a.md', 7)).rejects.toMatchObject({
      kind: 'notFound',
    })
  })

  it('refuses a live buffer when the read is pinned to another generation', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# On disk' },
      generation: 7,
      session: { content: '# Live' },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 8)).rejects.toBeDefined()
  })

  it('falls back to a generation-pinned disk read while the session is loading', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# On disk' },
      generation: 7,
      session: { content: '', loaded: false },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 7)).resolves.toBe('# On disk')
    await expect(noteDocuments.readExisting('notes/a.md', 8)).rejects.toBeDefined()
  })
})

describe('isOstensiblyEmpty', () => {
  const { noteDocuments } = setup()

  it('treats blank and frontmatter-only notes as empty', () => {
    expect(noteDocuments.isOstensiblyEmpty('')).toBe(true)
    expect(noteDocuments.isOstensiblyEmpty('\n  \n')).toBe(true)
    expect(noteDocuments.isOstensiblyEmpty('---\npinned: true\n---\n')).toBe(true)
  })

  it('treats plain empty bullets as empty', () => {
    expect(noteDocuments.isOstensiblyEmpty('- ')).toBe(true)
    expect(noteDocuments.isOstensiblyEmpty('  *\n\n+   \n')).toBe(true)
  })

  it('treats bullet content as authored content', () => {
    expect(noteDocuments.isOstensiblyEmpty('- groceries\n')).toBe(false)
  })
})
