import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gistBodyHash, upsertFrontmatter } from '@reflect/core'
import type { NoteSession } from '@/editor/note-session'
import { getNoteRowOverlay, resetNoteRowOverlays } from '@/hooks/note-row-overlay'

const readNote = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>())
const writeNote = vi.hoisted(() => vi.fn(async () => {}))
const getGithubToken = vi.hoisted(() => vi.fn(async (): Promise<string | null> => 'tok'))
const createGist = vi.hoisted(() => vi.fn())
const updateGist = vi.hoisted(() => vi.fn())
const deleteGist = vi.hoisted(() => vi.fn(async () => {}))
const openSession = vi.hoisted(() => vi.fn<(path: string) => NoteSession | null>(() => null))
const operationDone = vi.hoisted(() => vi.fn())
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({ progress: vi.fn(), done: operationDone, fail: operationFail })),
)

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote,
  writeNote,
  getGithubToken,
  createGist,
  updateGist,
  deleteGist,
}))
vi.mock('@/editor/open-documents', () => ({ openSession }))
vi.mock('@/lib/operations', () => ({ startOperation }))

const { publishNoteToGist, runGistPublish, runGistUnpublish, unpublishNoteGist } = await import('./note-gist')

const PUBLISHED = { id: 'g1', htmlUrl: 'https://gist.github.com/alex/g1' }
const BODY = '# A\n\nhello\n'

/** A note already carrying a gist block (published as `Old.md`, hash stale). */
const REPUBLISH_SOURCE = upsertFrontmatter(BODY, {
  gist: { id: 'g0', url: 'https://gist.github.com/alex/g0', file: 'Old.md', hash: 'feedfacefeedface' },
})

beforeEach(() => {
  readNote.mockReset()
  writeNote.mockClear()
  getGithubToken.mockReset().mockResolvedValue('tok')
  createGist.mockReset().mockResolvedValue(PUBLISHED)
  updateGist.mockReset().mockResolvedValue(PUBLISHED)
  deleteGist.mockReset().mockResolvedValue(undefined)
  openSession.mockReset().mockReturnValue(null)
  startOperation.mockClear()
  operationDone.mockClear()
  operationFail.mockClear()
  resetNoteRowOverlays()
})

function fakeSession(content: string, canCommit = true, liveContent: string | null = content) {
  const commitFrontmatter = vi.fn(async () => canCommit)
  const session = {
    content: () => content,
    liveContent: () => liveContent,
    commitFrontmatter,
  } as unknown as NoteSession
  return { session, commitFrontmatter }
}

describe('publishNoteToGist', () => {
  it('creates a secret gist for a fresh note and records it in frontmatter', async () => {
    readNote.mockResolvedValue(BODY)
    await expect(publishNoteToGist('notes/a.md', 3)).resolves.toBe(PUBLISHED.htmlUrl)

    expect(createGist).toHaveBeenCalledWith(
      'tok',
      { name: 'A.md', content: BODY },
      expect.any(Function),
    )
    const gist = { id: 'g1', url: PUBLISHED.htmlUrl, file: 'A.md', hash: gistBodyHash(BODY) }
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', upsertFrontmatter(BODY, { gist }), 3)
  })

  it('republishes to the same gist, addressing the file by its previous name', async () => {
    readNote.mockResolvedValue(REPUBLISH_SOURCE)
    await publishNoteToGist('notes/a.md', 3)

    expect(updateGist).toHaveBeenCalledWith(
      'tok',
      'g0',
      'Old.md',
      { name: 'A.md', content: BODY },
      expect.any(Function),
    )
    expect(createGist).not.toHaveBeenCalled()
  })

  it('falls back to creating a fresh gist when the old one is gone (update → null)', async () => {
    readNote.mockResolvedValue(REPUBLISH_SOURCE)
    updateGist.mockResolvedValue(null)
    await expect(publishNoteToGist('notes/a.md', 3)).resolves.toBe(PUBLISHED.htmlUrl)

    expect(createGist).toHaveBeenCalled()
    const written = writeNote.mock.calls[0] as unknown as [string, string, number]
    expect(written[1]).toContain('id: g1')
  })

  it('routes the frontmatter write through the live session when the note is open', async () => {
    const { session, commitFrontmatter } = fakeSession(BODY)
    openSession.mockReturnValue(session)
    await publishNoteToGist('notes/a.md', 3)

    expect(commitFrontmatter).toHaveBeenCalledWith({
      gist: { id: 'g1', url: PUBLISHED.htmlUrl, file: 'A.md', hash: gistBodyHash(BODY) },
    })
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const { session } = fakeSession(BODY, false)
    openSession.mockReturnValue(session)
    readNote.mockResolvedValue(BODY)
    await publishNoteToGist('notes/a.md', 3)
    expect(writeNote).toHaveBeenCalled()
  })

  it('reads disk, not the empty buffer, when the open session is still loading', async () => {
    // liveContent === null means the buffer isn't the truth yet: publish must
    // read the real body from disk, not publish an empty gist.
    const { session } = fakeSession('', false, null)
    openSession.mockReturnValue(session)
    readNote.mockResolvedValue(BODY)

    await publishNoteToGist('notes/a.md', 3)

    expect(createGist).toHaveBeenCalledWith(
      'tok',
      { name: 'A.md', content: BODY },
      expect.any(Function),
    )
    expect(writeNote).toHaveBeenCalled()
  })

  it('refuses to publish a private note before anything leaves the device', async () => {
    readNote.mockResolvedValue('---\nprivate: true\n---\nsecret')
    await expect(publishNoteToGist('notes/a.md', 3)).rejects.toMatchObject({
      name: 'PrivateNoteError',
    })
    expect(getGithubToken).not.toHaveBeenCalled()
    expect(createGist).not.toHaveBeenCalled()
    expect(updateGist).not.toHaveBeenCalled()
  })

  it('refuses an empty note', async () => {
    readNote.mockResolvedValue('---\npinned: true\n---\n')
    await expect(publishNoteToGist('notes/a.md', 3)).rejects.toMatchObject({
      message: expect.stringMatching(/empty/i),
    })
    expect(createGist).not.toHaveBeenCalled()
  })

  it('asks for a GitHub connection when no credential is stored', async () => {
    readNote.mockResolvedValue(BODY)
    getGithubToken.mockResolvedValue(null)
    await expect(publishNoteToGist('notes/a.md', 3)).rejects.toMatchObject({
      kind: 'auth',
      message: expect.stringMatching(/connect github/i),
    })
  })

  it('refuses invalid frontmatter before anything reaches GitHub (the record write would refuse)', async () => {
    readNote.mockResolvedValue('---\nfoo: [unclosed\n---\nbody')
    await expect(publishNoteToGist('notes/a.md', 3)).rejects.toMatchObject({
      kind: 'parse',
      message: expect.stringMatching(/invalid frontmatter/i),
    })
    expect(createGist).not.toHaveBeenCalled()
    expect(updateGist).not.toHaveBeenCalled()
  })

  it('deletes a freshly created gist when recording it locally fails (no orphans)', async () => {
    readNote.mockResolvedValue(BODY)
    writeNote.mockRejectedValueOnce(new Error('disk on fire'))
    await expect(publishNoteToGist('notes/a.md', 3)).rejects.toMatchObject({
      message: 'disk on fire',
    })
    expect(deleteGist).toHaveBeenCalledWith('tok', 'g1', expect.any(Function))
  })

  it('never deletes the existing gist when recording a republish fails (shared links survive)', async () => {
    readNote.mockResolvedValue(REPUBLISH_SOURCE)
    updateGist.mockResolvedValue({ id: 'g0', htmlUrl: 'https://gist.github.com/alex/g0' })
    writeNote.mockRejectedValueOnce(new Error('disk on fire'))
    await expect(publishNoteToGist('notes/a.md', 3)).rejects.toMatchObject({
      message: 'disk on fire',
    })
    expect(deleteGist).not.toHaveBeenCalled()
  })

  it('still surfaces the record failure when the compensating delete also fails', async () => {
    readNote.mockResolvedValue(BODY)
    writeNote.mockRejectedValueOnce(new Error('disk on fire'))
    deleteGist.mockRejectedValueOnce(new Error('network down'))
    await expect(publishNoteToGist('notes/a.md', 3)).rejects.toMatchObject({
      message: 'disk on fire',
    })
  })
})

describe('unpublishNoteGist', () => {
  it('deletes the existing gist and removes the frontmatter block', async () => {
    readNote.mockResolvedValue(REPUBLISH_SOURCE)
    await expect(unpublishNoteGist('notes/a.md', 3)).resolves.toBeUndefined()

    expect(deleteGist).toHaveBeenCalledWith('tok', 'g0', expect.any(Function))
    expect(writeNote).toHaveBeenCalledWith('notes/a.md', BODY, 3)
  })

  it('does not delete the remote gist when clearing local frontmatter fails', async () => {
    readNote.mockResolvedValue(REPUBLISH_SOURCE)
    writeNote.mockRejectedValueOnce(new Error('disk on fire'))

    await expect(unpublishNoteGist('notes/a.md', 3)).rejects.toMatchObject({
      message: 'disk on fire',
    })

    expect(deleteGist).not.toHaveBeenCalled()
  })

  it('restores local gist frontmatter when the remote delete fails', async () => {
    readNote
      .mockResolvedValueOnce(REPUBLISH_SOURCE)
      .mockResolvedValueOnce(REPUBLISH_SOURCE)
      .mockResolvedValueOnce(BODY)
    deleteGist.mockRejectedValueOnce(new Error('network down'))

    await expect(unpublishNoteGist('notes/a.md', 3)).rejects.toMatchObject({
      message: 'network down',
    })

    expect(writeNote).toHaveBeenNthCalledWith(1, 'notes/a.md', BODY, 3)
    expect(writeNote).toHaveBeenNthCalledWith(2, 'notes/a.md', REPUBLISH_SOURCE, 3)
  })

  it('routes the gist removal through the live session when the note is open', async () => {
    const { session, commitFrontmatter } = fakeSession(REPUBLISH_SOURCE)
    openSession.mockReturnValue(session)

    await unpublishNoteGist('notes/a.md', 3)

    expect(commitFrontmatter).toHaveBeenCalledWith({ gist: false })
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('is a no-op when the note has no gist block', async () => {
    readNote.mockResolvedValue(BODY)

    await unpublishNoteGist('notes/a.md', 3)

    expect(deleteGist).not.toHaveBeenCalled()
    expect(writeNote).not.toHaveBeenCalled()
  })

  it('asks for a GitHub connection before deleting the gist', async () => {
    readNote.mockResolvedValue(REPUBLISH_SOURCE)
    getGithubToken.mockResolvedValue(null)

    await expect(unpublishNoteGist('notes/a.md', 3)).rejects.toMatchObject({
      kind: 'auth',
      message: expect.stringMatching(/connect github/i),
    })
    expect(deleteGist).not.toHaveBeenCalled()
  })
})

describe('runGistPublish', () => {
  const writeText = vi.fn(async () => {})

  beforeEach(() => {
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
  })

  it('publishes, copies the link, and confirms through the operations line', async () => {
    readNote.mockResolvedValue(BODY)
    await expect(runGistPublish('notes/a.md', 3)).resolves.toBe(PUBLISHED.htmlUrl)

    expect(writeText).toHaveBeenCalledWith(PUBLISHED.htmlUrl)
    expect(startOperation).toHaveBeenCalledWith('Publishing gist')
    expect(startOperation).toHaveBeenCalledWith('Gist link copied')
    expect(operationDone).toHaveBeenCalledTimes(2)
    expect(operationFail).not.toHaveBeenCalled()
  })

  it('records the published url in the optimistic overlay, stamped with the generation', async () => {
    readNote.mockResolvedValue(BODY)
    await runGistPublish('notes/a.md', 3)

    expect(getNoteRowOverlay('notes/a.md', 3)).toMatchObject({
      gistUrl: PUBLISHED.htmlUrl,
      gistStale: false,
    })
    // Stamped with the publishing generation — a reader on another graph won't see it.
    expect(getNoteRowOverlay('notes/a.md', 4)).toBeNull()
  })

  it('leaves no overlay when the publish failed', async () => {
    readNote.mockResolvedValue(BODY)
    getGithubToken.mockResolvedValue(null)
    await runGistPublish('notes/a.md', 3)

    expect(getNoteRowOverlay('notes/a.md', 3)).toBeNull()
  })

  it('surfaces failures and resolves null', async () => {
    readNote.mockResolvedValue(BODY)
    getGithubToken.mockResolvedValue(null)
    await expect(runGistPublish('notes/a.md', 3)).resolves.toBeNull()

    expect(operationFail).toHaveBeenCalledWith(expect.stringMatching(/connect github/i))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('a failed clipboard copy never reads as a failed publish', async () => {
    readNote.mockResolvedValue(BODY)
    writeText.mockRejectedValueOnce(new Error('Document is not focused'))
    // The publish landed: the url comes back so the UI flips to its published state.
    await expect(runGistPublish('notes/a.md', 3)).resolves.toBe(PUBLISHED.htmlUrl)

    expect(startOperation).toHaveBeenCalledWith('Publishing gist')
    expect(startOperation).toHaveBeenCalledWith('Copying the gist link')
    expect(startOperation).not.toHaveBeenCalledWith('Gist link copied')
    expect(operationDone).toHaveBeenCalledTimes(1) // the publish itself
    expect(operationFail).toHaveBeenCalledWith(expect.stringMatching(/not focused/i))
  })
})

describe('runGistUnpublish', () => {
  it('unpublishes and clears the published url in the optimistic overlay', async () => {
    readNote.mockResolvedValue(REPUBLISH_SOURCE)

    await expect(runGistUnpublish('notes/a.md', 3)).resolves.toBe(true)

    expect(startOperation).toHaveBeenCalledWith('Unpublishing gist')
    expect(operationDone).toHaveBeenCalled()
    expect(getNoteRowOverlay('notes/a.md', 3)).toMatchObject({ gistUrl: null, gistStale: false })
  })

  it('surfaces failures and leaves no overlay', async () => {
    readNote.mockResolvedValue(REPUBLISH_SOURCE)
    getGithubToken.mockResolvedValue(null)

    await expect(runGistUnpublish('notes/a.md', 3)).resolves.toBe(false)

    expect(operationFail).toHaveBeenCalledWith(expect.stringMatching(/connect github/i))
    expect(getNoteRowOverlay('notes/a.md', 3)).toBeNull()
  })
})
