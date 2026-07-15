import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { upsertFrontmatter, type PrepareNoteMoveRewritesOptions } from '@reflect/core'
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
  prepareNoteMoveRewrites: vi.fn(),
  listFiles: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
  writeNoteIfUnchanged: vi.fn(),
  resolveExistingWikiTarget: vi.fn(),
  slugPathForTitle: vi.fn(),
  moveNoteIndexed: vi.fn(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  rewriteLinksForTitleChange: io.rewriteLinksForTitleChange,
  prepareNoteMoveRewrites: io.prepareNoteMoveRewrites,
  listFiles: io.listFiles,
  readNote: io.readNote,
  writeNote: io.writeNote,
  writeNoteIfUnchanged: io.writeNoteIfUnchanged,
  resolveExistingWikiTarget: io.resolveExistingWikiTarget,
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
const MANAGED_ID = '01hv3xq7c2dm8k4t9w5e6r1n98'

function managed(content: string): string {
  return upsertFrontmatter(content, { id: MANAGED_ID })
}

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
  coordinator.content(managed(`# ${from}\n`), 'load')
  coordinator.content(managed(`# ${to}\n`), 'saved')
  coordinator.settle()
  await coordinator.settled()
}

function fakeSession(content: string, initialPath = PATH): NoteSession & {
  updateFrontmatter: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  retarget: ReturnType<typeof vi.fn>
  commitExactContentReplacement: ReturnType<typeof vi.fn>
  setContent: (content: string) => void
} {
  let path = initialPath
  let live = content
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
    externalRemoved: () => {},
    flush: vi.fn(async () => {}),
    keepMine: () => {},
    isDirty: () => false,
    loadTheirs: () => {},
    commitFrontmatter: async () => true,
    content: () => live,
    liveContent: () => live,
    updateFrontmatter: vi.fn(() => true),
    commitExactContentReplacement: vi.fn(async (expected: string, replacement: string) => {
      if (live !== expected) {
        return false
      }
      live = replacement
      return true
    }),
    setContent: (next: string) => {
      live = next
    },
    commitTaskToggle: async () => false,
    commitTaskEdit: async () => false,
    commitTaskRemove: async () => false,
    commitTaskToBullet: async () => false,
    commitBodyAppend: async () => false,
    dispose: () => {},
    discard: () => {},
  }
}

beforeEach(() => {
  io.rewriteLinksForTitleChange.mockReset()
  io.rewriteLinksForTitleChange.mockResolvedValue({ rewritten: [], failed: [], collision: false })
  io.listFiles.mockReset()
  io.listFiles.mockResolvedValue([{ path: PATH, size: 1, modifiedMs: 1 }])
  io.prepareNoteMoveRewrites.mockReset()
  io.prepareNoteMoveRewrites.mockResolvedValue({ rewrites: [], failed: [] })
  io.readNote.mockReset()
  io.writeNote.mockReset()
  io.writeNote.mockResolvedValue(undefined)
  io.writeNoteIfUnchanged.mockReset()
  io.writeNoteIfUnchanged.mockImplementation(
    async (path: string, expected: string, contents: string, generation: number) => {
      if ((await io.readNote(path, generation)) !== expected) {
        return { kind: 'changed' as const }
      }
      await io.writeNote(path, contents, generation)
      return { kind: 'written' as const, modifiedMs: 1 }
    },
  )
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
    const content = managed('# New Title\n')
    io.readNote.mockResolvedValue(content)
    let generation = 3
    const coordinator = makeCoordinator({ generation: () => generation })
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(content, 'saved')
    generation = 4 // bumps between save and settle — the rewrite must see 4
    coordinator.settle()
    await coordinator.settled()

    expect(io.rewriteLinksForTitleChange).toHaveBeenCalledTimes(1)
    const rewrite = io.rewriteLinksForTitleChange.mock.calls[0]![0] as {
      path: string
      from: string
      to: string
      io: {
        read: (path: string) => Promise<string>
        write: (path: string, contents: string) => Promise<void>
      }
    }
    expect(rewrite).toMatchObject({ path: PATH, from: 'Old Title', to: 'New Title' })
    expect(await rewrite.io.read('notes/linker.md')).toBe(content)
    await rewrite.io.write('notes/linker.md', 'patched')
    expect(io.writeNoteIfUnchanged).toHaveBeenCalledWith(
      'notes/linker.md',
      content,
      'patched',
      4,
    )
    expect(io.writeNote).toHaveBeenCalledWith('notes/linker.md', 'patched', 4)

    // No live session → the alias lands via a direct disk write.
    const expected = upsertFrontmatter(content, { aliases: ['Old Title'] })
    expect(io.writeNote).toHaveBeenCalledWith(PATH, expected, 4)
    expect(operationLog.records).toEqual([
      { label: 'Renaming "Old Title" → "New Title"', outcome: 'done', message: null },
    ])
  })

  it('seeds title-wikilink rewriting from the complete live manifest', async () => {
    const sourcePath = 'Projects/unindexed.md'
    io.listFiles.mockResolvedValue([
      { path: PATH, size: 1, modifiedMs: 1 },
      { path: sourcePath, size: 1, modifiedMs: 1 },
    ])
    io.readNote.mockResolvedValue(managed('# New Title\n'))
    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    const rewrite = io.rewriteLinksForTitleChange.mock.calls[0]![0] as {
      io: { sources: (targetKey: string) => Promise<string[]> }
    }
    await expect(rewrite.io.sources('old title')).resolves.toEqual([PATH, sourcePath])
    expect(io.listFiles).toHaveBeenCalledTimes(1)
  })

  it('routes title-wikilink rewrites through an open source session', async () => {
    const sourcePath = 'Projects/source.md'
    const before = 'See [[Old Title]].\n'
    const after = 'See [[New Title]].\n'
    const session = fakeSession(before, sourcePath)
    const unregister = registerOpenDocument({ session })
    io.readNote.mockResolvedValue(managed('# New Title\n'))
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')
      const rewrite = io.rewriteLinksForTitleChange.mock.calls[0]![0] as {
        io: {
          read: (path: string) => Promise<string>
          write: (path: string, contents: string) => Promise<void>
        }
      }

      expect(await rewrite.io.read(sourcePath)).toBe(before)
      await rewrite.io.write(sourcePath, after)

      expect(session.commitExactContentReplacement).toHaveBeenCalledWith(before, after)
      expect(session.content()).toBe(after)
      expect(io.readNote).not.toHaveBeenCalledWith(sourcePath, expect.anything())
      expect(io.writeNote).not.toHaveBeenCalledWith(
        sourcePath,
        expect.any(String),
        expect.any(Number),
      )
    } finally {
      unregister()
    }
  })

  it('fails a title-wikilink rewrite instead of clobbering a changed open source', async () => {
    const sourcePath = 'Projects/source.md'
    const before = 'See [[Old Title]].\n'
    const session = fakeSession(before, sourcePath)
    const unregister = registerOpenDocument({ session })
    io.readNote.mockResolvedValue(managed('# New Title\n'))
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')
      const rewrite = io.rewriteLinksForTitleChange.mock.calls[0]![0] as {
        io: {
          read: (path: string) => Promise<string>
          write: (path: string, contents: string) => Promise<void>
        }
      }
      expect(await rewrite.io.read(sourcePath)).toBe(before)
      session.setContent('Unsaved edit with [[Old Title]].\n')

      await expect(rewrite.io.write(sourcePath, 'See [[New Title]].\n')).rejects.toThrow(
        'changed before rewrite',
      )
      expect(session.content()).toBe('Unsaved edit with [[Old Title]].\n')
      expect(io.writeNote).not.toHaveBeenCalledWith(
        sourcePath,
        expect.any(String),
        expect.any(Number),
      )
    } finally {
      unregister()
    }
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
    io.rewriteLinksForTitleChange.mockResolvedValue({ rewritten: [], failed: [], collision: true })
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
    io.readNote.mockResolvedValue(managed('# New Title\n'))
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(managed('# New Title\n'), 'saved')
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
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(managed('# Synced Title\n'), 'external') // another device renamed it
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

  it('prepares and writes exact path backlinks before moving a managed note', async () => {
    const sourcePath = 'Projects/source.md'
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.listFiles.mockResolvedValue([
      { path: PATH, size: 1, modifiedMs: 1 },
      { path: sourcePath, size: 1, modifiedMs: 1 },
    ])
    io.prepareNoteMoveRewrites.mockResolvedValue({
      failed: [],
      rewrites: [
        {
          path: sourcePath,
          before: '[Subject](../notes/subject.md)\n',
          after: '[Subject](../notes/new-title.md)\n',
        },
      ],
    })
    io.readNote.mockImplementation(async (path: string) =>
      path === sourcePath
        ? '[Subject](../notes/subject.md)\n'
        : '# New Title\n',
    )

    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(io.prepareNoteMoveRewrites).toHaveBeenCalledWith(
      expect.objectContaining({
        fromPath: PATH,
        toPath: 'notes/new-title.md',
        notePaths: [PATH, sourcePath],
      }),
    )
    expect(io.listFiles).toHaveBeenCalledWith(7)
    expect(io.writeNoteIfUnchanged).toHaveBeenCalledWith(
      sourcePath,
      '[Subject](../notes/subject.md)\n',
      '[Subject](../notes/new-title.md)\n',
      7,
    )
    expect(io.writeNote).toHaveBeenCalledWith(
      sourcePath,
      '[Subject](../notes/new-title.md)\n',
      7,
    )
    expect(io.moveNoteIndexed).toHaveBeenCalledWith(PATH, 'notes/new-title.md', 7)
  })

  it('applies a prepared path-link rewrite through an open source buffer', async () => {
    const sourcePath = 'Projects/source.md'
    const before = '[Subject](../notes/subject.md)\n'
    const after = '[Subject](../notes/new-title.md)\n'
    const session = fakeSession(before, sourcePath)
    const unregister = registerOpenDocument({ session })
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.listFiles.mockResolvedValue([
      { path: PATH, size: 1, modifiedMs: 1 },
      { path: sourcePath, size: 1, modifiedMs: 1 },
    ])
    io.prepareNoteMoveRewrites.mockImplementationOnce(
      async (options: PrepareNoteMoveRewritesOptions) => ({
        failed: [],
        rewrites: [{ path: sourcePath, before: await options.read(sourcePath), after }],
      }),
    )
    io.readNote.mockImplementation(async (path: string) =>
      path === sourcePath ? 'stale disk bytes\n' : managed('# New Title\n'),
    )
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')

      expect(session.commitExactContentReplacement).toHaveBeenCalledWith(before, after)
      expect(session.content()).toBe(after)
      expect(io.readNote).not.toHaveBeenCalledWith(sourcePath, 7)
      expect(io.writeNote).not.toHaveBeenCalledWith(sourcePath, after, 7)
      expect(io.moveNoteIndexed).toHaveBeenCalledWith(PATH, 'notes/new-title.md', 7)
    } finally {
      unregister()
    }
  })

  it('refuses the move when an open path-link source no longer matches', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sourcePath = 'Projects/source.md'
    const before = '[Subject](../notes/subject.md)\n'
    const session = fakeSession('Unsaved edit\n', sourcePath)
    const unregister = registerOpenDocument({ session })
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.prepareNoteMoveRewrites.mockResolvedValue({
      failed: [],
      rewrites: [
        { path: sourcePath, before, after: '[Subject](../notes/new-title.md)\n' },
      ],
    })
    io.readNote.mockResolvedValue(managed('# New Title\n'))
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')

      expect(session.content()).toBe('Unsaved edit\n')
      expect(io.writeNote).not.toHaveBeenCalledWith(
        sourcePath,
        expect.any(String),
        expect.any(Number),
      )
      expect(io.moveNoteIndexed).not.toHaveBeenCalled()
      expect(operationLog.records[0]!.outcome).toBe('failed')
      expect(operationLog.records[0]!.message).toContain('changed before rewrite')
    } finally {
      unregister()
    }
  })

  it('keeps a managed note self-link rewritten in its retargeted open session', async () => {
    const before = managed('# New Title\n\n[[notes/subject]]\n')
    const after = managed('# New Title\n\n[[notes/new-title]]\n')
    const session = fakeSession(before)
    const unregister = registerOpenDocument({ session })
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.prepareNoteMoveRewrites.mockResolvedValue({
      failed: [],
      rewrites: [{ path: PATH, before, after }],
    })
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')

      expect(session.content()).toBe(after)
      expect(session.path).toBe('notes/new-title.md')
      expect(openSession('notes/new-title.md')).toBe(session)
      expect(io.writeNote).not.toHaveBeenCalledWith(PATH, after, 7)
    } finally {
      unregister()
    }
  })

  it('a birth (first authored title) moves the file without rewrite or alias', async () => {
    io.slugPathForTitle.mockResolvedValue('notes/fresh-note.md')
    const coordinator = makeCoordinator()
    coordinator.content('', 'load') // untitled lazy note
    coordinator.content(managed('# Fresh Note\n'), 'saved')
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

  it('restores prepared path-link writes when the file move fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.prepareNoteMoveRewrites.mockResolvedValue({
      failed: [],
      rewrites: [
        {
          path: 'Projects/source.md',
          before: '[Subject](../notes/subject.md)\n',
          after: '[Subject](../notes/new-title.md)\n',
        },
      ],
    })
    let source = '[Subject](../notes/subject.md)\n'
    io.readNote.mockImplementation(async (path: string) =>
      path === 'Projects/source.md' ? source : '# New Title\n',
    )
    io.writeNote.mockImplementation(async (path: string, content: string) => {
      if (path === 'Projects/source.md') {
        source = content
      }
    })
    io.moveNoteIndexed.mockRejectedValue(new Error('disk full'))

    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    const sourceWrites = io.writeNote.mock.calls.filter(([path]) => path === 'Projects/source.md')
    expect(sourceWrites).toEqual([
      ['Projects/source.md', '[Subject](../notes/new-title.md)\n', 7],
      ['Projects/source.md', '[Subject](../notes/subject.md)\n', 7],
    ])
    expect(operationLog.records[0]!.outcome).toBe('failed')
  })

  it('rolls back a prepared rewrite through the still-open source session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sourcePath = 'Projects/source.md'
    const before = '[Subject](../notes/subject.md)\n'
    const after = '[Subject](../notes/new-title.md)\n'
    const session = fakeSession(before, sourcePath)
    const unregister = registerOpenDocument({ session })
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.prepareNoteMoveRewrites.mockResolvedValue({
      failed: [],
      rewrites: [{ path: sourcePath, before, after }],
    })
    io.readNote.mockResolvedValue(managed('# New Title\n'))
    io.moveNoteIndexed.mockRejectedValue(new Error('disk full'))
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')

      expect(session.commitExactContentReplacement).toHaveBeenNthCalledWith(1, before, after)
      expect(session.commitExactContentReplacement).toHaveBeenNthCalledWith(2, after, before)
      expect(session.content()).toBe(before)
      expect(io.writeNote).not.toHaveBeenCalledWith(
        sourcePath,
        expect.any(String),
        expect.any(Number),
      )
      expect(operationLog.records[0]!.outcome).toBe('failed')
    } finally {
      unregister()
    }
  })

  it('does not roll back over a changed open source session', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sourcePath = 'Projects/source.md'
    const before = '[Subject](../notes/subject.md)\n'
    const after = '[Subject](../notes/new-title.md)\n'
    const session = fakeSession(before, sourcePath)
    const unregister = registerOpenDocument({ session })
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.prepareNoteMoveRewrites.mockResolvedValue({
      failed: [],
      rewrites: [{ path: sourcePath, before, after }],
    })
    io.readNote.mockResolvedValue(managed('# New Title\n'))
    io.moveNoteIndexed.mockImplementation(async () => {
      session.setContent('Concurrent user edit\n')
      throw new Error('disk full')
    })
    try {
      const coordinator = makeCoordinator()
      await renameOnce(coordinator, 'Old Title', 'New Title')

      expect(session.commitExactContentReplacement).toHaveBeenNthCalledWith(1, before, after)
      expect(session.commitExactContentReplacement).toHaveBeenNthCalledWith(2, after, before)
      expect(session.content()).toBe('Concurrent user edit\n')
      expect(io.writeNote).not.toHaveBeenCalledWith(
        sourcePath,
        expect.any(String),
        expect.any(Number),
      )
      expect(operationLog.records[0]!.message).toContain('failed to restore links')
    } finally {
      unregister()
    }
  })

  it('does not overwrite a path-link source edited after preparation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.prepareNoteMoveRewrites.mockResolvedValue({
      failed: [],
      rewrites: [
        {
          path: 'Projects/source.md',
          before: '[Subject](../notes/subject.md)\n',
          after: '[Subject](../notes/new-title.md)\n',
        },
      ],
    })
    io.readNote.mockImplementation(async (path: string) =>
      path === 'Projects/source.md' ? 'Concurrent external edit\n' : '# New Title\n',
    )

    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(io.writeNote).not.toHaveBeenCalledWith(
      'Projects/source.md',
      expect.any(String),
      expect.any(Number),
    )
    expect(io.moveNoteIndexed).not.toHaveBeenCalled()
    expect(operationLog.records[0]!.outcome).toBe('failed')
    expect(operationLog.records[0]!.message).toContain('changed before rewrite')
  })

  it('does not roll back over an external edit after a prepared rewrite', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    io.slugPathForTitle.mockResolvedValue('notes/new-title.md')
    io.prepareNoteMoveRewrites.mockResolvedValue({
      failed: [],
      rewrites: [
        {
          path: 'Projects/source.md',
          before: '[Subject](../notes/subject.md)\n',
          after: '[Subject](../notes/new-title.md)\n',
        },
      ],
    })
    let sourceReads = 0
    io.readNote.mockImplementation(async (path: string) => {
      if (path !== 'Projects/source.md') {
        return '# New Title\n'
      }
      sourceReads += 1
      return sourceReads === 1
        ? '[Subject](../notes/subject.md)\n'
        : 'Concurrent external edit\n'
    })
    io.moveNoteIndexed.mockRejectedValue(new Error('disk full'))

    const coordinator = makeCoordinator()
    await renameOnce(coordinator, 'Old Title', 'New Title')

    const sourceWrites = io.writeNote.mock.calls.filter(([path]) => path === 'Projects/source.md')
    expect(sourceWrites).toEqual([
      ['Projects/source.md', '[Subject](../notes/new-title.md)\n', 7],
    ])
    expect(operationLog.records[0]!.outcome).toBe('failed')
    expect(operationLog.records[0]!.message).toContain('failed to restore links')
  })

  it('the rewrite collision guard does not block the move (filename follows the NEW title)', async () => {
    io.rewriteLinksForTitleChange.mockResolvedValue({ rewritten: [], failed: [], collision: true })
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
    coordinator.content(managed('# C\n'), 'saved')
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
    coordinator.content(managed('# C\n'), 'saved')
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

  it('keeps an adopted direct note content-only when its title changes', async () => {
    const coordinator = makeCoordinator()
    coordinator.content('# Old Title\n', 'load')
    coordinator.content('# New Title\n', 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(io.rewriteLinksForTitleChange).not.toHaveBeenCalled()
    expect(io.slugPathForTitle).not.toHaveBeenCalled()
    expect(io.moveNoteIndexed).not.toHaveBeenCalled()
    expect(io.writeNote).not.toHaveBeenCalled()
    expect(operationLog.records).toEqual([])
  })

  it('keeps a valid-id note outside direct notes/ content-only', async () => {
    const coordinator = createRenameCoordinator({
      path: 'Projects/subject.md',
      generation: () => 7,
      canFire: () => true,
    })
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(managed('# New Title\n'), 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(io.rewriteLinksForTitleChange).not.toHaveBeenCalled()
    expect(io.moveNoteIndexed).not.toHaveBeenCalled()
    expect(operationLog.records).toEqual([])
  })

  it('cancels pending managed automation when a healed move adopts the note elsewhere', async () => {
    const coordinator = makeCoordinator()
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(managed('# New Title\n'), 'saved')

    coordinator.retarget('Projects/subject.md')
    coordinator.settle()
    await coordinator.settled()

    expect(io.rewriteLinksForTitleChange).not.toHaveBeenCalled()
    expect(io.slugPathForTitle).not.toHaveBeenCalled()
    expect(operationLog.records).toEqual([])
  })

  it('can opt a valid-id adopted note into automation after a healed move into direct notes', async () => {
    const coordinator = createRenameCoordinator({
      path: 'Projects/subject.md',
      generation: () => 7,
      canFire: () => true,
    })
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.retarget(PATH)
    coordinator.content(managed('# New Title\n'), 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(io.rewriteLinksForTitleChange).toHaveBeenCalledOnce()
    expect(io.rewriteLinksForTitleChange.mock.calls[0]![0]).toMatchObject({
      path: PATH,
      from: 'Old Title',
      to: 'New Title',
    })
  })
})
