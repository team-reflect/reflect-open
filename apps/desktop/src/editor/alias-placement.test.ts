import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * IO-bound core functions are mocked; the pure helpers (`parseNote`,
 * `nextAliases`, `upsertFrontmatter`) stay real so the alias math is
 * exercised, not restated — the same split as the coordinator tests.
 */
const io = vi.hoisted(() => ({
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote: io.readNote,
  writeNote: io.writeNote,
}))

const docs = vi.hoisted(() => ({ openSession: vi.fn() }))
vi.mock('./open-documents', () => ({
  openSession: docs.openSession,
}))

const { placeOldTitleAlias } = await import('./alias-placement')

const PATH = 'notes/subject.md'
const RENAME = { from: 'Old Title', to: 'New Title', previousAutoAliases: [] }

beforeEach(() => {
  io.readNote.mockReset()
  io.writeNote.mockReset().mockResolvedValue(undefined)
  docs.openSession.mockReset().mockReturnValue(null)
})

function fakeSession(options?: { content?: string; takesPatch?: boolean }) {
  return {
    content: () => options?.content ?? '# Old Title\n\nbody\n',
    updateFrontmatter: vi.fn().mockReturnValue(options?.takesPatch ?? true),
    flush: vi.fn().mockResolvedValue(undefined),
  }
}

describe('placeOldTitleAlias', () => {
  it('with no live session, patches the alias straight onto disk at the generation', async () => {
    io.readNote.mockResolvedValue('# Old Title\n\nbody\n')

    await placeOldTitleAlias(PATH, RENAME, 7)

    expect(io.writeNote).toHaveBeenCalledTimes(1)
    const [path, content, generation] = io.writeNote.mock.calls[0]!
    expect(path).toBe(PATH)
    expect(content).toContain('aliases:')
    expect(content).toContain('Old Title')
    expect(content).toContain('# Old Title\n\nbody\n') // body untouched
    expect(generation).toBe(7)
  })

  it('routes through a live session: frontmatter channel, then flush, no disk write', async () => {
    const session = fakeSession()
    docs.openSession.mockReturnValue(session)

    await placeOldTitleAlias(PATH, RENAME, 7)

    expect(session.updateFrontmatter).toHaveBeenCalledWith({ aliases: ['Old Title'] })
    expect(session.flush).toHaveBeenCalledTimes(1)
    expect(io.readNote).not.toHaveBeenCalled()
    expect(io.writeNote).not.toHaveBeenCalled()
  })

  it('falls back to disk when the session cannot take the patch', async () => {
    const session = fakeSession({ takesPatch: false })
    docs.openSession.mockReturnValue(session)
    io.readNote.mockResolvedValue('# Old Title\n\nbody\n')

    await placeOldTitleAlias(PATH, RENAME, 7)

    expect(session.flush).not.toHaveBeenCalled()
    expect(io.writeNote).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when the alias would be redundant', async () => {
    // A case-only retitle: the old title folds to the new one, so keeping it
    // as an alias would alias a note to its own title.
    const session = fakeSession({ content: '# new title\n' })
    docs.openSession.mockReturnValue(session)

    await placeOldTitleAlias(PATH, { ...RENAME, from: 'new title' }, 7)

    expect(session.updateFrontmatter).not.toHaveBeenCalled()
    expect(session.flush).not.toHaveBeenCalled()
    expect(io.writeNote).not.toHaveBeenCalled()
  })

  it('returns the aliases it added, for the next rename in the chain to prune', async () => {
    const session = fakeSession({ content: '---\naliases:\n  - Dad\n---\n# Timothy MacCaw\n' })
    docs.openSession.mockReturnValue(session)

    const added = await placeOldTitleAlias(
      PATH,
      { from: 'Tim MacCaw // Dad', to: 'Timothy MacCaw', previousAutoAliases: [] },
      7,
    )

    expect(added).toEqual(['Tim MacCaw', 'Tim MacCaw // Dad'])
    expect(session.updateFrontmatter).toHaveBeenCalledWith({
      aliases: ['Dad', 'Tim MacCaw', 'Tim MacCaw // Dad'],
    })
  })

  it('tracks a segment the previous title still derived once a rename drops it', async () => {
    // First leg: `Alice // Dad` -> `Bob // Dad` added `Alice` and the whole title
    // but not `Dad`, which the new title still derived. Second leg: `Dad` is
    // added for the first time, so it must count as auto-added.
    const session = fakeSession({
      content: '---\naliases:\n  - Alice\n  - Alice // Dad\n---\n# Carol\n',
    })
    docs.openSession.mockReturnValue(session)

    const added = await placeOldTitleAlias(
      PATH,
      { from: 'Bob // Dad', to: 'Carol', previousAutoAliases: ['Alice', 'Alice // Dad'] },
      7,
    )

    expect(added).toEqual(['Bob', 'Dad', 'Bob // Dad'])
    expect(session.updateFrontmatter).toHaveBeenCalledWith({
      aliases: ['Bob', 'Dad', 'Bob // Dad'],
    })
  })

  it('computes against the session buffer, preserving concurrently-gained aliases', async () => {
    const session = fakeSession({
      content: '---\naliases:\n  - Gained Elsewhere\n---\n# Old Title\n',
    })
    docs.openSession.mockReturnValue(session)

    await placeOldTitleAlias(PATH, RENAME, 7)

    expect(session.updateFrontmatter).toHaveBeenCalledWith({
      aliases: ['Gained Elsewhere', 'Old Title'],
    })
  })
})
