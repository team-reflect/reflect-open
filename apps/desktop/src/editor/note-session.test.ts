import { applyTaskEdits, projectTasks, TaskStaleError, type TaskLocator } from '@reflect/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MergeTextOutcome } from '@reflect/core'
import { createNoteSession, type NoteSessionSnapshot } from './note-session.ts'
import type { RoundTripFidelity } from './roundtrip.ts'

/** The first task's locator as the index records it. */
function firstTask(source: string): TaskLocator {
  const [task] = projectTasks(source)
  return { astPath: task!.astPath, markdown: task!.markdown, checked: task!.checked }
}

/** The Tasks view's open-note write: toggle `task` through the live buffer. */
function toggleTransform(task: TaskLocator): (source: string) => string {
  return (source) => applyTaskEdits(source, [{ kind: 'toggle', task }]).source
}

/**
 * Direct tests of the document state machine, no React. The full pipeline
 * (load, debounce, echo detection, external merges, protection) is covered
 * end-to-end through the hook in `use-note-document.test.tsx`; these pin the
 * session-level contracts the hook can't observe directly.
 */

interface Harness {
  snapshots: NoteSessionSnapshot[]
  expectedContents: (string | null | undefined)[]
  writes: Array<{ path: string; contents: string }>
  applied: string[]
  contents: Array<{ content: string; origin: string }>
  /** `null` deletes the file: subsequent reads throw the notFound AppError. */
  setDisk: (contents: string | null) => void
  /** While set, writes reject with this message (the save-failure seam). */
  failWrites: (message: string | null) => void
  /** Script the next three-way merge outcome (`null` = the merge throws). */
  setMerge: (outcome: MergeTextOutcome | null) => void
  /** Buffers kept beside the note when they could not be merged (`previous` = the copy being retaken). */
  copies: Array<{ path: string; contents: string; previous: string | null }>
  /** While set, conflict copies reject with this message. */
  failCopies: (message: string | null) => void
  session: ReturnType<typeof createNoteSession>
}

function harness(options?: {
  /** Runs before every read resolves (the slow-load seam). */
  beforeRead?: () => Promise<void>
  beforeWrite?: () => Promise<void>
  /** Runs before every conflict copy resolves (the slow-copy seam). */
  beforeCopy?: () => void
  write?: false
  /** No conflict-copy capability (a session that can write but not copy aside). */
  copyAside?: false
  classify?: (markdown: string) => RoundTripFidelity
  /** `null` simulates a missing file: reads throw the notFound AppError. */
  disk?: string | null
  createIfMissing?: boolean
  missingSeed?: string
  reconcilePendingEditorInput?: () => void
  /** Initial scripted merge outcome; `undefined` = no merge capability. */
  merge?: MergeTextOutcome
}): Harness {
  const snapshots: NoteSessionSnapshot[] = []
  const expectedContents: (string | null | undefined)[] = []
  const writes: Array<{ path: string; contents: string }> = []
  const applied: string[] = []
  const contents: Array<{ content: string; origin: string }> = []
  const copies: Array<{ path: string; contents: string; previous: string | null }> = []
  let disk = options?.disk === undefined ? '# Hello\n' : options.disk
  let writeFailure: string | null = null
  let copyFailure: string | null = null
  let mergeOutcome: MergeTextOutcome | null = options?.merge ?? null
  const session = createNoteSession({
    path: 'notes/a.md',
    io: {
      read: async () => {
        await options?.beforeRead?.()
        if (disk === null) {
          throw { kind: 'notFound', message: 'missing' } // AppError shape
        }
        return disk
      },
      write:
        options?.write === false
          ? null
          : async (path, contents, expected) => {
              expectedContents.push(expected)
              await options?.beforeWrite?.()
              if (writeFailure !== null) {
                throw new Error(writeFailure)
              }
              if (expected !== undefined && expected !== disk)
                throw { kind: 'io', message: 'Note changed on disk; reload before retrying' }
              writes.push({ path, contents })
              disk = contents
            },
      mergeText:
        options?.merge === undefined
          ? undefined
          : async () => {
              if (mergeOutcome === null) {
                throw new Error('no merge')
              }
              return mergeOutcome
            },
      copyAside:
        options?.copyAside === false
          ? undefined
          : async (path, contents, previous) => {
              options?.beforeCopy?.()
              if (copyFailure !== null) {
                throw new Error(copyFailure)
              }
              copies.push({ path, contents, previous: previous?.path ?? null })
              return previous?.path ?? `${path.slice(0, -3)} (conflict${copies.length}).md`
            },
    },
    classify: options?.classify ?? (() => 'exact'),
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot)
    },
    applyContent: (markdown) => {
      applied.push(markdown)
    },
    ...(options?.reconcilePendingEditorInput === undefined
      ? {}
      : { reconcilePendingEditorInput: options.reconcilePendingEditorInput }),
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
    setDisk: (contents) => {
      disk = contents
    },
    failWrites: (message) => {
      writeFailure = message
    },
    failCopies: (message) => {
      copyFailure = message
    },
    setMerge: (outcome) => {
      mergeOutcome = outcome
    },
    copies,
    session,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

async function settled(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50)
}

describe('createNoteSession', () => {
  it('tracks dirtiness but never writes without a write capability', async () => {
    const { session, writes, snapshots } = harness({ write: false })
    session.load()
    await settled()

    session.editorChanged('# Edited\n')
    session.flush()
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
    let target: ReturnType<typeof createNoteSession> | null = null
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
    await vi.advanceTimersByTimeAsync(0)

    const afterLoad = snapshots.length
    session.editorChanged('# Same edit\n')
    session.editorChanged('# Same edit\n')
    expect(snapshots.length).toBe(afterLoad + 1) // one dirty transition, not two
  })

  it('a clean three-way merge applies silently and keeps saving', async () => {
    // The field report: a script appended to the daily note while the user
    // folded a bullet. Nothing overlaps, so nothing to ask.
    const merged = '# Hello\n\n+ mine\n- from the script\n'
    const { session, writes, applied, snapshots, setDisk, expectedContents } = harness({
      merge: { kind: 'clean', content: merged },
    })
    session.load()
    await settled()
    session.editorChanged('# Hello\n\n+ mine\n')
    setDisk('# Hello\n\n- mine\n- from the script\n')
    session.externalChanged()
    await settled()

    expect(snapshots.at(-1)).toMatchObject({ dirty: false, protected: false })
    expect(applied).toEqual([merged])
    expect(writes).toEqual([{ path: 'notes/a.md', contents: merged }])
    // The write expects the external content: that is what is on disk now.
    expect(expectedContents.at(-1)).toBe('# Hello\n\n- mine\n- from the script\n')
  })

  it('a clean merge the editor cannot round-trip is written exactly and opens protected', async () => {
    const merged = '+ [ ] mine\n+ [ ] theirs\n'
    const { session, writes, applied, snapshots, setDisk, expectedContents } = harness({
      merge: { kind: 'clean', content: merged },
      classify: (markdown) => (markdown.includes('+ [ ]') ? 'lossy' : 'exact'),
    })
    session.load()
    await settled()
    session.editorChanged('mine\n')
    const appliedBefore = applied.length
    setDisk('theirs\n')
    session.externalChanged()
    await settled()

    // The exact merge lands on disk; the live editor never sees it, so its
    // normalized text can never be saved over the merge.
    expect(writes).toEqual([{ path: 'notes/a.md', contents: merged }])
    expect(expectedContents.at(-1)).toBe('theirs\n')
    expect(applied).toHaveLength(appliedBefore)
    expect(snapshots.at(-1)).toMatchObject({
      protected: true,
      dirty: false,
      error: null,
      initialContent: merged,
    })
  })

  it('overlapping edits are written into the file as markers and open protected', async () => {
    const marked = '<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> other device\n'
    const { session, writes, snapshots, copies, setDisk, expectedContents } = harness({
      merge: { kind: 'conflicted', content: marked },
    })
    session.load()
    await settled()
    session.editorChanged('mine\n')
    setDisk('theirs\n')
    session.externalChanged()
    await settled()

    // Written over the external version it was merged from, like a pull.
    expect(writes).toEqual([{ path: 'notes/a.md', contents: marked }])
    expect(expectedContents.at(-1)).toBe('theirs\n')
    expect(copies).toEqual([])
    expect(snapshots.at(-1)).toMatchObject({
      protected: true,
      dirty: false,
      error: null,
      initialContent: marked,
    })
  })

  it('a file that moved again before the markers landed is merged afresh, not overwritten', async () => {
    const marked = '<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> other device\n'
    let h: Harness | null = null
    h = harness({
      merge: { kind: 'conflicted', content: marked },
      beforeWrite: async () => {
        h?.setDisk('theirs, newer\n') // another device wrote again under the merge
      },
    })
    h.session.load()
    await settled()
    h.session.editorChanged('mine\n')
    h.setDisk('theirs\n')
    h.session.externalChanged()
    await settled()

    // The first write expected the version the merge was made from and was
    // refused as stale; the session re-read the file and merged over it.
    expect(h.expectedContents).toEqual(['theirs\n', 'theirs, newer\n'])
    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: marked }])
    expect(h.snapshots.at(-1)).toMatchObject({ protected: true, error: null })
  })

  it('typing while the markers are written is kept beside the note', async () => {
    const marked = '<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> other device\n'
    let target: ReturnType<typeof createNoteSession> | null = null
    const { session, writes, copies, snapshots, setDisk } = harness({
      merge: { kind: 'conflicted', content: marked },
      beforeWrite: async () => {
        target?.editorChanged('mine, typed during the merge\n')
      },
    })
    target = session
    session.load()
    await settled()
    session.editorChanged('mine\n')
    setDisk('theirs\n')
    session.externalChanged()
    await settled()

    expect(writes).toEqual([{ path: 'notes/a.md', contents: marked }])
    expect(copies).toMatchObject([
      { path: 'notes/a.md', contents: 'mine, typed during the merge\n' },
    ])
    expect(snapshots.at(-1)).toMatchObject({ protected: true, initialContent: marked })
  })

  it('a failed marker write keeps the buffer dirty and the next save merges again', async () => {
    const marked = '<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> other device\n'
    const { session, writes, snapshots, setDisk, failWrites } = harness({
      merge: { kind: 'conflicted', content: marked },
    })
    session.load()
    await settled()
    failWrites('disk full')
    session.editorChanged('mine\n')
    setDisk('theirs\n')
    session.externalChanged()
    await settled()
    expect(writes).toEqual([])
    expect(snapshots.at(-1)).toMatchObject({ error: 'disk full', dirty: true, protected: false })

    // The save chain is still live: the next save finds the file changed,
    // reconciles, and lands the merge.
    failWrites(null)
    session.editorChanged('mine, more\n')
    await settled()
    expect(writes).toEqual([{ path: 'notes/a.md', contents: marked }])
    expect(snapshots.at(-1)).toMatchObject({ error: null, protected: true })
  })

  it('edits that cannot be merged are kept beside the note and the external version loads', async () => {
    const { session, writes, applied, copies, snapshots, setDisk } = harness({
      merge: { kind: 'unmergeable', content: 'theirs\n' },
    })
    session.load()
    await settled()
    session.editorChanged('mine\n')
    setDisk('theirs\n')
    session.externalChanged()
    await settled()

    expect(writes).toEqual([])
    expect(copies).toMatchObject([{ path: 'notes/a.md', contents: 'mine\n' }])
    expect(applied).toEqual(['theirs\n'])
    expect(snapshots.at(-1)).toMatchObject({ dirty: false, protected: false, error: null })
  })

  it('a failed conflict copy keeps the dirty buffer, and the next save retries it', async () => {
    const { session, writes, applied, copies, snapshots, setDisk, failCopies } = harness({
      merge: { kind: 'unmergeable', content: 'theirs\n' },
    })
    session.load()
    await settled()
    failCopies('disk full')
    session.editorChanged('mine\n')
    setDisk('theirs\n')
    session.externalChanged()
    await settled()

    // Nothing durable holds the edits yet, so nothing replaces them.
    expect(copies).toEqual([])
    expect(applied).toEqual([])
    expect(session.content()).toBe('mine\n')
    expect(snapshots.at(-1)).toMatchObject({ dirty: true, error: 'disk full' })

    // The next save is refused as stale, reconciles, and copies again.
    failCopies(null)
    session.editorChanged('mine, more\n')
    await settled()
    expect(writes).toEqual([])
    expect(copies).toMatchObject([{ path: 'notes/a.md', contents: 'mine, more\n' }])
    expect(applied).toEqual(['theirs\n'])
    expect(snapshots.at(-1)).toMatchObject({ dirty: false, error: null })
  })

  it('keystrokes typed while the conflict copy is made are copied too', async () => {
    let target: ReturnType<typeof createNoteSession> | null = null
    let typed = false
    const { session, copies, applied, setDisk } = harness({
      merge: { kind: 'unmergeable', content: 'theirs\n' },
      beforeCopy: () => {
        if (!typed) {
          typed = true
          target?.editorChanged('mine, typed during the copy\n')
        }
      },
    })
    target = session
    session.load()
    await settled()
    session.editorChanged('mine\n')
    setDisk('theirs\n')
    session.externalChanged()
    await settled()

    // The second round overwrites the copy the first made, not a new file.
    expect(copies).toMatchObject([
      { contents: 'mine\n', previous: null },
      { contents: 'mine, typed during the copy\n', previous: 'notes/a (conflict1).md' },
    ])
    expect(applied).toEqual(['theirs\n'])
  })

  it('a later conflict in the same session gets its own copy', async () => {
    const { session, copies, setDisk } = harness({
      merge: { kind: 'unmergeable', content: 'theirs\n' },
    })
    session.load()
    await settled()
    for (const [mine, theirs] of [
      ['mine A\n', 'theirs\n'],
      ['mine B\n', 'theirs, again\n'],
    ] as const) {
      session.editorChanged(mine)
      setDisk(theirs)
      session.externalChanged()
      await settled()
    }
    // Neither reconciliation knows about the other's copy: version A survives.
    expect(copies).toMatchObject([
      { contents: 'mine A\n', previous: null },
      { contents: 'mine B\n', previous: null },
    ])
  })

  it('a merge that throws keeps the edits beside the note before adopting the external version', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { session, copies, applied, writes, snapshots, setDisk, setMerge } = harness({
      merge: { kind: 'clean', content: 'never used\n' },
    })
    session.load()
    await settled()
    setMerge(null) // the merge command rejects (a dev harness without it, an IPC failure)
    session.editorChanged('mine\n')
    setDisk('theirs\n')
    session.externalChanged()
    await settled()

    expect(consoleError).toHaveBeenCalledWith('three-way merge failed:', expect.any(Error))
    expect(copies).toMatchObject([{ path: 'notes/a.md', contents: 'mine\n' }])
    expect(applied).toEqual(['theirs\n'])
    expect(writes).toEqual([])
    expect(snapshots.at(-1)).toMatchObject({ dirty: false, error: null })
    consoleError.mockRestore()
  })

  it('a stale autosave whose content is already on disk reconciles clean and clears the error', async () => {
    // Another writer put exactly the buffer on disk before the checked save
    // ran: the save is refused, the reconciliation adopts the matching
    // content, and the failure it reported must not linger with nothing
    // left to save.
    const { session, snapshots, setDisk } = harness()
    session.load()
    await settled()
    session.editorChanged('# Same on both\n')
    setDisk('# Same on both\n')
    await session.flush()
    await settled()
    expect(snapshots.at(-1)).toMatchObject({ dirty: false, error: null })
  })

  it('with nowhere to keep the edits, the buffer stays and the external version waits', async () => {
    const { session, applied, snapshots, setDisk } = harness({
      merge: { kind: 'unmergeable', content: 'theirs\n' },
      copyAside: false,
    })
    session.load()
    await settled()
    session.editorChanged('mine\n')
    setDisk('theirs\n')
    session.externalChanged()
    await settled()

    expect(applied).toEqual([])
    expect(session.content()).toBe('mine\n')
    expect(snapshots.at(-1)?.dirty).toBe(true)
  })

  it('a flush that runs into an external change lands the clean merge before it resolves', async () => {
    // Cmd-Q right after another device wrote: the checked save is refused,
    // the merge is clean, and the flush must not report done until the
    // merged content is on disk.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const merged = '# Hello\n\n- mine\n- theirs\n'
    const { session, writes, snapshots, setDisk } = harness({
      merge: { kind: 'clean', content: merged },
    })
    session.load()
    await settled()
    session.editorChanged('# Hello\n\n- mine\n')
    setDisk('# Hello\n\n- theirs\n')
    await session.flush()

    expect(writes.at(-1)).toEqual({ path: 'notes/a.md', contents: merged })
    expect(snapshots.at(-1)).toMatchObject({ dirty: false, error: null })
    consoleError.mockRestore()
  })

  it('without a merge capability the edits are kept beside the note too', async () => {
    const { session, copies, applied, setDisk } = harness()
    session.load()
    await settled()
    session.editorChanged('mine\n')
    setDisk('theirs\n')
    session.externalChanged()
    await settled()

    expect(copies).toMatchObject([{ path: 'notes/a.md', contents: 'mine\n' }])
    expect(applied).toEqual(['theirs\n'])
  })

  it('the same edit landing from both sides adopts cleanly', async () => {
    // The user types X while the same X lands on disk (another device synced
    // the identical edit): nothing to merge, nothing to keep aside.
    const { session, writes, copies, snapshots, setDisk } = harness()
    session.load()
    await settled()
    session.editorChanged('# Same on both\n')
    setDisk('# Same on both\n')
    session.externalChanged()
    await settled()

    expect(copies).toEqual([])
    expect(writes).toEqual([])
    expect(snapshots.at(-1)).toMatchObject({ dirty: false, initialContent: '# Same on both\n' })
  })

  it('re-gates protection when external content stops being representable', async () => {
    const lossyWhenTasks = (markdown: string): RoundTripFidelity =>
      markdown.includes('+ [ ]') ? 'lossy' : 'exact'
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
    await vi.runAllTimersAsync()
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
    await vi.runAllTimersAsync()
    const ready = h.snapshots.at(-1)
    expect(ready?.protected).toBe(true)
    // The read-only view's job is honest display of a file we refuse to
    // touch — hiding the frontmatter would misrepresent it.
    expect(ready?.initialContent).toBe(`${FM}+ [ ] lossy body\n`)
  })

  it('saves rejoin the exact header bytes around the edited body', async () => {
    const h = harness({ disk: `${FM}# Hello\n` })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Hello edited\n')
    await vi.runAllTimersAsync()
    expect(h.writes.at(-1)?.contents).toBe(`${FM}# Hello edited\n`)
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
  })

  it('updateFrontmatter patches the header and saves without touching the editor', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.updateFrontmatter({ aliases: ['Old Title'] })
    await vi.runAllTimersAsync()
    const written = h.writes.at(-1)?.contents ?? ''
    expect(written).toContain('aliases:')
    expect(written).toContain('Old Title')
    expect(written.endsWith('# Hello\n')).toBe(true)
    expect(h.applied).toEqual([]) // the editor was never reloaded
  })

  it('pinning writes the flag; unpinning removes the key, not `pinned: false`', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.updateFrontmatter({ pinned: true })
    await vi.runAllTimersAsync()
    expect(h.writes.at(-1)?.contents).toBe('---\npinned: true\n---\n\n# Hello\n')

    h.session.updateFrontmatter({ pinned: false })
    await vi.runAllTimersAsync()
    // The only metadata was the pin — the note returns to no frontmatter at all.
    expect(h.writes.at(-1)?.contents).toBe('# Hello\n')
    expect(h.applied).toEqual([]) // the editor was never reloaded
  })

  it('marking private writes the flag; un-marking removes the key, not `private: false`', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.updateFrontmatter({ private: true })
    await vi.runAllTimersAsync()
    expect(h.writes.at(-1)?.contents).toBe('---\nprivate: true\n---\n\n# Hello\n')

    h.session.updateFrontmatter({ private: false })
    await vi.runAllTimersAsync()
    // Same contract as the pin: not-private is the absence of the flag.
    expect(h.writes.at(-1)?.contents).toBe('# Hello\n')
    expect(h.applied).toEqual([]) // the editor was never reloaded
  })

  it('an external frontmatter-only change adopts cleanly without a conflict', async () => {
    const h = harness({ disk: `${FM}# Hello\n` })
    h.session.load()
    await vi.runAllTimersAsync()
    h.setDisk(`---\naliases:\n  - Newer\n---\n# Hello\n`)
    h.session.externalChanged()
    await vi.runAllTimersAsync()
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
    // Next save preserves the adopted header.
    h.session.editorChanged('# Hello!\n')
    await vi.runAllTimersAsync()
    expect(h.writes.at(-1)?.contents).toBe('---\naliases:\n  - Newer\n---\n\n# Hello!\n')
  })

  it('commitFrontmatter lands the patch immediately on a clean session', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await vi.runAllTimersAsync()
    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(true)
    // Flushed, not riding the save debounce.
    expect(h.writes.at(-1)?.contents).toBe('---\npinned: true\n---\n\n# Hello\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
  })

  it('commitFrontmatter rejects a failed save without dropping newer body edits', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
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
      consoleError.mockRestore()
    }
  })

  it('a no-op frontmatter commit does not report an earlier save error', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
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
      consoleError.mockRestore()
    }
  })

  it('commitFrontmatter declines when the session has no write channel', async () => {
    // No graph generation → no `io.write`. The patch can't land, so report
    // false rather than the in-memory success that would let publish/pin/private
    // skip their disk fallback and treat an unwritten flag as persisted.
    const h = harness({ disk: '# Hello\n', write: false })
    h.session.load()
    await vi.runAllTimersAsync()

    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(false)
    expect(h.writes).toEqual([])
  })

  it('onContent reports full joined content with the right origins', async () => {
    const h = harness({ disk: `${FM}# Hello\n` })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Renamed\n')
    await vi.runAllTimersAsync()
    h.setDisk(`${FM}# External\n`)
    h.session.externalChanged()
    await vi.runAllTimersAsync()
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
    // Another device/process creates the file while the seeded buffer is open
    // and untouched: nothing to merge — the buffer was never dirty.
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    h.setDisk('# Created elsewhere\n')
    h.session.externalChanged()
    await settled()

    const ready = h.snapshots.at(-1)
    expect(ready?.missing).toBe(false)
    expect(h.applied).toEqual(['# Created elsewhere\n'])
    expect(h.writes).toEqual([])
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

  it('a delete racing unsaved edits neither conflicts nor drops them', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()

    h.session.editorChanged('# Unsaved\n')
    h.setDisk(null)
    h.session.externalChanged() // read fails: nothing to merge against
    await settled()

    const after = h.snapshots.at(-1)
    expect(after?.dirty).toBe(false) // the debounced save already landed…
    expect(h.writes.at(-1)).toEqual({ path: 'notes/a.md', contents: '# Unsaved\n' }) // …recreating the file
  })

  it('a failed save surfaces the error and a later save clears it', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = harness()
      h.session.load()
      await settled()

      h.failWrites('disk full')
      h.session.editorChanged('# Edited\n')
      await settled()

      const failed = h.snapshots.at(-1)
      expect(failed?.error).toBe('disk full')
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
    } finally {
      consoleError.mockRestore()
    }
  })

  it('flush after a failed save retries the same buffer', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
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
    } finally {
      consoleError.mockRestore()
    }
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
    let finishRead = (): void => {}
    const h = harness({
      disk: source,
      beforeRead: () =>
        new Promise<void>((resolve) => {
          finishRead = resolve
        }),
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

    finishRead()
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
    let finishRead = (): void => {}
    const h = harness({
      disk: '+ [ ] x\n',
      classify: () => 'lossy',
      beforeRead: () =>
        new Promise<void>((resolve) => {
          finishRead = resolve
        }),
    })
    h.session.load()

    const transform = vi.fn(toggleTransform(firstTask('+ [ ] x\n')))
    const commit = h.session.commitSourceEdit(transform)
    finishRead()
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

  it('refuses (returns false) once an external merge opened the note protected', async () => {
    const source = '+ [ ] x\n'
    const marked =
      '<<<<<<< this device\n+ [ ] x edited\n=======\n+ [ ] x external\n>>>>>>> other device\n'
    const h = harness({ disk: source, merge: { kind: 'conflicted', content: marked } })
    h.session.load()
    await settled()

    h.session.editorChanged('+ [ ] x edited\n') // dirty
    h.setDisk('+ [ ] x external\n')
    h.session.externalChanged() // overlapping edits: markers land, the note goes protected
    await settled()

    expect(await h.session.commitSourceEdit(toggleTransform(firstTask(source)))).toBe(false)
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

it('a checked autosave that finds the file changed merges the external revision in', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const merged = '# My unsaved text\n# Capture wrote here\n'
  const h = harness({ merge: { kind: 'clean', content: merged } })
  try {
    h.session.load()
    await settled()
    h.session.editorChanged('# My unsaved text\n')
    h.setDisk('# Capture wrote here\n')
    await h.session.flush() // refused as stale, then reconciled and merged
    await settled()
    expect(h.expectedContents).toEqual(['# Hello\n', '# Capture wrote here\n'])
    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: merged }])
    expect(h.session.content()).toBe(merged)
    expect(h.snapshots.at(-1)).toMatchObject({ dirty: false, error: null })
  } finally {
    h.session.discard()
    log.mockRestore()
  }
})

it('a rejected source edit preserves typing made while its write was pending', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
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
    log.mockRestore()
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
