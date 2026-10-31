import { describe, expect, it } from 'vitest'
import { createTestNoteSession, type TestNoteSessionOptions } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteFileService, type TestNoteFileServiceOptions } from '../testing/graph.ts'
import { createNoteDocumentService, NoteBusyError } from './note-document-service.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createOpenDocumentsService } from './open-documents-service.ts'

function setup(options?: {
  files?: TestNoteFileServiceOptions['files']
  generation?: number
  session?: Omit<TestNoteSessionOptions, 'path'>
}) {
  const noteFile = createTestNoteFileService({
    ...(options?.files === undefined ? {} : { files: options.files }),
    ...(options?.generation === undefined ? {} : { generation: options.generation }),
  })
  const session =
    options?.session === undefined
      ? null
      : createTestNoteSession({ path: 'notes/a.md', ...options.session })
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  if (session !== null) {
    openDocuments.register({ session })
  }
  const noteDocuments = createNoteDocumentService({
    openDocuments,
    noteFile,
    graphSession: createTestGraphSessionService({ graph: { generation: 3 } }),
  })
  return { noteDocuments, noteFile, session }
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
    await noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 })
    expect(session!.content()).toBe('LIVE\n')
    expect(noteFile.writes()).toEqual([])
  })

  it('refuses with NoteBusyError when the session declines, without touching disk', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': 'disk\n' },
      session: { content: 'live\n', accepts: false },
    })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).rejects.toBeInstanceOf(NoteBusyError)
    expect(noteFile.writes()).toEqual([])
  })

  it('reads, transforms and writes disk when no session is open', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'disk\n' } })
    await noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 })
    expect(noteFile.writes()).toEqual([{ path: 'notes/a.md', contents: 'DISK\n', generation: 7 }])
  })

  it('writes even when the transform changes nothing', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'disk\n' } })
    await noteDocuments.commitSourceEdit('notes/a.md', (source) => source, { generation: 7 })
    expect(noteFile.getWrites('notes/a.md')).toEqual(['disk\n'])
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
