import { describe, expect, it, vi } from 'vitest'
import { createBacklinkService } from '../indexing/backlink-service.ts'
import { createNotePathService } from '../indexing/note-path-service.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createNodeTestDatabaseService, seedNotes } from '../testing/database.ts'
import {
  createTestNoteMoveService,
  createTestNoteSession,
  type TestNoteSession,
} from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestGraphSessionService, type TestOpenGraph } from '../testing/graph-session.ts'
import { createTestNoteFileService, overrideNoteFileService } from '../testing/graph.ts'
import { createTestIndexStoreService } from '../testing/index-store.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestProgressPort } from '../testing/ports.ts'
import { createOpenDocumentsService } from './open-documents-service.ts'
import { createTitleRenameService, type RenameCoordinator } from './title-rename-service.ts'

/**
 * The rename coordinator owns the riskiest background work in the app: a
 * settled title change fans out into a graph-wide link rewrite plus an alias
 * placement, serialized, generation-checked, and reported through the
 * operations store. These tests drive a coordinator directly through its
 * `content`/`settle` surface (the same calls the document hook makes) over an
 * in-memory graph: fake note files, a real index database, and the real
 * index reads, move service and operations store on top of them.
 */

/**
 * A managed note that already sits on the slug of "New Title": renaming to it moves nothing.
 */
const PATH = 'notes/new-title.md'
/**
 * A managed note still on its placeholder name: a settled title moves it.
 */
const PLACEHOLDER = 'notes/01abc.md'
const LINKER = 'notes/linker.md'
const MANAGED_ID = '01hv3xq7c2dm8k4t9w5e6r1n98'

function managed(content: string): string {
  return upsertFrontmatter(content, { id: MANAGED_ID })
}

interface RecordedOperation {
  label: string
  outcome: 'running' | 'done' | 'failed'
  message: string | null
}

interface SetupOptions {
  /**
   * The note the coordinator tracks. Defaults to {@link PATH}.
   */
  path?: string
  /**
   * The files on disk, by graph-relative path.
   */
  files?: Record<string, string>
  /**
   * What the index holds where it lags the disk; other files are indexed as they are.
   */
  indexed?: Record<string, string>
  /**
   * An open session for the tracked note, with this buffer.
   */
  session?: { content: string; accepts?: boolean }
  /**
   * The graph open when the coordinator is created; defaults to generation 7, `null` for none.
   */
  graph?: TestOpenGraph | null
  /**
   * Make every title resolution reject, so the link rewrite fails.
   */
  resolveError?: Error
  /**
   * Make every inbound path link query reject, so the path link pass after a move fails.
   */
  pathLinkError?: Error
  /**
   * Make reading the tracked note from disk reject, so a disk alias placement fails.
   */
  readError?: Error
  /**
   * Make the file move reject.
   */
  moveError?: Error
}

function setup(options?: SetupOptions) {
  const path = options?.path ?? PATH
  const files = options?.files ?? {}
  const clock = createTestClockService()
  const progress = createTestProgressPort()
  const logger = createTestLoggerService()
  const noteFile = createTestNoteFileService({ files })
  const database = createNodeTestDatabaseService()
  seedNotes(
    database,
    Object.entries({ ...files, ...options?.indexed }).map(([notePath, markdown]) => ({
      path: notePath,
      markdown,
    })),
  )
  const session: TestNoteSession | null =
    options?.session === undefined
      ? null
      : createTestNoteSession({
          path,
          content: options.session.content,
          accepts: options.session.accepts ?? true,
        })
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  if (session !== null) {
    openDocuments.register({ session })
  }
  const indexStore = createTestIndexStoreService({
    database,
    fail: (call) => (call.method === 'moveIndexed' ? options?.moveError : undefined),
  })
  const moveIndexed = indexStore.moveIndexed.bind(indexStore)
  // The native command moves the file along with its rows.
  vi.spyOn(indexStore, 'moveIndexed').mockImplementation(async (from, to, fileGeneration) => {
    await moveIndexed(from, to, fileGeneration)
    const contents = noteFile.files().get(from)
    if (contents !== undefined) {
      noteFile.set(to, contents)
      await noteFile.delete(from, fileGeneration)
    }
  })
  const noteMove = createTestNoteMoveService({
    indexStore,
    openDocuments,
    logger,
  })
  const wikiResolver = createWikiResolverService({ database })
  if (options?.resolveError !== undefined) {
    vi.spyOn(wikiResolver, 'resolveWikiTarget').mockRejectedValue(options.resolveError)
  }
  if (options?.pathLinkError !== undefined) {
    vi.spyOn(wikiResolver, 'getPathLinkSources').mockRejectedValue(options.pathLinkError)
  }
  const readError = options?.readError
  const graph = createTestGraphSessionService(
    options?.graph === null ? {} : { graph: options?.graph ?? { generation: 7 } },
  )
  const titleRename = createTitleRenameService({
    noteFile:
      readError === undefined
        ? noteFile
        : overrideNoteFileService(noteFile, {
            read: async (forPath, generation) => {
              if (forPath === path) {
                throw readError
              }
              return await noteFile.read(forPath, generation)
            },
          }),
    wikiResolver,
    backlinks: createBacklinkService({
      database,
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    }),
    notePath: createNotePathService({ database, noteFile }),
    noteMove,
    openDocuments,
    progress,
    clock,
    logger,
    graphSession: graph,
  })
  const coordinator = titleRename.createCoordinator({ path })

  /**
   * The operations started so far, each with its outcome.
   */
  function operationOutcomes(): Promise<RecordedOperation[]> {
    return Promise.resolve(
      progress.started().map(({ label, status, message, ended }) => ({
        label,
        outcome: status === 'failed' ? 'failed' : ended ? 'done' : 'running',
        message,
      })),
    )
  }

  return {
    coordinator,
    graph,
    clock,
    progress,
    logger,
    noteFile,
    indexStore,
    noteMove,
    openDocuments,
    session,
    operationOutcomes,
    /**
     * The labels of the operations started so far.
     */
    started: () => progress.started().map((operation) => operation.label),
  }
}

/**
 * Drive one settled rename: baseline at `from`, save `to`, settle, await.
 */
async function renameOnce(coordinator: RenameCoordinator, from: string, to: string): Promise<void> {
  coordinator.content(managed(`# ${from}\n`), 'load')
  coordinator.content(managed(`# ${to}\n`), 'saved')
  coordinator.settle()
  await coordinator.settled()
}

describe('rename coordinator', () => {
  it('rewrites links with the generation read at run time, then writes the alias to disk', async () => {
    const content = managed('# New Title\n')
    const { coordinator, graph, noteFile, operationOutcomes } = setup({
      files: { [PATH]: content, [LINKER]: 'see [[Old Title]]\n' },
      graph: { generation: 3 },
    })
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(content, 'saved')
    // The same graph reopens between save and settle: the rewrite must see 4.
    graph.setGraph({ generation: 4 })
    coordinator.settle()
    await coordinator.settled()

    // No live session → the alias lands via a direct disk write.
    expect(noteFile.writes()).toEqual([
      { path: LINKER, contents: 'see [[New Title]]\n', generation: 4 },
      {
        path: PATH,
        contents: upsertFrontmatter(content, { aliases: ['Old Title'] }),
        generation: 4,
      },
    ])
    expect(await operationOutcomes()).toEqual([
      { label: 'Renaming "Old Title" → "New Title"', outcome: 'done', message: null },
    ])
  })

  it('writes with its own graph generation after another graph opened', async () => {
    const content = managed('# New Title\n')
    const { coordinator, graph, noteFile } = setup({
      files: { [PATH]: content, [LINKER]: 'see [[Old Title]]\n' },
      graph: { generation: 3 },
    })
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(content, 'saved')
    graph.setGraph({ root: '/graphs/other', generation: 4 })
    coordinator.settle()
    await coordinator.settled()

    expect(noteFile.writes().map((write) => write.generation)).toEqual([3, 3])
  })

  it('fires a saved title after the quiet period without a settle point', async () => {
    const content = managed('# New Title\n')
    const { coordinator, clock, noteFile, started } = setup({ files: { [PATH]: content } })
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(content, 'saved')

    await clock.advance(4999)
    expect(started()).toEqual([])

    await clock.advance(1)
    await coordinator.settled()
    expect(noteFile.getWrites(PATH)).toEqual([
      upsertFrontmatter(content, { aliases: ['Old Title'] }),
    ])
  })

  it('routes the alias through a live session instead of the disk', async () => {
    const { coordinator, noteFile, session, operationOutcomes } = setup({
      session: { content: '# New Title\n' },
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(session!.getCalls('updateFrontmatter')).toEqual([[{ aliases: ['Old Title'] }]])
    expect(session!.getCalls('flush')).toHaveLength(1)
    expect(noteFile.writes()).toEqual([])
    expect((await operationOutcomes())[0]!.outcome).toBe('done')
  })

  it('falls back to the disk write when the session cannot take the patch', async () => {
    const { coordinator, noteFile, session } = setup({
      files: { [PATH]: '# New Title\n' },
      session: { content: '# New Title\n', accepts: false }, // loading/protected/disposed
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(session!.getCalls('flush')).toHaveLength(0)
    expect(noteFile.writes()).toEqual([
      {
        path: PATH,
        contents: upsertFrontmatter('# New Title\n', { aliases: ['Old Title'] }),
        generation: 7,
      },
    ])
  })

  it('a collision rewrites nothing onto the note: no alias write, operation done', async () => {
    const { coordinator, noteFile, operationOutcomes } = setup({
      files: {
        [PATH]: managed('# New Title\n'),
        [LINKER]: 'see [[Old Title]]\n',
        // Another note owns the old title now: its links are deliberate.
        'notes/other.md': '# Old Title\n',
      },
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(noteFile.writes()).toEqual([])
    expect((await operationOutcomes())[0]!.outcome).toBe('done')
  })

  it('a blocked destination skips the rewrite but still places the old-title alias', async () => {
    // The new title's derived target belongs to another note (or cannot be
    // serialized): sources keep their old links, so the old-title alias is
    // the only thing keeping them resolving to this note. Unlike a source
    // collision, it MUST be placed.
    const { coordinator, noteFile, operationOutcomes } = setup({
      files: {
        [PATH]: '# New Title\n',
        [LINKER]: 'see [[Old Title]]\n',
        'notes/other.md': '# New Title\n',
      },
      // The watcher has not reprojected the renamed note yet.
      indexed: { [PATH]: '# Old Title\n' },
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(noteFile.writes()).toEqual([
      {
        path: PATH,
        contents: upsertFrontmatter('# New Title\n', { aliases: ['Old Title'] }),
        generation: 7,
      },
    ])
    expect((await operationOutcomes())[0]!.outcome).toBe('done')
  })

  it('a failed rewrite still places the alias (the safety net) and says so', async () => {
    const failure = new Error('index unavailable')
    const { coordinator, noteFile, logger, operationOutcomes } = setup({
      files: { [PATH]: '# New Title\n' },
      resolveError: failure,
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(noteFile.writes()).toEqual([
      {
        path: PATH,
        contents: upsertFrontmatter('# New Title\n', { aliases: ['Old Title'] }),
        generation: 7,
      },
    ])
    const records = await operationOutcomes()
    expect(records[0]!.outcome).toBe('failed')
    expect(records[0]!.message).toContain('index unavailable')
    expect(records[0]!.message).toContain('kept as an alias')
    expect(logger.getErrors()).toEqual([{ message: 'rename link rewrite failed:', cause: failure }])
  })

  it('a failed alias after a clean rewrite reports exactly that', async () => {
    const failure = new Error('read denied')
    const { coordinator, logger, operationOutcomes } = setup({
      files: { [PATH]: '# New Title\n' },
      readError: failure,
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    const records = await operationOutcomes()
    expect(records[0]!.outcome).toBe('failed')
    expect(records[0]!.message).toContain('links were rewritten')
    expect(records[0]!.message).toContain('read denied')
    expect(logger.getErrors()).toEqual([
      { message: 'rename alias placement failed:', cause: failure },
    ])
  })

  it('both phases failing reports both, flagging links that may not resolve', async () => {
    const { coordinator, logger, operationOutcomes } = setup({
      files: { [PATH]: '# New Title\n' },
      resolveError: new Error('index unavailable'),
      readError: new Error('read denied'),
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    const { message } = (await operationOutcomes())[0]!
    expect(message).toContain('index unavailable')
    expect(message).toContain('read denied')
    expect(message).toContain('may no longer resolve')
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'rename link rewrite failed:',
      'rename alias placement failed:',
    ])
  })

  it('drops the rename loudly when no graph generation is available', async () => {
    const { coordinator, noteFile, logger, operationOutcomes } = setup({
      files: { [PATH]: managed('# New Title\n'), [LINKER]: 'see [[Old Title]]\n' },
      graph: null,
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(noteFile.writes()).toEqual([])
    expect(await operationOutcomes()).toEqual([]) // nothing to show: no work started
    expect(logger.getErrors()).toEqual([
      {
        message: `rename dropped (no graph generation): "Old Title" → "New Title" on ${PATH}`,
        cause: undefined,
      },
    ])
  })

  it('external content re-baselines: no rewrite for titles the user did not author', async () => {
    const { coordinator, noteFile, started } = setup({
      files: { [PATH]: managed('# Synced Title\n'), [LINKER]: 'see [[Old Title]]\n' },
    })
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(managed('# Synced Title\n'), 'external') // another device renamed it
    coordinator.settle()
    await coordinator.settled()

    expect(started()).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })

  it('moves the file onto the new slug: flush, retarget, registry re-key, then the move', async () => {
    const { coordinator, session, indexStore, noteMove, openDocuments, operationOutcomes } = setup({
      path: PLACEHOLDER,
      session: { content: '# New Title\n' },
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(session!.getCalls('flush').length).toBeGreaterThan(0)
    expect(session!.getCalls('retarget')).toEqual([['notes/new-title.md']])
    expect(indexStore.calls()).toEqual([
      { method: 'moveIndexed', from: PLACEHOLDER, to: 'notes/new-title.md', fileGeneration: 7 },
    ])
    // The registry follows: lookups under the new path find the live session.
    expect(openDocuments.sessionFor('notes/new-title.md')).toBe(session)
    expect(openDocuments.sessionFor(PLACEHOLDER)).toBeNull()
    expect(noteMove.moved()).toEqual([[PLACEHOLDER, 'notes/new-title.md']])
    expect((await operationOutcomes())[0]!.outcome).toBe('done')
  })

  it('a failed path link pass after the move is logged and the rename still completes', async () => {
    const failure = new Error('index unavailable')
    const { coordinator, logger, indexStore, operationOutcomes } = setup({
      path: PLACEHOLDER,
      files: { [PLACEHOLDER]: managed('# New Title\n'), [LINKER]: 'see [[notes/01abc]]\n' },
      pathLinkError: failure,
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(indexStore.moved()).toEqual([{ from: PLACEHOLDER, to: 'notes/new-title.md' }])
    expect(logger.getErrors()).toEqual([{ message: 'path link rewrite failed:', cause: failure }])
    expect((await operationOutcomes())[0]!.outcome).toBe('done')
  })

  it('repoints inbound path links after the move lands', async () => {
    const { coordinator, noteFile } = setup({
      path: PLACEHOLDER,
      files: {
        [PLACEHOLDER]: managed('# New Title\n'),
        [LINKER]: 'see [[notes/01abc]]\n',
      },
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(noteFile.getWrites(LINKER)).toEqual(['see [[notes/new-title]]\n'])
  })

  it('a birth (first authored title) moves the file without rewrite or alias', async () => {
    const { coordinator, noteFile, indexStore, operationOutcomes } = setup({
      path: PLACEHOLDER,
      files: { [PLACEHOLDER]: managed('# Fresh Note\n') },
    })
    coordinator.content('', 'load') // untitled lazy note
    coordinator.content(managed('# Fresh Note\n'), 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(noteFile.writes()).toEqual([]) // no alias for a birth
    expect(indexStore.moved()).toEqual([{ from: PLACEHOLDER, to: 'notes/fresh-note.md' }])
    expect(await operationOutcomes()).toEqual([
      { label: 'Naming "Fresh Note"', outcome: 'done', message: null },
    ])
  })

  it('a failed birth move reports the placeholder filename', async () => {
    const failure = new Error('disk full')
    const { coordinator, logger, operationOutcomes } = setup({
      path: PLACEHOLDER,
      files: { [PLACEHOLDER]: managed('# Fresh Note\n') },
      moveError: failure,
    })
    coordinator.content('', 'load')
    coordinator.content(managed('# Fresh Note\n'), 'saved')
    coordinator.settle()
    await coordinator.settled()

    const records = await operationOutcomes()
    expect(records[0]!.outcome).toBe('failed')
    expect(records[0]!.message).toContain('disk full')
    expect(records[0]!.message).toContain('keeps its placeholder filename')
    expect(logger.getErrors()).toEqual([{ message: 'note file move failed:', cause: failure }])
  })

  it('a failed move retargets the session back and reports filename drift', async () => {
    const failure = new Error('disk full')
    const { coordinator, session, openDocuments, logger, operationOutcomes } = setup({
      path: PLACEHOLDER,
      session: { content: '# New Title\n' },
      moveError: failure,
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    // Retargeted out and back: the session ends bound to its original path.
    expect(session!.getCalls('retarget')).toEqual([['notes/new-title.md'], [PLACEHOLDER]])
    expect(openDocuments.sessionFor(PLACEHOLDER)).toBe(session)
    const records = await operationOutcomes()
    expect(records[0]!.outcome).toBe('failed')
    expect(records[0]!.message).toContain('keeps its old name')
    expect(records[0]!.message).toContain('disk full')
    expect(logger.getErrors()).toEqual([{ message: 'note file move failed:', cause: failure }])
  })

  it('the rewrite collision guard does not block the move (filename follows the NEW title)', async () => {
    const { coordinator, noteFile, indexStore } = setup({
      path: PLACEHOLDER,
      files: {
        [PLACEHOLDER]: managed('# New Title\n'),
        'notes/other.md': '# Old Title\n',
      },
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(noteFile.writes()).toEqual([]) // collision: no alias claimed
    expect(indexStore.moved()).toEqual([{ from: PLACEHOLDER, to: 'notes/new-title.md' }])
  })

  it('a follow-up rename works against the moved path', async () => {
    const { coordinator, noteFile, indexStore } = setup({
      path: PLACEHOLDER,
      files: { [PLACEHOLDER]: managed('# B\n') },
    })
    await renameOnce(coordinator, 'A', 'B')
    expect(indexStore.moved()).toEqual([{ from: PLACEHOLDER, to: 'notes/b.md' }])

    noteFile.set('notes/b.md', managed('# C\n'))
    coordinator.content(managed('# C\n'), 'saved')
    coordinator.settle()
    await coordinator.settled()

    // Both the alias and the second move key off the note's current path.
    expect(noteFile.getWrites('notes/b.md')).toEqual([
      upsertFrontmatter(managed('# C\n'), { aliases: ['B'] }),
    ])
    expect(indexStore.moved()).toEqual([
      { from: PLACEHOLDER, to: 'notes/b.md' },
      { from: 'notes/b.md', to: 'notes/c.md' },
    ])
  })

  it('chained renames serialize and prune the previous auto-alias', async () => {
    const { coordinator, noteFile, started } = setup({
      path: 'notes/adopted.md',
      files: { 'notes/adopted.md': '# B\n' },
    })
    coordinator.content('# A\n', 'load')
    coordinator.content('# B\n', 'saved')
    coordinator.settle()

    // Second leg, settled while the first still runs: the note on disk will
    // carry A as the auto-added alias by the time it starts.
    coordinator.content('# C\n', 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(started()).toEqual(['Renaming "A" → "B"', 'Renaming "B" → "C"'])
    // A (the intermediate title) is pruned; B (the latest old title) joins.
    expect(noteFile.getWrites('notes/adopted.md')).toEqual([
      upsertFrontmatter('# B\n', { aliases: ['A'] }),
      upsertFrontmatter('# B\n', { aliases: ['B'] }),
    ])
  })

  it('maintains links and aliases for an adopted direct note without moving it', async () => {
    const path = 'notes/subject.md'
    const { coordinator, noteFile, indexStore, operationOutcomes } = setup({
      path,
      files: { [path]: '# New Title\n', [LINKER]: 'see [[Old Title]]\n' },
    })
    coordinator.content('# Old Title\n', 'load')
    coordinator.content('# New Title\n', 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(noteFile.writes()).toEqual([
      { path: LINKER, contents: 'see [[New Title]]\n', generation: 7 },
      {
        path,
        contents: upsertFrontmatter('# New Title\n', { aliases: ['Old Title'] }),
        generation: 7,
      },
    ])
    expect(indexStore.calls()).toEqual([])
    expect(await operationOutcomes()).toEqual([
      { label: 'Renaming "Old Title" → "New Title"', outcome: 'done', message: null },
    ])
  })

  it('maintains links for a valid-id note outside direct notes/ without moving it', async () => {
    const path = 'Projects/subject.md'
    const { coordinator, noteFile, indexStore } = setup({
      path,
      files: { [path]: managed('# New Title\n'), [LINKER]: 'see [[Old Title]]\n' },
    })
    await renameOnce(coordinator, 'Old Title', 'New Title')

    expect(noteFile.getWrites(LINKER)).toEqual(['see [[New Title]]\n'])
    expect(indexStore.calls()).toEqual([])
  })

  it('preserves a capture stable alias and path while maintaining its title links', async () => {
    const base = 'capture-2026-07-23-154848-811-c2b0'
    const path = `notes/${base}.md`
    const oldSource = upsertFrontmatter('# Old Title\n', { aliases: [base] })
    const newSource = upsertFrontmatter('# New Title\n', { aliases: [base] })
    const { coordinator, noteFile, indexStore } = setup({
      path,
      files: { [path]: newSource, [LINKER]: 'see [[Old Title]]\n' },
    })
    coordinator.content(oldSource, 'load')
    coordinator.content(newSource, 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(noteFile.writes()).toEqual([
      { path: LINKER, contents: 'see [[New Title]]\n', generation: 7 },
      {
        path,
        contents: upsertFrontmatter(newSource, { aliases: [base, 'Old Title'] }),
        generation: 7,
      },
    ])
    expect(indexStore.calls()).toEqual([])
  })

  it('treats a first title on an adopted note as a no-op birth', async () => {
    const { coordinator, noteFile, indexStore, operationOutcomes } = setup({
      path: PLACEHOLDER,
      files: { [PLACEHOLDER]: '# Fresh Note\n' },
    })
    coordinator.content('', 'load')
    coordinator.content('# Fresh Note\n', 'saved')
    coordinator.settle()
    await coordinator.settled()

    expect(noteFile.writes()).toEqual([])
    expect(indexStore.calls()).toEqual([])
    expect(await operationOutcomes()).toEqual([])
  })

  it('does nothing after dispose', async () => {
    const { coordinator, clock, started } = setup({ files: { [PATH]: managed('# New Title\n') } })
    coordinator.content(managed('# Old Title\n'), 'load')
    coordinator.content(managed('# New Title\n'), 'saved')
    coordinator.dispose()
    coordinator.settle()
    await clock.advance(10_000)
    await coordinator.settled()

    expect(started()).toEqual([])
  })
})
