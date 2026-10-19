import type { RoundTripFidelity } from '@meowdown/markdown'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTaskEdits, projectTasks, TaskStaleError } from '../markdown/task-ast.ts'
import type { TaskLocator } from '../markdown/task-model.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createTestNoteFileService, overrideNoteFileService } from '../testing/graph.ts'
import {
  createTestGraphSessionService,
  type TestGraphSessionService,
} from '../testing/graph-session.ts'
import { createTestLoggerService, type TestLoggerService } from '../testing/logger.ts'
import {
  createNoteSessionService,
  type NoteSession,
  type NoteSessionSnapshot,
} from './note-session-service.ts'
import { createTitleRenameTracker, type TitleRename } from './title-rename-tracker.ts'

/** The first task's locator as the index records it. */
function firstTask(source: string): TaskLocator {
  const [task] = projectTasks(source)
  return { astPath: task!.astPath, markdown: task!.markdown, checked: task!.checked }
}

/** The Tasks view's open-note write: toggle `task` through the live buffer. */
function toggleTransform(task: TaskLocator): (source: string) => string {
  return (source) => applyTaskEdits({ logger }, source, [{ kind: 'toggle', task }]).source
}

/**
 * Direct tests of the document state machine, no React. The desktop hook test
 * in `use-note-document.test.tsx` covers only how the hook binds a session to
 * the editor.
 */

const PATH = 'notes/a.md'

let clock: TestClockService
let logger: TestLoggerService

beforeEach(() => {
  clock = createTestClockService()
  logger = createTestLoggerService()
})

interface Harness {
  snapshots: NoteSessionSnapshot[]
  expectedContents: (string | null | undefined)[]
  writes: Array<{ path: string; contents: string }>
  applied: string[]
  contents: Array<{ content: string; origin: string }>
  /**
   * `null` deletes the file: subsequent reads reject with `notFound`.
   */
  setDisk: (contents: string | null) => void
  /** While set, writes reject with this message (the save-failure seam). */
  failWrites: (message: string | null) => void
  /**
   * The next write merges with the disk and returns `content` as merged (the merge-on-write seam).
   */
  mergeNextWrite: (content: string) => void
  /**
   * The note's bytes on disk, `undefined` when missing.
   */
  disk: () => string | undefined
  session: NoteSession
  /**
   * The graph open when the session was created.
   */
  graph: TestGraphSessionService<never>
  /**
   * The generation of every write, in order.
   */
  generations: () => number[]
}

function harness(options?: {
  /** Runs before every read resolves (the slow-load seam). */
  beforeRead?: () => Promise<void>
  beforeWrite?: () => Promise<void>
  /**
   * Runs after the file holds the new bytes and before the write resolves (the watcher-races-the-promise seam).
   */
  afterWrite?: () => Promise<void>
  write?: false
  classify?: (markdown: string) => RoundTripFidelity
  /**
   * `null` simulates a missing file: reads reject with `notFound`.
   */
  disk?: string | null
  createIfMissing?: boolean
  missingSeed?: string
  reconcilePendingEditorInput?: () => void
  /**
   * Runs inside `applyContent`, the way an editor reports its serialization while it loads content.
   */
  onApply?: (markdown: string) => void
}): Harness {
  const snapshots: NoteSessionSnapshot[] = []
  const expectedContents: (string | null | undefined)[] = []
  const writes: Array<{ path: string; contents: string }> = []
  const applied: string[] = []
  const contents: Array<{ content: string; origin: string }> = []
  const disk = options?.disk === undefined ? '# Hello\n' : options.disk
  let writeFailure: string | null = null
  // One file, whatever path the session asks for: a retargeted session finds
  // its document at the new path, as it does after a real file move.
  const files = createTestNoteFileService(disk === null ? {} : { files: { [PATH]: disk } })
  const noteFile = overrideNoteFileService(files, {
    read: async (_path, generation) => {
      await options?.beforeRead?.()
      return await files.read(PATH, generation)
    },
    write: async (path, contents, generation, expected) => {
      expectedContents.push(expected)
      await options?.beforeWrite?.()
      if (writeFailure !== null) {
        throw new Error(writeFailure)
      }
      const result = await files.write(PATH, contents, generation, expected)
      writes.push({ path, contents })
      await options?.afterWrite?.()
      return result
    },
  })
  const graph = createTestGraphSessionService({ graph: { generation: 1 } })
  const session = createNoteSessionService({
    noteFile,
    clock,
    logger,
    graphSession: graph,
  }).create({
    path: PATH,
    readOnly: options?.write === false,
    classify: options?.classify ?? (() => 'exact'),
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot)
    },
    applyContent: (markdown) => {
      applied.push(markdown)
      options?.onApply?.(markdown)
    },
    reconcilePendingEditorInput: options?.reconcilePendingEditorInput,
    onContent: (content, origin) => {
      contents.push({ content, origin })
    },
    createIfMissing: options?.createIfMissing,
    missingSeed: options?.missingSeed,
    saveDebounceMs: 10,
  })
  return {
    snapshots,
    expectedContents,
    writes,
    applied,
    contents,
    setDisk: (next) => {
      if (next === null) {
        void files.delete(PATH, 1)
      } else {
        files.set(PATH, next)
      }
    },
    failWrites: (message) => {
      writeFailure = message
    },
    mergeNextWrite: (content) => {
      files.mergeNextWrite(PATH, content)
    },
    disk: () => files.files().get(PATH),
    session,
    graph,
    generations: () => files.writes().map((write) => write.generation),
  }
}

async function settled(): Promise<void> {
  await clock.advance(50)
}

describe('createNoteSession', () => {
  it('tracks dirtiness but never writes without a write capability', async () => {
    const { session, writes, snapshots } = harness({ write: false })
    session.load()
    await settled()

    session.editorChanged('# Edited\n')
    await session.flush()
    await settled()

    expect(writes).toEqual([])
    expect(snapshots.at(-1)?.dirty).toBe(true) // edits are not silently "clean"
  })

  it('dispose flushes the pending edit but emits no further snapshots', async () => {
    const { session, writes, snapshots } = harness()
    session.load()
    await settled()

    session.editorChanged('# Final\n')
    const emittedBeforeDispose = snapshots.length
    session.dispose()
    await settled()

    expect(writes).toEqual([{ path: 'notes/a.md', contents: '# Final\n' }])
    expect(snapshots.length).toBe(emittedBeforeDispose)
  })

  it('reconciles pending editor input before a flush snapshots the buffer', async () => {
    let target: NoteSession | null = null
    const reconcilePendingEditorInput = vi.fn(() => {
      target?.editorChanged('# 🧠 Business ideas\n')
    })
    const { session, writes } = harness({ reconcilePendingEditorInput })
    target = session
    session.load()
    await settled()

    session.editorChanged('# Business ideas\n')
    await session.flush()

    expect(reconcilePendingEditorInput).toHaveBeenCalledOnce()
    expect(writes).toEqual([{ path: 'notes/a.md', contents: '# 🧠 Business ideas\n' }])
  })

  it('discard detaches without writing — even with a pending edit (delete path)', async () => {
    const { session, writes } = harness()
    session.load()
    await settled()

    session.editorChanged('# Unsaved edit\n')
    session.discard()
    await settled()

    // Nothing written: the file is being deleted, so a flush would recreate it.
    expect(writes).toEqual([])

    // The pane tears down via flush() → dispose() (document-binding); neither
    // may write after a discard, or the trashed file would come back.
    await session.flush()
    session.dispose()
    await settled()
    expect(writes).toEqual([])
  })

  it('resumes a paused pending save when prepared deletion fails', async () => {
    const { session, writes } = harness()
    session.load()
    await settled()

    session.editorChanged('# Unsaved edit\n')
    await expect(session.prepareDelete()).resolves.toBe(false)
    expect(writes).toEqual([])

    session.cancelDelete()
    await settled()
    expect(writes).toEqual([{ path: 'notes/a.md', contents: '# Unsaved edit\n' }])
  })

  it('does not re-emit identical snapshots', async () => {
    const { session, snapshots } = harness()
    session.load()
    await clock.advance(0)

    const afterLoad = snapshots.length
    session.editorChanged('# Same edit\n')
    session.editorChanged('# Same edit\n')
    expect(snapshots.length).toBe(afterLoad + 1) // one dirty transition, not two
  })

  it('an external change equal to the buffer saves cleanly', async () => {
    const { session, writes, snapshots, setDisk } = harness()
    session.load()
    await settled()

    session.editorChanged('# Same on both\n')
    setDisk('# Same on both\n')
    session.externalChanged()
    await settled()
    expect(writes).toEqual([{ path: 'notes/a.md', contents: '# Same on both\n' }])
    expect(snapshots.at(-1)?.dirty).toBe(false)
    expect(snapshots.at(-1)?.error).toBeNull()
  })

  it('re-gates protection when external content stops being representable', async () => {
    const lossyWhenTasks = (markdown: string): RoundTripFidelity => {
      return markdown.includes('+ [ ]') ? 'lossy' : 'exact'
    }
    const { session, snapshots, setDisk } = harness({ classify: lossyWhenTasks })
    session.load()
    await settled()
    expect(snapshots.at(-1)?.protected).toBe(false)

    setDisk('+ [ ] now has tasks\n')
    session.externalChanged()
    await settled()
    expect(snapshots.at(-1)?.protected).toBe(true)
    expect(snapshots.at(-1)?.initialContent).toBe('+ [ ] now has tasks\n')
  })
})

/**
 * Feed a session's content reports to a title-rename tracker and return its renames.
 */
function replayRenames(
  contents: ReadonlyArray<{ content: string; origin: string }>,
): TitleRename[] {
  const renames: TitleRename[] = []
  const tracker = createTitleRenameTracker({
    path: PATH,
    clock,
    onRename: (rename) => {
      renames.push(rename)
    },
  })
  for (const { content, origin } of contents) {
    if (origin === 'saved') {
      tracker.saved(content)
    } else {
      tracker.baseline(content)
    }
  }
  tracker.settle()
  return renames
}

describe('external changes and saves', () => {
  it('ignores an external event whose content matches the disk state (the echo of its own save)', async () => {
    const h = harness()
    h.session.load()
    await settled()

    h.session.externalChanged()
    await settled()

    expect(h.applied).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('a dirty buffer saves at once when an external change arrives', async () => {
    const h = harness()
    h.session.load()
    await settled()

    h.session.editorChanged('# Hello\n\nmine\n')
    h.setDisk('# Hello\n\ntheirs\n')
    h.mergeNextWrite('# Hello\n\nmine\n\ntheirs\n')
    h.session.externalChanged()
    await clock.advance(0) // well inside the save debounce

    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# Hello\n\nmine\n' }])
    expect(h.expectedContents).toEqual(['# Hello\n'])
  })

  it('an exact merge adopts the merged text and the session is clean', async () => {
    const h = harness()
    h.session.load()
    await settled()

    h.session.editorChanged('# Hello\n\nmine\n')
    h.setDisk('# Hello\n\ntheirs\n')
    h.mergeNextWrite('# Hello\n\nmine\n\ntheirs\n')
    h.session.externalChanged()
    await settled()

    expect(h.disk()).toBe('# Hello\n\nmine\n\ntheirs\n')
    expect(h.applied).toEqual(['# Hello\n\nmine\n\ntheirs\n'])
    expect(h.session.content()).toBe('# Hello\n\nmine\n\ntheirs\n')
    expect(h.snapshots.at(-1)).toMatchObject({ dirty: false, protected: false, error: null })

    h.session.editorChanged('# Hello\n\nmine\n\ntheirs\n\nmore\n')
    await settled()
    expect(h.expectedContents.at(-1)).toBe('# Hello\n\nmine\n\ntheirs\n')
    expect(h.disk()).toBe('# Hello\n\nmine\n\ntheirs\n\nmore\n')
  })

  it('a lossy merged result opens protected', async () => {
    const lossyWhenTasks = (markdown: string): RoundTripFidelity => {
      return markdown.includes('+ [ ]') ? 'lossy' : 'exact'
    }
    const h = harness({ classify: lossyWhenTasks })
    h.session.load()
    await settled()

    h.session.editorChanged('# Hello\n\nmine\n')
    h.setDisk('# Hello\n\n+ [ ] theirs\n')
    h.mergeNextWrite('# Hello\n\nmine\n\n+ [ ] theirs\n')
    h.session.externalChanged()
    await settled()

    expect(h.applied).toEqual([])
    expect(h.snapshots.at(-1)).toMatchObject({
      dirty: false,
      protected: true,
      initialContent: '# Hello\n\nmine\n\n+ [ ] theirs\n',
    })
    h.session.editorChanged('# Hello\n\nmine\n')
    await settled()
    expect(h.disk()).toBe('# Hello\n\nmine\n\n+ [ ] theirs\n')
  })

  it('a merged title change is reported as external before saved', async () => {
    const h = harness({ disk: '# Old title\n\nbody\n' })
    h.session.load()
    await settled()

    h.session.editorChanged('# Old title\n\nbody mine\n')
    h.setDisk('# Their title\n\nbody\n')
    h.mergeNextWrite('# Their title\n\nbody mine\n')
    h.session.externalChanged()
    await settled()
    h.session.editorChanged('# Their title\n\nbody mine more\n')
    await settled()

    expect(h.contents).toEqual([
      { content: '# Old title\n\nbody\n', origin: 'load' },
      { content: '# Their title\n\nbody mine\n', origin: 'external' },
      { content: '# Their title\n\nbody mine more\n', origin: 'saved' },
    ])
  })

  it('a title typed by the user survives a merged write and renames the file', async () => {
    const h = harness({ disk: '# Old title\n\nbody\n' })
    h.session.load()
    await settled()

    h.session.editorChanged('# New title\n\nbody\n')
    h.setDisk('# Old title\n\nbody theirs\n')
    h.mergeNextWrite('# New title\n\nbody theirs\n')
    h.session.externalChanged()
    await settled()

    expect(h.contents.at(-1)).toEqual({ content: '# New title\n\nbody theirs\n', origin: 'saved' })
    expect(replayRenames(h.contents)).toEqual([
      { from: 'Old title', to: 'New title', previousAutoAlias: null },
    ])
  })

  it('a body-only merge after a pending rename is reported as saved and keeps the rename', async () => {
    const h = harness({ disk: '# Old title\n\nbody\n' })
    h.session.load()
    await settled()

    h.session.editorChanged('# New title\n\nbody\n')
    await settled()
    h.session.editorChanged('# New title\n\nbody mine\n')
    h.setDisk('# New title\n\nbody theirs\n')
    h.mergeNextWrite('# New title\n\nbody mine theirs\n')
    h.session.externalChanged()
    await settled()

    expect(h.contents.map((c) => c.origin)).toEqual(['load', 'saved', 'saved'])
    expect(replayRenames(h.contents)).toEqual([
      { from: 'Old title', to: 'New title', previousAutoAlias: null },
    ])
  })

  it('a merge that changes the title after a local rename is reported as external', async () => {
    const h = harness({ disk: '# Old title\n\nbody\n' })
    h.session.load()
    await settled()

    h.session.editorChanged('# New title\n\nbody\n')
    await settled()
    h.session.editorChanged('# New title\n\nbody mine\n')
    h.setDisk('# Their title\n\nbody\n')
    h.mergeNextWrite('# Their title\n\nbody mine\n')
    h.session.externalChanged()
    await settled()

    expect(h.contents.map((c) => c.origin)).toEqual(['load', 'saved', 'external'])
  })

  it('keystrokes during a merging write stay dirty and merge on the next write', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = harness({
      beforeWrite: () => {
        started.resolve()
        return release.promise
      },
    })
    h.session.load()
    await settled()

    h.session.editorChanged('# Hello\n\nmine\n')
    h.setDisk('# Hello\n\ntheirs\n')
    h.mergeNextWrite('# Hello\n\nmine\n\ntheirs\n')
    h.session.externalChanged()
    await started.promise
    h.session.editorChanged('# Hello\n\nmine typed on\n')
    release.resolve()
    await clock.advance(0)

    expect(h.applied).toEqual([]) // the newer keystrokes are not replaced
    expect(h.session.content()).toBe('# Hello\n\nmine typed on\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(true)

    h.mergeNextWrite('# Hello\n\nmine typed on\n\ntheirs\n')
    await h.session.flush()
    // The second write names the text the keystrokes were typed on, which the
    // first write already merged into the file.
    expect(h.expectedContents).toEqual(['# Hello\n', '# Hello\n\nmine\n'])
    expect(h.session.content()).toBe('# Hello\n\nmine typed on\n\ntheirs\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
  })

  it('dispose after flush still completes a merging write', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const h = harness({
      beforeWrite: () => {
        started.resolve()
        return release.promise
      },
    })
    h.session.load()
    await settled()

    h.session.editorChanged('# Hello\n\nmine\n')
    h.setDisk('# Hello\n\ntheirs\n')
    h.mergeNextWrite('# Hello\n\nmine\n\ntheirs\n')
    const flushed = h.session.flush()
    h.session.dispose()
    await started.promise
    const emitted = h.snapshots.length
    release.resolve()
    await flushed

    expect(h.disk()).toBe('# Hello\n\nmine\n\ntheirs\n')
    expect(h.applied).toEqual([]) // no editor is mounted after dispose
    expect(h.snapshots).toHaveLength(emitted)
  })

  it('treats an external event for an in-flight save as an echo', async () => {
    const hold = Promise.withResolvers<void>()
    const h = harness({ afterWrite: () => hold.promise })
    h.session.load()
    await settled()

    h.session.editorChanged('# Saved\n')
    await settled() // the file holds the bytes, the write promise is pending

    // The user keeps typing while the watcher reports our own write.
    h.session.editorChanged('# Saved and more\n')
    h.session.externalChanged()
    await settled()
    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# Saved\n' }])

    hold.resolve()
    await settled()
    expect(h.writes).toEqual([
      { path: 'notes/a.md', contents: '# Saved\n' },
      { path: 'notes/a.md', contents: '# Saved and more\n' },
    ])
    expect(h.snapshots.at(-1)?.error).toBeNull()
  })

  it('a queued save re-checks the buffer at write time (revert during a slow write)', async () => {
    const hold = Promise.withResolvers<void>()
    let writeCount = 0
    const h = harness({
      beforeWrite: async () => {
        writeCount += 1
        if (writeCount === 1) {
          await hold.promise
        }
      },
    })
    h.session.load()
    await settled()

    h.session.editorChanged('# A\n')
    await settled() // write 1 (A) is dispatched and held
    expect(writeCount).toBe(1)

    // A second save queues behind it; the user reverts to A before write 1 settles.
    h.session.editorChanged('# B\n')
    await settled()
    h.session.editorChanged('# A\n')
    hold.resolve()
    await settled()
    await settled()

    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# A\n' }])
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
  })

  it('an external reload never dirties the buffer, even when the editor reports a normalized serialization', async () => {
    let target: NoteSession | null = null
    const h = harness({
      // The editor's change handler fires synchronously inside applyContent
      // and reports a normalized serialization (an extra trailing newline).
      onApply: (markdown) => target?.editorChanged(`${markdown}\n`),
    })
    target = h.session
    h.session.load()
    await settled()

    h.setDisk('# Changed outside\n')
    h.session.externalChanged()
    await settled()
    expect(h.applied).toEqual(['# Changed outside\n'])
    expect(h.snapshots.at(-1)?.dirty).toBe(false)

    await clock.advance(5000)
    await h.session.flush()
    expect(h.writes).toEqual([])
  })

  it('a missing note without createIfMissing is an error', async () => {
    const h = harness({ disk: null })
    h.session.load()
    await settled()

    expect(h.snapshots.at(-1)?.status).toBe('error')
  })
})

describe('frontmatter ownership (Plan 07b)', () => {
  const FM = '---\naliases:\n  - Old\n---\n\n'

  it('the editor sees only the body; classification gates on the body', async () => {
    // A joined round-trip would classify lossy (meowdown mangles ---) — the
    // session must split first, or every frontmatter note opens read-only.
    const h = harness({
      disk: `${FM}# Hello\n`,
      classify: (markdown) => (markdown.includes('---') ? 'lossy' : 'exact'),
    })
    h.session.load()
    await settled()
    const ready = h.snapshots.at(-1)
    expect(ready?.status).toBe('ready')
    expect(ready?.protected).toBe(false)
    expect(ready?.initialContent).toBe('# Hello\n')
  })

  it('a protected note shows the full file, frontmatter included', async () => {
    const h = harness({
      disk: `${FM}+ [ ] lossy body\n`,
      classify: (markdown) => (markdown.includes('+ [ ]') ? 'lossy' : 'exact'),
    })
    h.session.load()
    await settled()
    const ready = h.snapshots.at(-1)
    expect(ready?.protected).toBe(true)
    // The read-only view's job is honest display of a file we refuse to
    // touch — hiding the frontmatter would misrepresent it.
    expect(ready?.initialContent).toBe(`${FM}+ [ ] lossy body\n`)
  })

  it('writes with the generation of its graph reopened, never of another graph', async () => {
    const h = harness()
    h.session.load()
    await settled()
    h.graph.setGraph({ generation: 2 })
    h.session.editorChanged('# Reopened\n')
    await settled()
    h.graph.setGraph({ root: '/graphs/other', generation: 3 })
    h.session.editorChanged('# Switched\n')
    await settled()

    // The second write keeps the opening generation, so Rust rejects it.
    expect(h.generations()).toEqual([2, 1])
  })

  it('saves rejoin the exact header bytes around the edited body', async () => {
    const h = harness({ disk: `${FM}# Hello\n` })
    h.session.load()
    await settled()
    h.session.editorChanged('# Hello edited\n')
    await settled()
    expect(h.writes.at(-1)?.contents).toBe(`${FM}# Hello edited\n`)
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
  })

  it('updateFrontmatter patches the header and saves without touching the editor', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()
    h.session.updateFrontmatter({ aliases: ['Old Title'] })
    await settled()
    const written = h.writes.at(-1)?.contents ?? ''
    expect(written).toContain('aliases:')
    expect(written).toContain('Old Title')
    expect(written.endsWith('# Hello\n')).toBe(true)
    expect(h.applied).toEqual([]) // the editor was never reloaded
  })

  it('pinning writes the flag; unpinning removes the key, not `pinned: false`', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()
    h.session.updateFrontmatter({ pinned: true })
    await settled()
    expect(h.writes.at(-1)?.contents).toBe('---\npinned: true\n---\n\n# Hello\n')

    h.session.updateFrontmatter({ pinned: false })
    await settled()
    // The only metadata was the pin — the note returns to no frontmatter at all.
    expect(h.writes.at(-1)?.contents).toBe('# Hello\n')
    expect(h.applied).toEqual([]) // the editor was never reloaded
  })

  it('marking private writes the flag; un-marking removes the key, not `private: false`', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()
    h.session.updateFrontmatter({ private: true })
    await settled()
    expect(h.writes.at(-1)?.contents).toBe('---\nprivate: true\n---\n\n# Hello\n')

    h.session.updateFrontmatter({ private: false })
    await settled()
    // Same contract as the pin: not-private is the absence of the flag.
    expect(h.writes.at(-1)?.contents).toBe('# Hello\n')
    expect(h.applied).toEqual([]) // the editor was never reloaded
  })

  it('an external frontmatter-only change adopts cleanly', async () => {
    const h = harness({ disk: `${FM}# Hello\n` })
    h.session.load()
    await settled()
    h.setDisk(`---\naliases:\n  - Newer\n---\n# Hello\n`)
    h.session.externalChanged()
    await settled()
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
    // Next save preserves the adopted header.
    h.session.editorChanged('# Hello!\n')
    await settled()
    expect(h.writes.at(-1)?.contents).toBe('---\naliases:\n  - Newer\n---\n\n# Hello!\n')
  })

  it('commitFrontmatter lands the patch immediately on a clean session', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()
    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(true)
    // Flushed, not riding the save debounce.
    expect(h.writes.at(-1)?.contents).toBe('---\npinned: true\n---\n\n# Hello\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
  })

  it('commitFrontmatter rejects a failed save without dropping newer body edits', async () => {
    const writeStarted = Promise.withResolvers<void>()
    const writeFinished = Promise.withResolvers<void>()
    const h = harness({
      beforeWrite: () => {
        writeStarted.resolve()
        return writeFinished.promise
      },
    })
    try {
      h.session.load()
      await settled()
      h.failWrites('disk full')
      const commit = h.session.commitFrontmatter({ pinned: true })
      const rejected = expect(commit).rejects.toThrow('disk full')
      await writeStarted.promise
      h.session.editorChanged('# Typed during pin\n')
      writeFinished.resolve()
      await rejected

      expect(h.session.content()).toBe('# Typed during pin\n')
      expect(h.snapshots.at(-1)?.dirty).toBe(true)
      expect(h.snapshots.at(-1)?.error).toBe('disk full')
      h.failWrites(null)
      await h.session.flush()
      expect(h.writes.at(-1)?.contents).toBe('# Typed during pin\n')
    } finally {
      h.session.discard()
    }
  })

  it('a no-op frontmatter commit does not report an earlier save error', async () => {
    const h = harness()
    try {
      h.session.load()
      await settled()
      h.failWrites('disk full')
      await expect(h.session.commitFrontmatter({ pinned: true })).rejects.toThrow('disk full')
      expect(h.session.content()).toBe('# Hello\n')
      expect(h.snapshots.at(-1)?.dirty).toBe(false)
      await expect(h.session.commitFrontmatter({})).resolves.toBe(true)
      expect(h.writes).toEqual([])
    } finally {
      h.session.discard()
    }
  })

  it('commitFrontmatter declines when the session has no write channel', async () => {
    // No graph generation → no `io.write`. The patch can't land, so report
    // false rather than the in-memory success that would let publish/pin/private
    // skip their disk fallback and treat an unwritten flag as persisted.
    const h = harness({ disk: '# Hello\n', write: false })
    h.session.load()
    await settled()

    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(false)
    expect(h.writes).toEqual([])
  })

  it('commitFrontmatter reports a patch that landed through an exact merge', async () => {
    const h = harness()
    h.session.load()
    await settled()
    h.setDisk('# Hello\n\ntheirs\n')
    h.mergeNextWrite('---\npinned: true\n---\n\n# Hello\n\ntheirs\n')

    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(true)
    expect(h.session.content()).toBe('---\npinned: true\n---\n\n# Hello\n\ntheirs\n')
  })

  it('onContent reports full joined content with the right origins', async () => {
    const h = harness({ disk: `${FM}# Hello\n` })
    h.session.load()
    await settled()
    h.session.editorChanged('# Renamed\n')
    await settled()
    h.setDisk(`${FM}# External\n`)
    h.session.externalChanged()
    await settled()
    expect(h.contents.map((c) => c.origin)).toEqual(['load', 'saved', 'external'])
    expect(h.contents[1]!.content).toBe(`${FM}# Renamed\n`)
  })
})

describe('missing-note seed (new ordinary notes)', () => {
  // The empty H1 the new-note flow seeds (`untitledNoteSeed` body): the
  // caret lands in it and typing names the note.
  const SEED = '#\n'

  it('a missing note opens ready with the seed, marked missing, and writes nothing', async () => {
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    const ready = h.snapshots.at(-1)
    expect(ready?.status).toBe('ready')
    expect(ready?.missing).toBe(true)
    expect(ready?.initialContent).toBe(SEED)
    expect(ready?.dirty).toBe(false)
    expect(h.session.isUnpersisted()).toBe(true)
    expect(h.writes).toEqual([]) // opening never litters the graph
    // The rename tracker baselines on the real (empty) disk content, never
    // the seed, so the first authored title is a birth, not a rename.
    expect(h.contents).toEqual([{ content: '', origin: 'load' }])
  })

  it('the editor echoing the seed back stays clean — no file is created', async () => {
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    // Mount-time serialization: the editor reports the document it was seeded
    // with. That is not a user edit and must not reach disk.
    h.session.editorChanged(SEED)
    await h.session.flush()
    await settled()

    expect(h.writes).toEqual([])
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
  })

  it('a pending first edit can still be discarded without creating a file', async () => {
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    h.session.editorChanged('# Draft\n')
    expect(h.session.isUnpersisted()).toBe(true)
    h.session.discard()
    await settled()

    expect(h.writes).toEqual([])
  })

  it('clearing the seed back to empty writes nothing — the note stays unborn', async () => {
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    // The user deletes the seeded empty title without typing a replacement:
    // an empty unwritten note must not be created on disk.
    h.session.editorChanged('')
    await h.session.flush()
    await settled()

    expect(h.writes).toEqual([])
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
    expect(h.snapshots.at(-1)?.missing).toBe(true)

    // Typing real content afterwards still births the file.
    h.session.editorChanged('# Plans\n')
    await settled()
    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# Plans\n' }])
    expect(h.snapshots.at(-1)?.missing).toBe(false)
  })

  it('a real edit creates the file with the full content and clears missing', async () => {
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    h.session.editorChanged('# My Note\n\nFirst line.\n')
    await settled()

    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# My Note\n\nFirst line.\n' }])
    expect(h.session.isUnpersisted()).toBe(false)
    expect(h.snapshots.at(-1)?.missing).toBe(false)
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
  })

  it('a missing note without a seed opens empty (the lazy daily contract)', async () => {
    const h = harness({ disk: null, createIfMissing: true })
    h.session.load()
    await settled()

    const ready = h.snapshots.at(-1)
    expect(ready?.status).toBe('ready')
    expect(ready?.missing).toBe(true)
    expect(ready?.initialContent).toBe('')
    expect(h.writes).toEqual([])
  })

  it('an existing file ignores the seed entirely', async () => {
    const h = harness({ disk: '# Hello\n', createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    const ready = h.snapshots.at(-1)
    expect(ready?.missing).toBe(false)
    expect(ready?.initialContent).toBe('# Hello\n')
    expect(h.contents).toEqual([{ content: '# Hello\n', origin: 'load' }])
  })

  it('an external write while the seed is showing adopts cleanly and clears missing', async () => {
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    h.setDisk('# Created elsewhere\n')
    h.session.externalChanged()
    await settled()

    const ready = h.snapshots.at(-1)
    expect(ready?.dirty).toBe(false)
    expect(ready?.missing).toBe(false)
    expect(h.applied).toEqual(['# Created elsewhere\n'])
    expect(h.writes).toEqual([])
  })

  it('a file created elsewhere under unsaved seed edits merges against the seed', async () => {
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    h.session.editorChanged('# Mine\n')
    h.setDisk('# Created elsewhere\n')
    h.mergeNextWrite('# Mine\n\nCreated elsewhere\n')
    h.session.externalChanged()
    await settled()

    expect(h.expectedContents).toEqual([SEED])
    expect(h.session.content()).toBe('# Mine\n\nCreated elsewhere\n')
    expect(h.snapshots.at(-1)).toMatchObject({ dirty: false, missing: false })
  })

  it('an external write matching the seed verbatim still clears missing', async () => {
    // The read equals the adopted baseline, so there is nothing to reconcile —
    // but the file exists on disk now, and the snapshot must say so.
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()
    expect(h.snapshots.at(-1)?.missing).toBe(true)

    h.setDisk(SEED)
    h.session.externalChanged()
    await settled()

    const ready = h.snapshots.at(-1)
    expect(ready?.missing).toBe(false)
    expect(h.applied).toEqual([]) // content unchanged: no editor reload
    expect(h.writes).toEqual([])
  })

  it('an external delete reconciles to a no-op: the buffer survives, edits still save', async () => {
    // createIfMissing applies only to the initial load; a deletion mid-session
    // must not error the session or empty the editor — the buffer is the user's.
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()

    h.setDisk(null) // deleted out from under us
    h.session.externalChanged()
    await settled()

    const after = h.snapshots.at(-1)
    expect(after?.status).toBe('ready')
    expect(after?.error).toBeNull()
    expect(h.applied).toEqual([]) // nothing pushed into the editor

    // The next edit recreates the file through the normal save path.
    h.session.editorChanged('# Hello again\n')
    await settled()
    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# Hello again\n' }])
  })

  it('a delete racing unsaved edits keeps them', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()

    h.session.editorChanged('# Unsaved\n')
    h.setDisk(null)
    h.session.externalChanged() // read fails: nothing to merge against
    await settled()

    const after = h.snapshots.at(-1)
    expect(after?.error).toBeNull()
    expect(after?.dirty).toBe(false) // the debounced save already landed…
    expect(h.writes.at(-1)).toEqual({ path: 'notes/a.md', contents: '# Unsaved\n' }) // …recreating the file
  })

  it('a failed save surfaces the error and a later save clears it', async () => {
    const h = harness()
    h.session.load()
    await settled()

    h.failWrites('disk full')
    h.session.editorChanged('# Edited\n')
    await settled()

    const failed = h.snapshots.at(-1)
    expect(failed?.error).toBe('disk full')
    expect(logger.getErrors().map((entry) => entry.message)).toEqual(['failed to save note:'])
    expect(failed?.dirty).toBe(true) // the edit is kept, not lost
    expect(h.writes).toEqual([])

    // The disk recovers; the next edit re-enters the pipeline and the
    // landed save resolves the surfaced error.
    h.failWrites(null)
    h.session.editorChanged('# Edited more\n')
    await settled()

    const recovered = h.snapshots.at(-1)
    expect(recovered?.error).toBeNull()
    expect(recovered?.dirty).toBe(false)
    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# Edited more\n' }])
  })

  it('flush also waits for the retry of a failed save', async () => {
    let attempts = 0
    const h: Harness = harness({
      beforeWrite: () => {
        attempts += 1
        if (attempts === 1) {
          h.setDisk('# Other\n') // the checked write lost a race with another writer
          return Promise.reject(new Error('Note changed on disk; reload before retrying'))
        }
        return Promise.resolve()
      },
    })
    h.session.load()
    await settled()

    h.mergeNextWrite('# Other\n\nEdited\n')
    h.session.editorChanged('# Edited\n')
    await h.session.flush()
    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# Edited\n' }])
    expect(h.disk()).toBe('# Other\n\nEdited\n')
  })

  it('flush after a failed save retries the same buffer', async () => {
    const h = harness()
    h.session.load()
    await settled()

    h.failWrites('disk full')
    h.session.editorChanged('# Edited\n')
    await settled()
    expect(h.snapshots.at(-1)?.error).toBe('disk full')

    h.failWrites(null)
    await h.session.flush() // a settle point (blur/quit) retries without a new edit
    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# Edited\n' }])
    expect(h.snapshots.at(-1)?.error).toBeNull()
  })
})

describe('default-bullet editor seed (daily notes)', () => {
  // The `editorDefaultBullet` feature seeds the *editor* of an empty daily note
  // with `- `; meowdown serializes that lone empty bullet back to `"\n"`. The
  // session has no `missingSeed` for daily notes, so the only way the bullet can
  // reach it is a mount-time serialization — which must be treated as the empty
  // note it is, never written, so a future placeholder stays uncreated.
  it('an empty-bullet serialization on a missing daily note writes nothing', async () => {
    const h = harness({ disk: null, createIfMissing: true })
    h.session.load()
    await settled()
    expect(h.snapshots.at(-1)?.missing).toBe(true)

    h.session.editorChanged('\n') // docToMarkdown of an unedited empty bullet
    await h.session.flush()
    await settled()

    expect(h.writes).toEqual([]) // the placeholder is still not on disk
    expect(h.snapshots.at(-1)?.missing).toBe(true)
    expect(h.snapshots.at(-1)?.dirty).toBe(false)

    // Typing into the bullet births the file with the real content.
    h.session.editorChanged('- groceries\n')
    await settled()
    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '- groceries\n' }])
    expect(h.snapshots.at(-1)?.missing).toBe(false)
  })
})

describe('retarget (Plan 17)', () => {
  it('rebinds reads and writes to the new path without touching document state', async () => {
    const h = harness()
    h.session.load()
    await vi.waitFor(() => expect(h.snapshots.at(-1)?.status).toBe('ready'))

    h.session.editorChanged('# Hello\n\nfirst edit\n')
    await h.session.flush()
    expect(h.writes.at(-1)?.path).toBe('notes/a.md')

    h.session.retarget('notes/hello.md')
    expect(h.session.path).toBe('notes/hello.md')
    // The buffer carried over: not dirty, nothing rewritten on retarget alone.
    expect(h.snapshots.at(-1)?.dirty).toBe(false)

    h.session.editorChanged('# Hello\n\nsecond edit\n')
    await h.session.flush()
    expect(h.writes.at(-1)).toEqual({
      path: 'notes/hello.md',
      contents: '# Hello\n\nsecond edit\n',
    })
  })

  it('keeps frontmatter ownership across a retarget', async () => {
    const h = harness({ disk: '---\nid: 01abc\n---\n\n# Hello\n' })
    h.session.load()
    await vi.waitFor(() => expect(h.snapshots.at(-1)?.status).toBe('ready'))

    h.session.retarget('notes/hello.md')
    h.session.editorChanged('# Hello\n\nbody\n')
    await h.session.flush()
    // The exact header bytes ride along to the new path.
    expect(h.writes.at(-1)).toEqual({
      path: 'notes/hello.md',
      contents: '---\nid: 01abc\n---\n\n# Hello\n\nbody\n',
    })
  })
})

describe('commitSourceEdit', () => {
  it('applies a task toggle to the live buffer, preserving unsaved edits, and reflects it in the editor', async () => {
    const source = '# Todo\n\n+ [ ] buy milk\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    // The user appends a line below the task — unsaved when the toggle arrives.
    h.session.editorChanged('# Todo\n\n+ [ ] buy milk\n\njot\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(true)

    expect(await h.session.commitSourceEdit(toggleTransform(firstTask(source)))).toBe(true)
    // The write carries both the unsaved edit and the toggled checkbox.
    expect(h.writes.at(-1)?.contents).toBe('# Todo\n\n+ [x] buy milk\n\njot\n')
    // The open editor was updated to show the toggled checkbox.
    expect(h.applied.at(-1)).toBe('# Todo\n\n+ [x] buy milk\n\njot\n')
  })

  it('keeps the frontmatter around a body transform', async () => {
    const source = '---\nid: 01abc\n---\n\n+ [ ] ship it\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    expect(await h.session.commitSourceEdit(toggleTransform(firstTask('+ [ ] ship it\n')))).toBe(
      true,
    )
    expect(h.writes.at(-1)?.contents).toBe('---\nid: 01abc\n---\n\n+ [x] ship it\n')
  })

  it('waits for a loading session, then applies the edit to the loaded buffer', async () => {
    // ⌘D from the Tasks view: the daily note's session is created in the same
    // tick the unmounting task editor flushes its edit into it (#1099).
    const source = '# Todo\n\n+ [ ] buy milk\n'
    const pendingRead = Promise.withResolvers<void>()
    const h = harness({
      disk: source,
      beforeRead: () => pendingRead.promise,
    })
    h.session.load()
    expect(h.snapshots.at(-1)?.status).toBe('loading')

    let result: boolean | undefined
    const commit = h.session
      .commitSourceEdit((full) => full.replace('buy milk', 'buy oat milk'))
      .then((applied) => {
        result = applied
      })
    await settled()
    expect(result).toBeUndefined() // still waiting on the read, not refused
    expect(h.writes).toEqual([])

    pendingRead.resolve()
    await commit
    await settled()
    expect(result).toBe(true)
    expect(h.writes.at(-1)?.contents).toBe('# Todo\n\n+ [ ] buy oat milk\n')
    expect(h.applied.at(-1)).toBe('# Todo\n\n+ [ ] buy oat milk\n')
    // The pane mounts its editor from `initialContent` only after the ready
    // snapshot renders, so `applyContent` above reached no editor yet: the seed
    // must already carry the edit or the editor opens on the pre-edit body.
    expect(h.snapshots.at(-1)?.initialContent).toBe('# Todo\n\n+ [ ] buy oat milk\n')
  })

  it('refuses (returns false) a note that loads as protected while the edit waits', async () => {
    // Protection is decided by the load, so the gate must run after the wait.
    const pendingRead = Promise.withResolvers<void>()
    const h = harness({
      disk: '+ [ ] x\n',
      classify: () => 'lossy',
      beforeRead: () => pendingRead.promise,
    })
    h.session.load()

    const transform = vi.fn(toggleTransform(firstTask('+ [ ] x\n')))
    const commit = h.session.commitSourceEdit(transform)
    pendingRead.resolve()
    expect(await commit).toBe(false)
    expect(h.snapshots.at(-1)?.protected).toBe(true)
    expect(transform).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  })

  it('refuses (returns false) a session whose load failed', async () => {
    const h = harness({
      disk: '+ [ ] x\n',
      beforeRead: () => Promise.reject(new Error('read failed')),
    })
    h.session.load()

    const transform = vi.fn(toggleTransform(firstTask('+ [ ] x\n')))
    expect(await h.session.commitSourceEdit(transform)).toBe(false)
    expect(h.snapshots.at(-1)?.status).toBe('error')
    expect(transform).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  })

  it('refuses (returns false) a protected note rather than write', async () => {
    const h = harness({ disk: '+ [ ] x\n', classify: () => 'lossy' })
    h.session.load()
    await settled()

    const transform = vi.fn(toggleTransform(firstTask('+ [ ] x\n')))
    expect(await h.session.commitSourceEdit(transform)).toBe(false)
    expect(transform).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  })

  it('reverts the edit and surfaces the error when the write fails', async () => {
    const source = '+ [ ] x\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.failWrites('disk full')
    await expect(h.session.commitSourceEdit(toggleTransform(firstTask(source)))).rejects.toThrow(
      'disk full',
    )
    // Transactional: nothing persisted, so the buffer and the editor revert to
    // the un-toggled line (no divergence with the rolled-back Tasks list).
    expect(h.session.content()).toBe('+ [ ] x\n')
    expect(h.applied.at(-1)).toBe('+ [ ] x\n')
    expect(h.snapshots.at(-1)?.initialContent).toBe('+ [ ] x\n')
    expect(h.snapshots.at(-1)?.error).toBeNull()
  })

  it('propagates an error the transform throws, such as TaskStaleError, without writing', async () => {
    const source = '+ [ ] gone\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.session.editorChanged('+ [ ] something else entirely\n')
    await expect(
      h.session.commitSourceEdit(toggleTransform(firstTask(source))),
    ).rejects.toBeInstanceOf(TaskStaleError)
    expect(h.writes).toEqual([])
    expect(h.session.content()).toBe('+ [ ] something else entirely\n')
  })

  it('keeps dirty body text while committing metadata and a bookmark together', async () => {
    const h = harness()
    h.session.load()
    await settled()
    h.session.editorChanged('# My unsaved thought\n')
    expect(
      await h.session.commitSourceEdit(
        (source) => `---\nreceipt: saved\n---\n${source}\n[X post](https://x.com/i/status/20)\n`,
      ),
    ).toBe(true)
    expect(h.writes.at(-1)?.contents).toContain('# My unsaved thought')
    expect(h.writes.at(-1)?.contents).toContain('receipt: saved')
    expect(h.writes.at(-1)?.contents).toContain('https://x.com/i/status/20')
  })
})

it.each([null, '# Hello\n'])(
  'sends the last disk revision for checked writes: %s',
  async (disk) => {
    const h = harness({ disk, createIfMissing: true })
    h.session.load()
    await settled()
    h.session.editorChanged('# First edit\n')
    await h.session.flush()
    h.session.editorChanged('# Second edit\n')
    await h.session.flush()
    expect(h.expectedContents).toEqual([disk, '# First edit\n'])
    h.session.discard()
  },
)

it('a rejected source edit preserves typing made while its write was pending', async () => {
  const started = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const h = harness({
    beforeWrite: () => {
      started.resolve()
      return finished.promise
    },
  })
  try {
    h.session.load()
    await settled()
    h.failWrites('disk full')
    const commit = h.session.commitSourceEdit(
      (source) => `---\nreceipt: queued\n---\n${source}\nBookmark\n`,
    )
    const failure = expect(commit).rejects.toThrow('disk full')
    await started.promise
    h.session.editorChanged('# Typed during capture\n')
    finished.resolve()
    await failure
    expect(h.session.content()).toBe('# Typed during capture\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
    expect(h.writes).toEqual([])
  } finally {
    h.session.discard()
  }
})

describe('frontmatter separator line', () => {
  it('keeps the separator line out of the editor body', async () => {
    const { session, snapshots } = harness({ disk: '---\nid: x\n---\n\n# T\n' })
    session.load()
    await settled()

    expect(snapshots.at(-1)?.initialContent).toBe('# T\n')
  })

  it('keeps a blank line added above the body across a reopen', async () => {
    const first = harness({ disk: '---\nid: x\n---\n# T\n' })
    first.session.load()
    await settled()
    first.session.editorChanged('\n# T\n')
    await first.session.flush()

    const saved = '---\nid: x\n---\n\n\n# T\n'
    expect(first.writes.at(-1)?.contents).toBe(saved)

    const second = harness({ disk: saved })
    second.session.load()
    await settled()
    expect(second.snapshots.at(-1)?.initialContent).toBe('\n# T\n')
  })

  it('keeps a leading blank line through a source edit', async () => {
    const { session, applied } = harness({ disk: '---\nid: x\n---\n# T\n' })
    session.load()
    await settled()
    session.editorChanged('\n+ [ ] a\n')

    await session.commitSourceEdit(toggleTransform(firstTask(session.content())))

    expect(applied.at(-1)).toBe('\n+ [x] a\n')
  })

  it('keeps the frontmatter when the file ends at the closing fence', async () => {
    const { session, writes } = harness({ disk: '---\nid: x\n---' })
    session.load()
    await settled()
    session.editorChanged('hello')
    await session.flush()

    expect(writes.at(-1)?.contents).toBe('---\nid: x\n---\n\nhello')
  })
})
