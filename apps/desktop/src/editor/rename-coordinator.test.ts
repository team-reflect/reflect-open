import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertFrontmatter } from '@reflect/core'
import { onNoteMoved } from '@/lib/note-moves'
import type { NoteSession } from './note-session'
import { openSession, registerOpenDocument, retargetOpenDocument } from './open-documents'

/**
 * The rename coordinator owns the riskiest background work in the app: a
 * settled title change fans out into a graph-wide link rewrite plus an alias
 * placement, serialized, generation-checked, and reported through the
 * operations store. These tests drive `createRenameCoordinator` directly
 * through its `content`/`settle` surface (the same calls the document hook
 * makes) with the IO-bound core functions mocked; the pure helpers
 * (`parseNote`, `nextAliases`, `upsertFrontmatter`) stay real so alias math
 * is exercised, not restated.
 */

const io = vi.hoisted(() => ({
  rewriteLinksForTitleChange: vi.fn(),
  getLinkSources: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
  resolveWikiTarget: vi.fn(),
  slugPathForTitle: vi.fn(),
  moveNoteIndexed: vi.fn(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  rewriteLinksForTitleChange: io.rewriteLinksForTitleChange,
  getLinkSources: io.getLinkSources,
  readNote: io.readNote,
  writeNote: io.writeNote,
  resolveWikiTarget: io.resolveWikiTarget,
  slugPathForTitle: io.slugPathForTitle,
  moveNoteIndexed: io.moveNoteIndexed,
}))

interface RecordedOperation {
  label: string
  outcome: 'running' | 'done' | 'failed'
  message: string | null
}
const operationLog = vi.hoisted(() => ({ records: [] as RecordedOperation[] }))
vi.mock('@/lib/operations', () => ({
  startOperation: (label: string) => {
    const record: RecordedOperation = { label, outcome: 'running', message: null }
    operationLog.records.push(record)
    return {
      progress: () => {},
      done: () => {
        record.outcome = 'done'
      },
      fail: (message: string) => {
        record.outcome = 'failed'
        record.message = message
      },
    }
  },
}))

const { createRenameCoordinator } = await import('./rename-coordinator')

const PATH = 'notes/subject.md'

function makeCoordinator(overrides?: {
  generation?: () => number | null
  canFire?: () => boolean
}) {
  return createRenameCoordinator({
    path: PATH,
    generation: overrides?.generation ?? (() => 7),
    canFire: overrides?.canFire ?? (() => true),
  })
}

/** Drive one settled rename: baseline at `from`, save `to`, settle, await. */
async function renameOnce(
  coordinator: ReturnType<typeof makeCoordinator>,
  from: string,
  to: string,
): Promise<void> {
  coordinator.content(`# ${from}\n`, 'load')
  coordinator.content(`# ${to}\n`, 'saved')
  coordinator.settle()
  await coordinator.settled()
}

function fakeSession(content: string): NoteSession & {
  updateFrontmatter: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  retarget: ReturnType<typeof vi.fn>
} {
  let path = PATH
  return {
    get path() {
      return path
    },
    retarget: vi.fn((to: string) => {
      path = to
    }),
    load: () => {},
    editorChanged: () => {},
    externalChanged: () => {},
    flush: vi.fn(async () => {}),
    keepMine: () => {},
    loadTheirs: () => {},
    commitFrontmatter: async () => true,
    content: () => content,
    liveContent: () => content,
    updateFrontmatter: vi.fn(() => true),
    commitTaskToggle: async () => false,
    commitTaskEdit: async () => false,
    commitTaskRemove: async () => false,
    commitTaskToBullet: async () => false,
    dispose: () => {},
    discard: () => {},
  }
}

beforeEach(() => {
  io.rewriteLinksForTitleChange.mockReset()
  io.rewriteLinksForTitleChange.mockResolvedValue({ rewritten: 1, failed: 0, collision: false })
  io.readNote.mockReset()
  io.writeNote.mockReset()
  io.writeNote.mockResolvedValue(undefined)
  // Default: the filename already matches the title — no move. Move-specific
  // tests override with a diverging target.
  io.slugPathForTitle.mockReset()
  io.slugPathForTitle.mockImplementation(async (path: string) => path)
  io.moveNoteIndexed.mockReset()
  io.moveNoteIndexed.mockResolvedValue(undefined)
  operationLog.records.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rename coordinator', () => {
  it('rewrites links with the generation read at run time, then writes the alias to disk', async () => {
    const content = '# New Title\n'
    io.readNote.mockResolvedValue(content)
    let generation = 3
    const coordinator = makeCoordinator({ generation: () => generation })
    coordinator.content('# Old Title\n', 'load')
    coordinator.content(content, 'saved')
    generation = 4 // bumps between save and settle — the rewrite must see 4
    coordinator.settle()
    await coordinator.settled()

    expect(io.rewriteLinksForTitleChange).toHaveBeenCalledTimes(1)
    const rewrite = io.rewriteLinksForTitleChange.mock.calls[0]![0] as {
      path: string
      from: string
      to: string
      io: { write: (path: string, contents: string) => Promise<void> }
    }
    expect(rewrite).toMatchObject({ path: PATH, from: 'Old Title', to: 'New Title' })
    await rewrite.io.write('notes/linker.md', 'patched')
    expect(io.writeNote).toHaveBeenCalledWith('notes/linker.md', 'patched', 4)

    // No live session → the alias lands via a direct disk write.
    const expected = upsertFrontmatter(content, { aliases: ['Old Title'] })
    expect(io.writeNote).toHaveBeenCalledWith(PATH, expected, 4)
    expect(operationLog.records).toEqual([
      { label: 'Renaming "Old Title" → "New Title"', outcome: 'done', message: null },
    ])
  })

  it('routes the alias through a live session instead of the disk', async () => {
    const session = fakeSession('# New Title\n')
    const unregister = registerOpenDocument({ session })
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')

      expect(session.updateFrontmatter).toHaveBeenCalledWith({ aliases: ['Old Title'] })
      expect(session.flush).toHaveBeenCalled()
      expect(io.readNote).not.toHaveBeenCalled()
      expect(io.writeNote).not.toHaveBeenCalled() // rewrite IO mocked whole; alias write only
    } finally {
      unregister()
    }
  })

  it('falls back to the disk write when the session cannot take the patch', async () => {
    const session = fakeSession('# New Title\n')
    session.updateFrontmatter.mockReturnValue(false) // loading/protected/disposed
    const unregister = registerOpenDocument({ session })
    io.readNote.mockResolvedValue('# New Title\n')
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')

      expect(session.flush).not.toHaveBeenCalled()
      const expected = upsertFrontmatter('# New Title\n', { aliases: ['Old Title'] })
      expect(io.writeNote).toHaveBeenCalledWith(PATH, expected, 7)
    } finally {
      unregister()
    }
  })

  it('a collision rewrites nothing onto the note: no alias write, operation done', async () => {
    io.rewriteLinksForTitleChange.mockResolvedValue({ rewritten: 0, failed: 0, collision: true })
    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(io.readNote).not.toHaveBeenCalled()
    expect(io.writeNote).not.toHaveBeenCalled()
    expect(operationLog.records[0]!.outcome).toBe('done')
  })

  it('a failed rewrite still places the alias (the safety net) and says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    io.rewriteLinksForTitleChange.mockRejectedValue(new Error('index unavailable'))
    io.readNote.mockResolvedValue('# New Title\n')
    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    const expected = upsertFrontmatter('# New Title\n', { aliases: ['Old Title'] })
    expect(io.writeNote).toHaveBeenCalledWith(PATH, expected, 7)
    expect(operationLog.records[0]!.outcome).toBe('failed')
    expect(operationLog.records[0]!.message).toContain('index unavailable')
    expect(operationLog.records[0]!.message).toContain('kept as an alias')
  })

  it('a failed alias after a clean rewrite reports exactly that', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    io.readNote.mockRejectedValue(new Error('read denied'))
    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(operationLog.records[0]!.outcome).toBe('failed')
    expect(operationLog.records[0]!.message).toContain('links were rewritten')
    expect(operationLog.records[0]!.message).toContain('read denied')
  })

  it('both phases failing reports both, flagging links that may not resolve', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    io.rewriteLinksForTitleChange.mockRejectedValue(new Error('index unavailable'))
    io.readNote.mockRejectedValue(new Error('read denied'))
    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    const { message } = operationLog.records[0]!
    expect(message).toContain('index unavailable')
    expect(message).toContain('read denied')
    expect(message).toContain('may no longer resolve')
  })

  it('drops the rename loudly when no graph generation is available', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const coordinator = makeCoordinator({ generation: () => null })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(io.rewriteLinksForTitleChange).not.toHaveBeenCalled()
    expect(operationLog.records).toEqual([]) // nothing to show: no work started
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('rename dropped'))
  })

  it('a blocked settle keeps the rename pending; the next settle fires it', async () => {
    let armed = false
    const coordinator = makeCoordinator({ canFire: () => armed })
    io.readNote.mockResolvedValue('# New Title\n')
    coordinator.content('# Old Title\n', 'load')
    coordinator.content('# New Title\n', 'saved')
    coordinator.settle() // conflict parked: must not fire
    await coordinator.settled()
    expect(io.rewriteLinksForTitleChange).not.toHaveBeenCalled()

    armed = true // "keep mine" resolved the conflict
    coordinator.settle()
    await coordinator.settled()
    expect(io.rewriteLinksForTitleChange).toHaveBeenCalledTimes(1)
  })

  it('external content re-baselines: no rewrite for titles the user did not author', async () => {
    const coordinator = makeCoordinator()
    coordinator.content('# Old Title\n', 'load')
    coordinator.content('# Synced Title\n', 'external') // another device renamed it
    coordinator.settle()
    await coordinator.settled()
    expect(io.rewriteLinksForTitleChange).not.toHaveBeenCalled()
  })

  it('moves the file onto the new slug: flush, retarget, registry re-key, then the move', async () => {
    const session = fakeSession('# New Title\n')
    const unregister = registerOpenDocument({ session })
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => moves.push([from, to]))
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')

      expect(session.flush).toHaveBeenCalled()
      expect(session.retarget).toHaveBeenCalledWith('notes/new-title.md')
      expect(io.moveNoteIndexed).toHaveBeenCalledWith(PATH, 'notes/new-title.md', 7)
      // The registry follows: lookups under the new path find the live session.
      expect(openSession('notes/new-title.md')).toBe(session)
      expect(openSession(PATH)).toBeNull()
      expect(moves).toEqual([[PATH, 'notes/new-title.md']])
      expect(operationLog.records[0]!.outcome).toBe('done')
    } finally {
      unsubscribe()
      retargetOpenDocument('notes/new-title.md', PATH, session) // restore for other tests
      unregister()
    }
  })

  it('a birth (first authored title) moves the file without rewrite or alias', async () => {
    io.slugPathForTitle.mockResolvedValue('notes/fresh-note.md')
    const coordinator = makeCoordinator()
    coordinator.content('', 'load') // untitled lazy note
    coordinator.content('# Fresh Note\n', 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(io.rewriteLinksForTitleChange).not.toHaveBeenCalled()
    expect(io.writeNote).not.toHaveBeenCalled() // no alias for a birth
    expect(io.moveNoteIndexed).toHaveBeenCalledWith(PATH, 'notes/fresh-note.md', 7)
    expect(operationLog.records).toEqual([
      { label: 'Naming "Fresh Note"', outcome: 'done', message: null },
    ])
  })

  it('a failed move retargets the session back and reports filename drift', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = fakeSession('# New Title\n')
    const unregister = registerOpenDocument({ session })
    io.readNote.mockResolvedValue('# New Title\n')
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.moveNoteIndexed.mockRejectedValue(new Error('disk full'))
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')

      // Retargeted out and back: the session ends bound to its original path.
      expect(session.retarget).toHaveBeenNthCalledWith(1, 'notes/new-title.md')
      expect(session.retarget).toHaveBeenNthCalledWith(2, PATH)
      expect(openSession(PATH)).toBe(session)
      expect(operationLog.records[0]!.outcome).toBe('failed')
      expect(operationLog.records[0]!.message).toContain('keeps its old name')
      expect(operationLog.records[0]!.message).toContain('disk full')
    } finally {
      unregister()
    }
  })

  it('the rewrite collision guard does not block the move (filename follows the NEW title)', async () => {
    io.rewriteLinksForTitleChange.mockResolvedValue({ rewritten: 0, failed: 0, collision: true })
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(io.writeNote).not.toHaveBeenCalled() // collision: no alias claimed
    expect(io.moveNoteIndexed).toHaveBeenCalledWith(PATH, 'notes/new-title.md', 7)
  })

  it('a follow-up rename works against the moved path', async () => {
    io.readNote.mockResolvedValue('# B\n')
    io.slugPathForTitle.mockResolvedValueOnce('notes/b.md')
    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'A', 'B')
    expect(io.moveNoteIndexed).toHaveBeenCalledWith(PATH, 'notes/b.md', 7)

    io.readNote.mockResolvedValue('# C\n')
    io.slugPathForTitle.mockResolvedValueOnce('notes/c.md')
    coordinator.content('# C\n', 'saved')
    coordinator.settle()
    await coordinator.settled()

    // Both the rewrite and the second move key off the note's current path.
    expect(io.rewriteLinksForTitleChange.mock.calls[1]![0]).toMatchObject({
      path: 'notes/b.md',
    })
    expect(io.slugPathForTitle).toHaveBeenLastCalledWith('notes/b.md', 'C')
    expect(io.moveNoteIndexed).toHaveBeenLastCalledWith('notes/b.md', 'notes/c.md', 7)
  })

  it('chained renames serialize and prune the previous auto-alias', async () => {
    const coordinator = makeCoordinator()
    io.readNote.mockResolvedValue('# B\n')
    await renameOnce(coordinator, 'A', 'B')

    // Second leg: the note on disk now carries A as the auto-added alias.
    io.readNote.mockResolvedValue(upsertFrontmatter('# C\n', { aliases: ['A'] }))
    coordinator.content('# C\n', 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(io.rewriteLinksForTitleChange).toHaveBeenCalledTimes(2)
    expect(io.rewriteLinksForTitleChange.mock.calls[0]![0]).toMatchObject({ from: 'A', to: 'B' })
    expect(io.rewriteLinksForTitleChange.mock.calls[1]![0]).toMatchObject({ from: 'B', to: 'C' })
    // A (the intermediate title) is pruned; B (the latest old title) joins.
    const secondAliasWrite = io.writeNote.mock.calls.filter((call) => call[0] === PATH).at(-1)
    expect(secondAliasWrite?.[1]).toBe(
      upsertFrontmatter(upsertFrontmatter('# C\n', { aliases: ['A'] }), { aliases: ['B'] }),
    )
  })
})
