import {
  hashContent,
  parseNote,
  TaskStaleError,
  type NoteRevisionWriteOutcome,
  type TaskMarker,
} from '@reflect/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoteSession, type NoteSessionIo, type NoteSessionSnapshot } from './note-session'
import type { RoundTripFidelity } from './roundtrip'

/** The first task's {@link TaskMarker} as the index records it. */
function firstTask(source: string): TaskMarker {
  const [task] = parseNote({ path: 'notes/a.md', source }).tasks
  return { markerOffset: task!.markerOffset, raw: task!.raw }
}

/**
 * Direct tests of the document state machine, no React. The full pipeline
 * (load, debounce, echo detection, conflict parking, protection) is covered
 * end-to-end through the hook in `use-note-document.test.tsx`; these pin the
 * session-level contracts the hook can't observe directly.
 */

interface Harness {
  snapshots: NoteSessionSnapshot[]
  writes: Array<{ path: string; contents: string }>
  guardedWrites: Array<{ path: string; contents: string; expectedRevision: string }>
  applied: string[]
  contents: Array<{ content: string; origin: string }>
  /** `null` deletes the file: subsequent reads throw the notFound AppError. */
  setDisk: (contents: string | null) => void
  readDisk: () => string | null
  /** While set, writes reject with this message (the save-failure seam). */
  failWrites: (message: string | null) => void
  session: ReturnType<typeof createNoteSession>
}

function harness(options?: {
  write?: false
  classify?: (markdown: string) => RoundTripFidelity
  /** `null` simulates a missing file: reads throw the notFound AppError. */
  disk?: string | null
  createIfMissing?: boolean
  missingSeed?: string
  reconcilePendingEditorInput?: () => void
  guardedWriteOutcome?: NoteRevisionWriteOutcome
  ownership?: NonNullable<NoteSessionIo['ownership']>
}): Harness {
  const snapshots: NoteSessionSnapshot[] = []
  const writes: Array<{ path: string; contents: string }> = []
  const guardedWrites: Array<{ path: string; contents: string; expectedRevision: string }> = []
  const applied: string[] = []
  const contents: Array<{ content: string; origin: string }> = []
  let disk = options?.disk === undefined ? '# Hello\n' : options.disk
  let writeFailure: string | null = null
  const session = createNoteSession({
    path: 'notes/a.md',
    io: {
      read: async () => {
        if (disk === null) {
          throw { kind: 'notFound', message: 'missing' } // AppError shape
        }
        return disk
      },
      write:
        options?.write === false
          ? null
          : async (path, contents) => {
              if (writeFailure !== null) {
                throw new Error(writeFailure)
              }
              writes.push({ path, contents })
              disk = contents
            },
      writeIfRevision:
        options?.write === false
          ? null
          : async (path, contents, expectedRevision) => {
              if (writeFailure !== null) {
                throw new Error(writeFailure)
              }
              if (options?.guardedWriteOutcome !== undefined) {
                return options.guardedWriteOutcome
              }
              if (disk === null) {
                return { kind: 'missing' as const }
              }
              const currentRevision = await hashContent(disk)
              if (currentRevision !== expectedRevision) {
                return { kind: 'stale' as const, currentRevision }
              }
              guardedWrites.push({ path, contents, expectedRevision })
              writes.push({ path, contents })
              disk = contents
              return {
                kind: 'written' as const,
                revision: await hashContent(contents),
                modifiedMs: 1,
              }
            },
      ownership: options?.ownership ?? null,
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
    writes,
    guardedWrites,
    applied,
    contents,
    setDisk: (contents) => {
      disk = contents
    },
    readDisk: () => disk,
    failWrites: (message) => {
      writeFailure = message
    },
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

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let settle: (value: Value) => void = () => {}
  const promise = new Promise<Value>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: (value) => settle(value) }
}

describe('createNoteSession', () => {
  it('claims native ownership before reading and releases only after the final flush', async () => {
    const claimed = deferred<void>()
    const events: string[] = []
    let writesAtRelease = -1
    let currentWriteCount = (): number => 0
    const h = harness({
      ownership: {
        ownerId: 'owner-1',
        claim: vi.fn(async () => {
          events.push('claim')
          await claimed.promise
        }),
        release: vi.fn(async () => {
          events.push('release')
          writesAtRelease = currentWriteCount()
        }),
      },
    })
    currentWriteCount = () => h.writes.length

    h.session.load()
    await Promise.resolve()
    expect(events).toEqual(['claim'])
    expect(h.snapshots.at(-1)?.status).toBe('loading')
    claimed.resolve()
    await settled()

    h.session.editorChanged('# Final\n')
    h.session.dispose()
    await settled()

    expect(events).toEqual(['claim', 'release'])
    expect(writesAtRelease).toBe(1)
    expect(h.session.ownerId).toBe('owner-1')
  })

  it('retains both ownership claims across a move until the old path is released', async () => {
    const claims: string[] = []
    const releases: string[] = []
    const h = harness({
      ownership: {
        ownerId: 'owner-1',
        claim: async (path) => {
          claims.push(path)
        },
        release: async (path) => {
          releases.push(path)
        },
      },
    })
    h.session.load()
    await settled()

    await h.session.retarget('notes/renamed.md')
    expect(claims).toEqual(['notes/a.md', 'notes/renamed.md'])
    expect(releases).toEqual([])

    // Rollback and retry reuse the deliberately-retained claims. Reclaiming
    // through IPC would make compensation needlessly fallible and could drop
    // the original claim if a response were lost.
    await h.session.retarget('notes/a.md')
    await h.session.retarget('notes/renamed.md')
    expect(claims).toEqual(['notes/a.md', 'notes/renamed.md'])

    await h.session.releaseRetargetedPath('notes/a.md')
    expect(releases).toEqual(['notes/a.md'])
  })

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

  it('does not re-emit identical snapshots', async () => {
    const { session, snapshots } = harness()
    session.load()
    await vi.advanceTimersByTimeAsync(0)

    const afterLoad = snapshots.length
    session.editorChanged('# Same edit\n')
    session.editorChanged('# Same edit\n')
    expect(snapshots.length).toBe(afterLoad + 1) // one dirty transition, not two
  })

  it('keepMine rewrites the file even when the conflict content equals the buffer', async () => {
    const { session, writes, snapshots, setDisk } = harness()
    session.load()
    await settled()

    // The user types X while the same X lands on disk externally (e.g. another
    // device synced the identical edit). The external content parks as a
    // conflict; "keep mine" must still persist deterministically.
    session.editorChanged('# Same on both\n')
    setDisk('# Same on both\n')
    session.externalChanged()
    await settled()
    expect(snapshots.at(-1)?.conflict).toBe('# Same on both\n')
    expect(writes).toEqual([]) // parked conflict paused the debounced save

    session.keepMine()
    await settled()
    expect(writes).toEqual([{ path: 'notes/a.md', contents: '# Same on both\n' }])
    expect(snapshots.at(-1)?.conflict).toBeNull()
    expect(snapshots.at(-1)?.dirty).toBe(false)
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
  const FM = '---\naliases:\n  - Old\n---\n'

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
    expect(h.writes.at(-1)?.contents).toBe('---\npinned: true\n---\n# Hello\n')

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
    expect(h.writes.at(-1)?.contents).toBe('---\nprivate: true\n---\n# Hello\n')

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
    expect(h.snapshots.at(-1)?.conflict).toBeNull()
    // Next save preserves the adopted header.
    h.session.editorChanged('# Hello!\n')
    await vi.runAllTimersAsync()
    expect(h.writes.at(-1)?.contents).toBe('---\naliases:\n  - Newer\n---\n# Hello!\n')
  })

  it('a frontmatter patch under a parked conflict lands with "keep mine"', async () => {
    // The rename coordinator's alias can arrive while a conflict is parked:
    // it rides the in-memory header (saves are paused, not dropped) and
    // persists when the user keeps their version. "Load theirs" discarding
    // it is the user explicitly choosing external content over the rename's
    // consequences — a disk write here would clobber the protected "theirs".
    const h = harness()
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Mine\n') // dirty
    h.setDisk('# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()
    expect(h.snapshots.at(-1)?.conflict).toBe('# Theirs\n')

    expect(h.session.updateFrontmatter({ aliases: ['Old Title'] })).toBe(true)
    await vi.runAllTimersAsync()
    expect(h.writes).toEqual([]) // paused, not written under the conflict

    h.session.keepMine()
    await vi.runAllTimersAsync()
    const written = h.writes.at(-1)?.contents ?? ''
    expect(written).toContain('Old Title') // the alias survived the conflict
    expect(written).toContain('# Mine')
  })

  it('a later external change refreshes a parked conflict snapshot', async () => {
    const h = harness()
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Mine\n')
    h.setDisk('# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()
    expect(h.snapshots.at(-1)?.conflict).toBe('# Theirs\n')

    h.setDisk('---\npinned: true\n---\n# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()
    expect(h.snapshots.at(-1)?.conflict).toBe('---\npinned: true\n---\n# Theirs\n')

    h.session.loadTheirs()
    expect(h.session.content()).toBe('---\npinned: true\n---\n# Theirs\n')
  })

  it('commitFrontmatter lands the patch immediately on a clean session', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await vi.runAllTimersAsync()
    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(true)
    // Flushed, not riding the save debounce.
    expect(h.writes.at(-1)?.contents).toBe('---\npinned: true\n---\n# Hello\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
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

  it('commitFrontmatter under a parked conflict writes through and refreshes the park', async () => {
    const h = harness()
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Mine\n')
    h.setDisk('# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()
    expect(h.snapshots.at(-1)?.conflict).toBe('# Theirs\n')

    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(true)
    // The contested content was patched and written — the index sees it now…
    expect(h.writes.at(-1)?.contents).toBe('---\npinned: true\n---\n# Theirs\n')
    // …the park holds the patched bytes, so "load theirs" adopts the pin…
    expect(h.snapshots.at(-1)?.conflict).toBe('---\npinned: true\n---\n# Theirs\n')
    h.session.loadTheirs()
    expect(h.session.content()).toBe('---\npinned: true\n---\n# Theirs\n')
  })

  it('commitFrontmatter under a conflict keeps the patch through "keep mine" too', async () => {
    const h = harness()
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Mine\n')
    h.setDisk('# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()

    await h.session.commitFrontmatter({ pinned: true })
    h.session.keepMine()
    await vi.runAllTimersAsync()
    expect(h.writes.at(-1)?.contents).toBe('---\npinned: true\n---\n# Mine\n')
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
    // and untouched: not a conflict — the buffer was never dirty.
    const h = harness({ disk: null, createIfMissing: true, missingSeed: SEED })
    h.session.load()
    await settled()

    h.setDisk('# Created elsewhere\n')
    h.session.externalChanged()
    await settled()

    const ready = h.snapshots.at(-1)
    expect(ready?.conflict).toBeNull()
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
    expect(ready?.conflict).toBeNull()
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
    h.session.externalChanged() // read fails: nothing to park a conflict against
    await settled()

    const after = h.snapshots.at(-1)
    expect(after?.conflict).toBeNull()
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
    const h = harness({ disk: '---\nid: 01abc\n---\n# Hello\n' })
    h.session.load()
    await vi.waitFor(() => expect(h.snapshots.at(-1)?.status).toBe('ready'))

    h.session.retarget('notes/hello.md')
    h.session.editorChanged('# Hello\n\nbody\n')
    await h.session.flush()
    // The exact header bytes ride along to the new path.
    expect(h.writes.at(-1)).toEqual({
      path: 'notes/hello.md',
      contents: '---\nid: 01abc\n---\n# Hello\n\nbody\n',
    })
  })
})

describe('revision-guarded body mutations', () => {
  it('reconciles pending native input before returning a fresh source revision', async () => {
    let target: ReturnType<typeof createNoteSession> | null = null
    const reconcilePendingEditorInput = vi.fn(() => {
      target?.editorChanged('# Latest native input\n')
    })
    const h = harness({ reconcilePendingEditorInput })
    target = h.session
    h.session.load()
    await settled()

    const fresh = await h.session.readFreshContent()

    expect(reconcilePendingEditorInput).toHaveBeenCalledOnce()
    expect(fresh).toEqual({
      source: '# Latest native input\n',
      revision: await hashContent('# Latest native input\n'),
    })
  })

  it('adopts authoritative disk bytes when clean and fails closed when dirty', async () => {
    const clean = harness({ disk: '# Before\n' })
    clean.session.load()
    await settled()
    clean.setDisk('# Changed elsewhere\n')

    await expect(clean.session.readFreshContent()).resolves.toMatchObject({
      source: '# Changed elsewhere\n',
    })
    expect(clean.applied.at(-1)).toBe('# Changed elsewhere\n')

    const dirty = harness({ disk: '# Before\n' })
    dirty.session.load()
    await settled()
    dirty.session.editorChanged('# Unsaved typing\n')
    dirty.setDisk('# Changed elsewhere\n')

    await expect(dirty.session.readFreshContent()).resolves.toBeNull()
    expect(dirty.session.content()).toBe('# Unsaved typing\n')
    expect(dirty.snapshots.at(-1)?.conflict).toBe('# Changed elsewhere\n')
    expect(dirty.writes).toEqual([])
  })

  it('fails closed when the live source changes while its revision is hashing', async () => {
    const source = '# Before\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    const fresh = h.session.readFreshContent(async () => {
      queueMicrotask(() => {
        queueMicrotask(() => h.session.editorChanged('# Changed while hashing\n'))
      })
      return source
    })

    await expect(fresh).resolves.toBeNull()
  })

  it('journals before applying, preserves exact frontmatter, and verifies the landed source', async () => {
    const source = '---\nid: 01abc\n---\n# Project\n\nOld line\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()
    const expectedRevision = await hashContent(source)
    const prepared = vi.fn(async () => {
      expect(h.writes).toEqual([])
      expect(h.session.content()).toBe(source)
    })

    const result = await h.session.commitBodyMutation({
      expectedRevision,
      transform: (body) => body.replace('Old line', 'New line'),
      onPrepared: prepared,
    })

    const afterSource = '---\nid: 01abc\n---\n# Project\n\nNew line\n'
    expect(prepared).toHaveBeenCalledWith({
      beforeSource: source,
      beforeRevision: expectedRevision,
      intendedSource: afterSource,
      intendedRevision: await hashContent(afterSource),
    })
    expect(result).toEqual({
      status: 'applied',
      beforeSource: source,
      beforeRevision: expectedRevision,
      afterSource,
      afterRevision: await hashContent(afterSource),
    })
    expect(h.writes.at(-1)?.contents).toBe(afterSource)
    expect(h.applied.at(-1)).toBe('# Project\n\nNew line\n')
  })

  it('applies on top of unsaved editor content and persists both changes together', async () => {
    const diskSource = '# Project\n\nBefore\n'
    const liveSource = '# Project\n\nBefore\n\nUser jot\n'
    const afterSource = '# Project\n\nAI edit\n\nUser jot\n'
    const h = harness({ disk: diskSource })
    h.session.load()
    await settled()
    h.session.editorChanged(liveSource)

    await expect(
      h.session.commitBodyMutation({
        expectedRevision: await hashContent(liveSource),
        transform: (body) => body.replace('Before', 'AI edit'),
        onPrepared: async (preparation) => {
          expect(preparation.beforeSource).toBe(liveSource)
          expect(preparation.intendedSource).toBe(afterSource)
        },
      }),
    ).resolves.toMatchObject({ status: 'applied', afterSource })
    expect(h.writes.at(-1)?.contents).toBe(afterSource)
    expect(h.guardedWrites).toEqual([
      {
        path: 'notes/a.md',
        contents: afterSource,
        expectedRevision: await hashContent(diskSource),
      },
    ])
  })

  it('does not overwrite a watcher-lagged external privacy change after journaling', async () => {
    const source = '# Project\n\nBefore\n'
    const privateSource = '---\nprivate: true\n---\n# Project\n\nExternal\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()
    const prepared = vi.fn(async () => {
      h.setDisk(privateSource)
    })

    await expect(
      h.session.commitBodyMutation({
        expectedRevision: await hashContent(source),
        transform: (body) => body.replace('Before', 'AI edit'),
        onPrepared: prepared,
      }),
    ).resolves.toEqual({
      status: 'stale',
      currentRevision: await hashContent(privateSource),
    })

    expect(prepared).toHaveBeenCalledOnce()
    expect(h.guardedWrites).toEqual([])
    expect(h.readDisk()).toBe(privateSource)
    expect(h.session.content()).toBe(source)
    expect(h.snapshots.at(-1)?.conflict).toBe(privateSource)
  })

  it('reports a post-write external race as uncertain and parks further saves', async () => {
    const source = '# Project\n\nBefore\n'
    const h = harness({
      disk: source,
      guardedWriteOutcome: { kind: 'contended', currentRevision: 'external-revision' },
    })
    h.session.load()
    await settled()

    await expect(
      h.session.commitBodyMutation({
        expectedRevision: await hashContent(source),
        transform: (body) => body.replace('Before', 'AI edit'),
        onPrepared: async () => {},
      }),
    ).resolves.toMatchObject({
      status: 'uncertain',
      reason: 'persisted_write_contended',
    })
    expect(h.snapshots.at(-1)?.conflict).not.toBeNull()
    expect(h.session.content()).toBe('# Project\n\nAI edit\n')
  })

  it('does not trash an open note after newer live typing arrives', async () => {
    const source = '# Created note\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()
    const trashResult = deferred<{ kind: 'trashed' }>()
    const trashStarted = deferred<void>()

    const trash = h.session.commitConditionalTrash({
      expectedRevision: await hashContent(source),
      trash: async () => {
        trashStarted.resolve()
        return await trashResult.promise
      },
    })
    await trashStarted.promise
    h.session.editorChanged('# Created note\n\nUser typing\n')
    trashResult.resolve({ kind: 'trashed' })

    await expect(trash).resolves.toEqual({ kind: 'contended', currentRevision: null })
    expect(h.session.content()).toBe('# Created note\n\nUser typing\n')
    expect(h.snapshots.at(-1)?.conflict).toBe('')
  })

  it('refreshes changed disk bytes before journaling an open-note mutation', async () => {
    const source = '# Project\n\nBefore\n'
    const privateSource = '---\nprivate: true\n---\n# Project\n\nBefore\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()
    h.setDisk(privateSource)
    const prepared = vi.fn(async () => {})

    await expect(
      h.session.commitBodyMutation({
        expectedRevision: await hashContent(source),
        transform: (body) => body.replace('Before', 'AI edit'),
        onPrepared: prepared,
      }),
    ).resolves.toEqual({
      status: 'stale',
      currentRevision: await hashContent(privateSource),
    })
    expect(prepared).not.toHaveBeenCalled()
    expect(h.guardedWrites).toEqual([])
    expect(h.session.content()).toBe(privateSource)
  })

  it('refuses a stale revision without journaling or changing the editor', async () => {
    const source = '# Project\n\nCurrent\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()
    const prepared = vi.fn(async () => {})

    await expect(
      h.session.commitBodyMutation({
        expectedRevision: await hashContent('# Project\n\nOlder\n'),
        transform: (body) => `${body}\nAI edit`,
        onPrepared: prepared,
      }),
    ).resolves.toEqual({ status: 'stale', currentRevision: await hashContent(source) })
    expect(prepared).not.toHaveBeenCalled()
    expect(h.applied).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('does not clobber typing that arrives while the journal is being persisted', async () => {
    const source = '# Project\n\nBefore\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()
    let releaseJournal: (() => void) | undefined
    const mutation = h.session.commitBodyMutation({
      expectedRevision: await hashContent(source),
      transform: (body) => body.replace('Before', 'AI edit'),
      onPrepared: async () => {
        await new Promise<void>((resolve) => {
          releaseJournal = resolve
        })
      },
    })
    await vi.waitFor(() => expect(releaseJournal).toBeTypeOf('function'))

    h.session.editorChanged('# Project\n\nUser kept typing\n')
    releaseJournal?.()

    await expect(mutation).resolves.toEqual({
      status: 'stale',
      currentRevision: await hashContent('# Project\n\nUser kept typing\n'),
    })
    expect(h.applied).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('refuses protected and conflicted sessions instead of using their disk state', async () => {
    const protectedHarness = harness({ disk: '# Unsafe\n', classify: () => 'lossy' })
    protectedHarness.session.load()
    await settled()
    await expect(
      protectedHarness.session.commitBodyMutation({
        expectedRevision: await hashContent('# Unsafe\n'),
        transform: () => '# Changed\n',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'protected' })

    const conflicted = harness({ disk: '# Before\n' })
    conflicted.session.load()
    await settled()
    conflicted.session.editorChanged('# Mine\n')
    conflicted.setDisk('# Theirs\n')
    conflicted.session.externalChanged()
    await vi.advanceTimersByTimeAsync(0)
    await expect(
      conflicted.session.commitBodyMutation({
        expectedRevision: await hashContent('# Mine\n'),
        transform: () => '# Changed\n',
      }),
    ).resolves.toEqual({ status: 'refused', reason: 'conflict' })
    expect(conflicted.writes).toEqual([])
  })

  it('rolls the editor back when persistence fails and no newer typing exists', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const source = '# Before\n'
      const h = harness({ disk: source })
      h.session.load()
      await settled()
      h.failWrites('disk full')

      await expect(
        h.session.commitBodyMutation({
          expectedRevision: await hashContent(source),
          transform: () => '# AI edit\n',
          onPrepared: async () => {},
        }),
      ).rejects.toThrow('disk full')
      expect(h.session.content()).toBe(source)
      expect(h.applied.at(-1)).toBe(source)
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('commitTaskToggle', () => {
  it('toggles the marker while preserving unsaved edits, and reflects it in the editor', async () => {
    const source = '# Todo\n\n+ [ ] buy milk\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    // The user appends a line below the task — unsaved when the toggle arrives.
    h.session.editorChanged('# Todo\n\n+ [ ] buy milk\n\njot\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(true)

    const applied = await h.session.commitTaskToggle(firstTask(source))
    expect(applied).toBe(true)
    // The write carries both the unsaved edit and the toggled marker.
    expect(h.writes.at(-1)?.contents).toBe('# Todo\n\n+ [x] buy milk\n\njot\n')
    // The open editor was updated to show the toggled checkbox.
    expect(h.applied.at(-1)).toBe('# Todo\n\n+ [x] buy milk\n\njot\n')
  })

  it('toggles a clean note (frontmatter offset intact) and writes only the marker', async () => {
    const source = '---\nid: 01abc\n---\n+ [ ] ship it\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    expect(await h.session.commitTaskToggle(firstTask(source))).toBe(true)
    expect(h.writes.at(-1)?.contents).toBe('---\nid: 01abc\n---\n+ [x] ship it\n')
  })

  it('refuses (returns false) a protected note rather than write', async () => {
    const h = harness({ disk: '+ [ ] x\n', classify: () => 'lossy' })
    h.session.load()
    await settled()

    expect(await h.session.commitTaskToggle(firstTask('+ [ ] x\n'))).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('refuses (returns false) while a conflict is parked', async () => {
    const source = '+ [ ] x\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.session.editorChanged('+ [ ] x edited\n') // dirty
    h.setDisk('+ [ ] x external\n')
    h.session.externalChanged() // parks a conflict (dirty + divergent disk)
    await settled()

    expect(await h.session.commitTaskToggle(firstTask(source))).toBe(false)
  })

  it('reverts the toggle and surfaces the error when the write fails', async () => {
    const source = '+ [ ] x\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.failWrites('disk full')
    await expect(h.session.commitTaskToggle(firstTask(source))).rejects.toThrow('disk full')
    // Transactional: nothing persisted, so the buffer and the editor revert to
    // the un-toggled line (no divergence with the rolled-back Tasks list).
    expect(h.session.content()).toBe('+ [ ] x\n')
    expect(h.applied.at(-1)).toBe('+ [ ] x\n')
    expect(h.snapshots.at(-1)?.error).toBeNull()
  })

  it('propagates TaskStaleError when the task line is gone', async () => {
    const source = '+ [ ] gone\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.session.editorChanged('+ [ ] something else entirely\n')
    await expect(h.session.commitTaskToggle(firstTask(source))).rejects.toBeInstanceOf(
      TaskStaleError,
    )
  })
})

describe('commitTaskEdit', () => {
  it('rewrites the content while preserving unsaved edits, reflected in the editor', async () => {
    const source = '# Todo\n\n+ [ ] buy milk\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.session.editorChanged('# Todo\n\n+ [ ] buy milk\n\njot\n') // unsaved when the edit arrives
    expect(await h.session.commitTaskEdit(firstTask(source), 'buy oat milk')).toBe(true)
    expect(h.writes.at(-1)?.contents).toBe('# Todo\n\n+ [ ] buy oat milk\n\njot\n')
    expect(h.applied.at(-1)).toBe('# Todo\n\n+ [ ] buy oat milk\n\njot\n')
  })

  it('keeps a checked marker when editing a completed task', async () => {
    const source = '+ [x] done\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    expect(await h.session.commitTaskEdit(firstTask(source), 'really done')).toBe(true)
    expect(h.writes.at(-1)?.contents).toBe('+ [x] really done\n')
  })

  it('refuses (returns false) a protected note rather than write', async () => {
    const h = harness({ disk: '+ [ ] x\n', classify: () => 'lossy' })
    h.session.load()
    await settled()

    expect(await h.session.commitTaskEdit(firstTask('+ [ ] x\n'), 'y')).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('reverts and surfaces the error when the write fails', async () => {
    const source = '+ [ ] x\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.failWrites('disk full')
    await expect(h.session.commitTaskEdit(firstTask(source), 'y')).rejects.toThrow('disk full')
    expect(h.session.content()).toBe('+ [ ] x\n')
    expect(h.applied.at(-1)).toBe('+ [ ] x\n')
    expect(h.snapshots.at(-1)?.error).toBeNull()
  })

  it('propagates TaskStaleError when the task line is gone', async () => {
    const source = '+ [ ] gone\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.session.editorChanged('+ [ ] something else entirely\n')
    await expect(h.session.commitTaskEdit(firstTask(source), 'y')).rejects.toBeInstanceOf(
      TaskStaleError,
    )
  })
})

describe('commitTaskRemove', () => {
  it('removes the task line while preserving unsaved edits, reflected in the editor', async () => {
    const source = '+ [ ] buy milk\n+ [ ] call mum\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    expect(await h.session.commitTaskRemove(firstTask(source))).toBe(true)
    expect(h.writes.at(-1)?.contents).toBe('+ [ ] call mum\n')
    expect(h.applied.at(-1)).toBe('+ [ ] call mum\n')
  })

  it('refuses (returns false) while a conflict is parked', async () => {
    const source = '+ [ ] x\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.session.editorChanged('+ [ ] x edited\n')
    h.setDisk('+ [ ] x external\n')
    h.session.externalChanged()
    await settled()

    expect(await h.session.commitTaskRemove(firstTask(source))).toBe(false)
  })

  it('reverts and surfaces the error when the write fails', async () => {
    const source = '+ [ ] x\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.failWrites('disk full')
    await expect(h.session.commitTaskRemove(firstTask(source))).rejects.toThrow('disk full')
    expect(h.session.content()).toBe('+ [ ] x\n')
    expect(h.applied.at(-1)).toBe('+ [ ] x\n')
  })
})

describe('commitTaskToBullet', () => {
  it('strips the marker to a plain bullet while preserving unsaved edits', async () => {
    const source = '+ [ ] buy milk\n+ [ ] call mum\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.session.editorChanged('+ [ ] buy milk\n+ [ ] call mum\n\njot\n') // unsaved when it arrives
    expect(await h.session.commitTaskToBullet(firstTask(source))).toBe(true)
    expect(h.writes.at(-1)?.contents).toBe('+ buy milk\n+ [ ] call mum\n\njot\n')
    expect(h.applied.at(-1)).toBe('+ buy milk\n+ [ ] call mum\n\njot\n')
  })

  it('drops a checked marker too', async () => {
    const source = '+ [x] done\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    expect(await h.session.commitTaskToBullet(firstTask(source))).toBe(true)
    expect(h.writes.at(-1)?.contents).toBe('+ done\n')
  })

  it('propagates TaskStaleError when the task line is gone', async () => {
    const source = '+ [ ] gone\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.session.editorChanged('+ [ ] something else entirely\n')
    await expect(h.session.commitTaskToBullet(firstTask(source))).rejects.toBeInstanceOf(
      TaskStaleError,
    )
  })
})
