import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import type { NoteCreationService } from '../graph/note-creation-service.ts'
import {
  createTestNoteCreationService,
  createTestNoteFileService,
  type TestNoteFileService,
} from '../testing/index.ts'
import {
  createBacklinkTargetService,
  type BacklinkTargetService,
} from './backlink-target-service.ts'

const resolveOrCreateMock = vi.fn<NoteCreationService['resolveOrCreateNoteWithTitle']>()
let noteFile: TestNoteFileService
let backlinkTarget: BacklinkTargetService

beforeEach(() => {
  resolveOrCreateMock.mockReset()
  resolveOrCreateMock.mockResolvedValue({ kind: 'resolved', path: 'notes/links.md' })
  noteFile = createTestNoteFileService({
    files: { 'notes/links.md': '# Links\n', 'notes/links-2.md': '# Links\n' },
  })
  const noteCreation = createTestNoteCreationService({ noteFile })
  vi.spyOn(noteCreation, 'resolveOrCreateNoteWithTitle').mockImplementation(resolveOrCreateMock)
  backlinkTarget = createBacklinkTargetService({
    noteCreation,
    noteFile,
  })
})

describe('BacklinkTargetService', () => {
  it('returns the existing note title so renamed categories keep one section', async () => {
    resolveOrCreateMock.mockResolvedValue({ kind: 'resolved', path: 'notes/bookmarks.md' })
    noteFile.set('notes/bookmarks.md', '# Bookmarks\n')

    await expect(backlinkTarget.ensure('Links', 3)).resolves.toBe('Bookmarks')
    expect(noteFile.getReads()).toContainEqual({ path: 'notes/bookmarks.md', generation: 3 })
  })

  it('returns the canonical title of a newly created target', async () => {
    resolveOrCreateMock.mockResolvedValue({ kind: 'created', path: 'notes/links.md' })

    await expect(backlinkTarget.ensure('Links', 3)).resolves.toBe('Links')
  })

  it('keeps the resolvable alias when the current title is unsafe in wiki syntax', async () => {
    resolveOrCreateMock.mockResolvedValue({ kind: 'resolved', path: 'notes/saved-links.md' })
    noteFile.set('notes/saved-links.md', '# Saved | Links\n')

    await expect(backlinkTarget.ensure('Links', 3)).resolves.toBe('Links')
  })

  it('uses the read-only wiki-link winner when duplicate targets already exist', async () => {
    resolveOrCreateMock.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/links.md', 'notes/links-2.md'],
    })

    await expect(backlinkTarget.ensure('Links', 3)).resolves.toBe('Links')
    expect(noteFile.getReads()).toContainEqual({ path: 'notes/links-2.md', generation: 3 })
  })

  it('links directly to the selected duplicate when its current title is unique', async () => {
    resolveOrCreateMock.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/saved-links.md', 'notes/bookmarks.md'],
    })
    noteFile.set('notes/bookmarks.md', '# Bookmarks\n')

    await expect(backlinkTarget.ensure('Links', 3)).resolves.toBe('Bookmarks')
    expect(noteFile.getReads()).toContainEqual({ path: 'notes/bookmarks.md', generation: 3 })
  })

  it('keeps a duplicate target retryable when the selected winner cannot be read', async () => {
    resolveOrCreateMock.mockResolvedValue({
      kind: 'ambiguous',
      paths: ['notes/links.md', 'notes/links-2.md'],
    })
    const readNoteMock = vi
      .spyOn(noteFile, 'read')
      .mockRejectedValue(new AppError('io', 'not downloaded'))

    await expect(backlinkTarget.ensure('Links', 3)).rejects.toMatchObject({
      kind: 'io',
      message: 'not downloaded',
    })
    expect(readNoteMock).toHaveBeenCalledTimes(1)
    expect(readNoteMock).toHaveBeenCalledWith('notes/links-2.md', 3)
  })

  it('keeps the requested spelling when a matching note is unavailable', async () => {
    resolveOrCreateMock.mockResolvedValue({
      kind: 'unavailable',
      paths: ['notes/links.md'],
    })

    await expect(backlinkTarget.ensure('Links', 3)).resolves.toBe('Links')
    expect(noteFile.getReads()).toEqual([])
  })

  it('rejects an impossible ambiguous result without any target paths', async () => {
    resolveOrCreateMock.mockResolvedValue({ kind: 'ambiguous', paths: [] })

    await expect(backlinkTarget.ensure('Links', 3)).rejects.toMatchObject({
      kind: 'unknown',
      message: expect.stringContaining('could not be resolved'),
    })
    expect(noteFile.getReads()).toEqual([])
  })
})
