import { parseNote, TaskStaleError, type TaskMarker } from '@reflect/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoteSession, type NoteSessionSnapshot } from './note-session'
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
  applied: string[]
  contents: Array<{ content: string; origin: string }>
  /** `null` deletes the file: subsequent reads throw the notFound AppError. */
  setDisk: (contents: string | null) => void
  /** While set, writes reject with this message (the save-failure seam). */
  failWrites: (message: string | null) => void
  session: ReturnType<typeof createNoteSession>
}

function harness(options?: {
  path?: string
  write?: false
  classify?: (markdown: string) => RoundTripFidelity
  /** `null` simulates a missing file: reads throw the notFound AppError. */
  disk?: string | null
  createIfMissing?: boolean
  recreateAfterRemoval?: boolean
  missingSeed?: string
  reconcilePendingEditorInput?: () => void
  readOverride?: (contents: string | null) => Promise<string | null>
  beforeWrite?: (
    path: string,
    contents: string,
    expected: string | null,
  ) => Promise<void>
  afterWrite?: () => Promise<void>
}): Harness {
  const snapshots: NoteSessionSnapshot[] = []
  const writes: Array<{ path: string; contents: string }> = []
  const applied: string[] = []
  const contents: Array<{ content: string; origin: string }> = []
  let disk = options?.disk === undefined ? '# Hello\n' : options.disk
  let writeFailure: string | null = null
  const session = createNoteSession({
    path: options?.path ?? 'notes/a.md',
    io: {
      read: async () => {
        const contents = options?.readOverride === undefined
          ? disk
          : await options.readOverride(disk)
        if (contents === null) {
          throw { kind: 'notFound', message: 'missing' } // AppError shape
        }
        return contents
      },
      write:
        options?.write === false
          ? null
          : async (path, contents, expected) => {
              await options?.beforeWrite?.(path, contents, expected)
              if (writeFailure !== null) {
                throw new Error(writeFailure)
              }
              if (disk !== expected) {
                return false
              }
              writes.push({ path, contents })
              disk = contents
              await options?.afterWrite?.()
              return true
            },
    },
    classify: options?.classify ?? (() => 'exact'),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
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
    recreateAfterRemoval: options?.recreateAfterRemoval,
    missingSeed: options?.missingSeed,
    saveDebounceMs: 10,
  })
  return {
    snapshots,
    writes,
    applied,
    contents,
    setDisk: (contents) => {
      disk = contents
    },
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
    expect(writes).toEqual([
      { path: 'notes/a.md', contents: '# 🧠 Business ideas\n' },
    ])
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

  it('commitFrontmatter rolls back and rejects when its exact save fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await vi.runAllTimersAsync()
    h.failWrites('disk full')

    await expect(h.session.commitFrontmatter({ pinned: true })).rejects.toThrow('disk full')
    expect(h.session.content()).toBe('# Hello\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
    expect(h.writes).toEqual([])
    consoleError.mockRestore()
  })

  it('commitFrontmatter accepts CAS convergence to the patched live document', async () => {
    let h: Harness
    h = harness({
      disk: '# Hello\n',
      beforeWrite: async (_path, contents) => {
        h.setDisk(contents)
      },
    })
    h.session.load()
    await vi.runAllTimersAsync()

    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(true)
    expect(h.session.content()).toBe('---\npinned: true\n---\n# Hello\n')
    expect(h.snapshots.at(-1)?.conflict).toBeNull()
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('commitFrontmatter rolls back when its CAS reread is divergent', async () => {
    let h: Harness
    h = harness({
      disk: '# Hello\n',
      beforeWrite: async () => {
        h.setDisk('# External\n')
      },
    })
    h.session.load()
    await vi.runAllTimersAsync()

    await expect(h.session.commitFrontmatter({ pinned: true })).rejects.toThrow(
      /frontmatter update could not be saved/,
    )
    expect(h.session.content()).toBe('# Hello\n')
    expect(h.snapshots.at(-1)?.conflict).toBe('# External\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
    expect(h.writes).toEqual([])
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

  it('commitFrontmatter clears a conflict when CAS rereads the patched live document', async () => {
    let h: Harness
    h = harness({
      beforeWrite: async () => {
        h.setDisk('---\npinned: true\n---\n# Mine\n')
      },
    })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Mine\n')
    h.setDisk('# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()
    expect(h.snapshots.at(-1)?.conflict).toBe('# Theirs\n')

    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(true)
    expect(h.session.content()).toBe('---\npinned: true\n---\n# Mine\n')
    expect(h.snapshots.at(-1)?.conflict).toBeNull()
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('commitFrontmatter preserves and acknowledges a newer patched watcher upsert', async () => {
    const newer = '---\npinned: true\n---\n# Newer\n'
    let h: Harness
    h = harness({
      afterWrite: async () => {
        h.setDisk(newer)
        h.session.externalChanged()
        await Promise.resolve()
      },
    })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Mine\n')
    h.setDisk('# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()

    await expect(h.session.commitFrontmatter({ pinned: true })).resolves.toBe(true)
    expect(h.snapshots.at(-1)?.conflict).toBe(newer)
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
    h.session.loadTheirs()
    expect(h.session.content()).toBe(newer)
  })

  it('a stale watcher read cannot overwrite the later privacy CAS reconciliation', async () => {
    const newer = '---\nprivate: true\n---\n# Newer\n'
    let deferWatcherRead = false
    let markWatcherReadStarted: () => void = () => {}
    const watcherReadStarted = new Promise<void>((resolve) => {
      markWatcherReadStarted = resolve
    })
    let releaseWatcherRead: () => void = () => {}
    const watcherReadGate = new Promise<void>((resolve) => {
      releaseWatcherRead = resolve
    })
    let markWatcherReadReturned: () => void = () => {}
    const watcherReadReturned = new Promise<void>((resolve) => {
      markWatcherReadReturned = resolve
    })
    let h: Harness
    h = harness({
      readOverride: async (contents) => {
        if (!deferWatcherRead) {
          return contents
        }
        deferWatcherRead = false
        markWatcherReadStarted()
        await watcherReadGate
        markWatcherReadReturned()
        return contents
      },
      afterWrite: async () => {
        deferWatcherRead = true
        h.session.externalChanged()
        await watcherReadStarted
        h.setDisk(newer)
      },
    })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Mine\n')
    h.setDisk('# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()

    await expect(h.session.commitFrontmatter({ private: true })).resolves.toBe(true)
    expect(h.snapshots.at(-1)?.conflict).toBe(newer)

    releaseWatcherRead()
    await watcherReadReturned
    await vi.advanceTimersByTimeAsync(0)
    expect(h.snapshots.at(-1)?.conflict).toBe(newer)
    h.session.loadTheirs()
    expect(h.session.content()).toBe(newer)
  })

  it('commitFrontmatter does not overwrite or acknowledge a newer unpatched watcher upsert', async () => {
    const newer = '# Newer\n'
    let h: Harness
    h = harness({
      afterWrite: async () => {
        h.setDisk(newer)
        h.session.externalChanged()
        await Promise.resolve()
      },
    })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Mine\n')
    h.setDisk('# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()

    await expect(h.session.commitFrontmatter({ pinned: true })).rejects.toThrow(
      /changed again/,
    )
    expect(h.session.content()).toBe('# Mine\n')
    expect(h.snapshots.at(-1)?.conflict).toBe(newer)
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
  })

  it('commitFrontmatter preserves a watcher removal and does not acknowledge persistence', async () => {
    let h: Harness
    h = harness({
      afterWrite: async () => {
        h.setDisk(null)
        h.session.externalRemoved()
      },
    })
    h.session.load()
    await vi.runAllTimersAsync()
    h.session.editorChanged('# Mine\n')
    h.setDisk('# Theirs\n')
    h.session.externalChanged()
    await vi.runAllTimersAsync()

    await expect(h.session.commitFrontmatter({ pinned: true })).rejects.toThrow(
      /changed again/,
    )
    expect(h.session.content()).toBe('# Mine\n')
    expect(h.snapshots.at(-1)?.missing).toBe(true)
    expect(h.snapshots.at(-1)?.saveBlockedByRemoval).toBe(true)
    expect(h.snapshots.at(-1)?.conflict).toBeNull()
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

    expect(h.writes).toEqual([
      { path: 'notes/a.md', contents: '# My Note\n\nFirst line.\n' },
    ])
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

  it('parks an adopted note after external removal without dropping its buffer', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()

    h.setDisk(null) // deleted out from under us
    h.session.externalRemoved()
    await settled()

    const after = h.snapshots.at(-1)
    expect(after?.status).toBe('ready')
    expect(after?.error).toBeNull()
    expect(after?.missing).toBe(true)
    expect(h.applied).toEqual([]) // nothing pushed into the editor

    // The buffer remains editable and dirty, but debounce, explicit flush, and
    // teardown all stay parked rather than recreating an adopted path.
    h.session.editorChanged('# Hello again\n')
    await settled()
    expect(h.session.content()).toBe('# Hello again\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
    expect(h.writes).toEqual([])

    await h.session.flush()
    expect(h.session.updateFrontmatter({ pinned: true })).toBe(false)
    await expect(h.session.commitFrontmatter({ pinned: true })).rejects.toThrow(
      /removed from disk/,
    )
    await expect(h.session.commitBodyAppend('Blocked append')).resolves.toBe(false)
    h.session.dispose()
    await settled()
    expect(h.writes).toEqual([])
  })

  it('an external removal cancels an adopted note’s pending debounce', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()

    h.session.editorChanged('# Unsaved\n')
    h.setDisk(null)
    h.session.externalRemoved()
    await settled()

    const after = h.snapshots.at(-1)
    expect(after?.conflict).toBeNull()
    expect(after?.dirty).toBe(true)
    expect(after?.missing).toBe(true)
    expect(h.session.content()).toBe('# Unsaved\n')
    expect(h.writes).toEqual([])
  })

  it('a daily note may recreate after external removal', async () => {
    const path = 'daily/2026-07-14.md'
    const h = harness({
      path,
      disk: '# Hello\n',
      createIfMissing: true,
      recreateAfterRemoval: true,
    })
    h.session.load()
    await settled()

    h.setDisk(null)
    h.session.externalRemoved()
    h.session.editorChanged('# Hello again\n')
    await settled()

    expect(h.writes).toEqual([{ path, contents: '# Hello again\n' }])
    expect(h.snapshots.at(-1)?.missing).toBe(false)
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
  })

  it('an existing ULID route does not inherit recreation from lazy-open policy', async () => {
    const path = 'notes/01arz3ndektsv4rrffq69g5fav.md'
    const h = harness({ path, disk: '# Existing\n', createIfMissing: true })
    h.session.load()
    await settled()

    h.setDisk(null)
    h.session.externalRemoved()
    h.session.editorChanged('# Must stay buffered\n')
    await settled()

    expect(h.writes).toEqual([])
    expect(h.snapshots.at(-1)?.missing).toBe(true)
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
  })

  it('a fresh missing ULID may create once but not recreate after removal', async () => {
    const path = 'notes/01arz3ndektsv4rrffq69g5fav.md'
    const h = harness({ path, disk: null, createIfMissing: true })
    h.session.load()
    await settled()

    h.session.editorChanged('# First save\n')
    await settled()
    expect(h.writes).toEqual([{ path, contents: '# First save\n' }])

    h.setDisk(null)
    h.session.externalRemoved()
    h.session.editorChanged('# Do not recreate\n')
    await settled()
    expect(h.writes).toEqual([{ path, contents: '# First save\n' }])
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
  })

  it('does not retry an absent fresh path after a create landed but its response failed', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const path = 'notes/01arz3ndektsv4rrffq69g5fav.md'
    const h = harness({
      path,
      disk: null,
      createIfMissing: true,
      afterWrite: async () => {
        throw new Error('response lost')
      },
    })
    h.session.load()
    await settled()

    h.session.editorChanged('# First dispatch\n')
    await settled()
    expect(h.writes).toEqual([{ path, contents: '# First dispatch\n' }])
    expect(h.snapshots.at(-1)?.saveBlockedByRemoval).toBe(true)

    // A watcher echo proves the ambiguous command landed. Identical bytes are
    // an acknowledgement, not a second version requiring conflict UI.
    h.session.externalChanged()
    await settled()
    expect(h.snapshots.at(-1)?.conflict).toBeNull()
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
    expect(h.snapshots.at(-1)?.saveBlockedByRemoval).toBe(false)
    expect(h.snapshots.at(-1)?.error).toBeNull()

    // The command may really have landed before transport failed. If that file
    // is then removed, another edit/flush must not treat the route as fresh.
    h.setDisk(null)
    h.session.editorChanged('# Must remain buffered\n')
    await h.session.flush()
    await settled()

    expect(h.writes).toEqual([{ path, contents: '# First dispatch\n' }])
    expect(h.snapshots.at(-1)?.saveBlockedByRemoval).toBe(true)
    consoleError.mockRestore()
  })

  it('parks a fresh route removed after its first create lands but before the response', async () => {
    const responseGate: { release: (() => void) | null } = { release: null }
    let writeLanded: (() => void) | null = null
    const landed = new Promise<void>((resolve) => {
      writeLanded = resolve
    })
    const path = 'notes/01arz3ndektsv4rrffq69g5fav.md'
    const h = harness({
      path,
      disk: null,
      createIfMissing: true,
      afterWrite: () =>
        new Promise<void>((resolve) => {
          responseGate.release = resolve
          writeLanded?.()
        }),
    })
    h.session.load()
    await settled()

    h.session.editorChanged('# First save\n')
    const flush = h.session.flush()
    await landed
    h.setDisk(null)
    h.session.externalRemoved()
    responseGate.release?.()
    await flush

    expect(h.snapshots.at(-1)?.missing).toBe(true)
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
    expect(h.writes).toEqual([{ path, contents: '# First save\n' }])

    h.session.editorChanged('# Must remain buffered\n')
    await settled()
    expect(h.writes).toEqual([{ path, contents: '# First save\n' }])
  })

  it('retargeting revokes an unclaimed fresh-path creation capability', async () => {
    const h = harness({
      path: 'notes/01arz3ndektsv4rrffq69g5fav.md',
      disk: null,
      createIfMissing: true,
    })
    h.session.load()
    await settled()

    h.session.retarget('notes/retargeted.md')
    h.session.editorChanged('# Must not appear at the new path\n')
    await settled()

    expect(h.writes).toEqual([])
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
  })

  it('does not recreate an adopted note deleted after its save was dispatched', async () => {
    const writeGate: { release: (() => void) | null } = { release: null }
    let writeStarted: (() => void) | null = null
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve
    })
    const h = harness({
      disk: '# Existing\n',
      beforeWrite: () =>
        new Promise<void>((resolve) => {
          writeGate.release = resolve
          writeStarted?.()
        }),
    })
    h.session.load()
    await settled()

    h.session.editorChanged('# Edited\n')
    const flush = h.session.flush()
    await started
    h.setDisk(null)
    writeGate.release?.()
    await flush

    expect(h.writes).toEqual([])
    expect(h.snapshots.at(-1)?.missing).toBe(true)
    expect(h.snapshots.at(-1)?.dirty).toBe(true)
  })

  it('unparks an adopted buffer only after an upsert can be read', async () => {
    const h = harness({ disk: '# Hello\n' })
    h.session.load()
    await settled()

    h.setDisk(null)
    h.session.externalRemoved()
    h.session.editorChanged('# Unsaved\n')
    await settled()
    expect(h.writes).toEqual([])

    h.setDisk('# Hello\n')
    h.session.externalChanged()
    await settled()

    expect(h.writes).toEqual([{ path: 'notes/a.md', contents: '# Unsaved\n' }])
    expect(h.snapshots.at(-1)?.missing).toBe(false)
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
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

describe('commitExactContentReplacement', () => {
  it('updates the live editor and save state, and supports the inverse rollback', async () => {
    const before = '---\nid: 01abc\n---\n# Source\n\n[[notes/old]]\n'
    const after = '---\nid: 01abc\n---\n# Source\n\n[[notes/new]]\n'
    const h = harness({ disk: before })
    h.session.load()
    await settled()

    expect(await h.session.commitExactContentReplacement(before, after)).toBe(true)
    expect(h.session.content()).toBe(after)
    expect(h.applied.at(-1)).toBe('# Source\n\n[[notes/new]]\n')
    expect(h.writes.at(-1)).toEqual({ path: 'notes/a.md', contents: after })
    expect(h.contents.at(-1)).toEqual({ content: after, origin: 'saved' })
    expect(h.snapshots.at(-1)?.dirty).toBe(false)

    expect(await h.session.commitExactContentReplacement(after, before)).toBe(true)
    expect(h.session.content()).toBe(before)
    expect(h.applied.at(-1)).toBe('# Source\n\n[[notes/old]]\n')
    expect(h.writes.at(-1)).toEqual({ path: 'notes/a.md', contents: before })
  })

  it('accepts a refused CAS when the reread is already the prepared replacement', async () => {
    const before = '[[notes/old]]\n'
    const after = '[[notes/new]]\n'
    let h: Harness
    h = harness({
      disk: before,
      beforeWrite: async (_path, contents) => {
        // Another writer lands the exact prepared bytes before this session's
        // CAS reaches its comparison. The refusal is convergence, not failure.
        h.setDisk(contents)
      },
    })
    h.session.load()
    await settled()

    await expect(h.session.commitExactContentReplacement(before, after)).resolves.toBe(true)
    expect(h.session.content()).toBe(after)
    expect(h.applied.at(-1)).toBe(after)
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('refuses a dirty or mismatched live document without writing the rewrite', async () => {
    const h = harness({ disk: '[[notes/old]]\n' })
    h.session.load()
    await settled()

    h.session.editorChanged('Unsaved thought\n[[notes/old]]\n')
    expect(
      await h.session.commitExactContentReplacement(
        '[[notes/old]]\n',
        '[[notes/new]]\n',
      ),
    ).toBe(false)
    expect(h.session.content()).toBe('Unsaved thought\n[[notes/old]]\n')
    expect(h.applied).toEqual([])
    expect(h.writes).toEqual([])
    h.session.discard()
  })

  it('reconciles pending native input before checking the expected content', async () => {
    let target: ReturnType<typeof createNoteSession> | null = null
    const reconcilePendingEditorInput = vi.fn(() => {
      target?.editorChanged('Native input\n[[notes/old]]\n')
    })
    const h = harness({ disk: '[[notes/old]]\n', reconcilePendingEditorInput })
    target = h.session
    h.session.load()
    await settled()

    expect(
      await h.session.commitExactContentReplacement(
        '[[notes/old]]\n',
        '[[notes/new]]\n',
      ),
    ).toBe(false)
    expect(reconcilePendingEditorInput).toHaveBeenCalledOnce()
    expect(h.session.content()).toBe('Native input\n[[notes/old]]\n')
    expect(h.writes).toEqual([])
    h.session.discard()
  })

  it('refuses loading, protected, conflicted, and removed sessions', async () => {
    const loading = harness({ disk: 'before\n' })
    expect(await loading.session.commitExactContentReplacement('before\n', 'after\n')).toBe(
      false,
    )

    const protectedNote = harness({ disk: 'before\n', classify: () => 'lossy' })
    protectedNote.session.load()
    await settled()
    expect(
      await protectedNote.session.commitExactContentReplacement('before\n', 'after\n'),
    ).toBe(false)

    const conflicted = harness({ disk: 'before\n' })
    conflicted.session.load()
    await settled()
    conflicted.session.editorChanged('mine\n')
    conflicted.setDisk('theirs\n')
    conflicted.session.externalChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(await conflicted.session.commitExactContentReplacement('mine\n', 'after\n')).toBe(
      false,
    )
    conflicted.session.discard()

    const removed = harness({ disk: 'before\n' })
    removed.session.load()
    await settled()
    removed.setDisk(null)
    removed.session.externalRemoved()
    expect(await removed.session.commitExactContentReplacement('before\n', 'after\n')).toBe(
      false,
    )
    expect(removed.writes).toEqual([])
  })

  it('restores the editor when persistence fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness({ disk: '[[notes/old]]\n' })
    h.session.load()
    await settled()
    h.failWrites('disk full')

    await expect(
      h.session.commitExactContentReplacement('[[notes/old]]\n', '[[notes/new]]\n'),
    ).rejects.toThrow('disk full')
    expect(h.session.content()).toBe('[[notes/old]]\n')
    expect(h.applied.at(-1)).toBe('[[notes/old]]\n')
    expect(h.snapshots.at(-1)?.dirty).toBe(false)
    consoleError.mockRestore()
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

describe('commitBodyAppend', () => {
  it('accepts a queued attempt when the prior save already landed its freshest body', async () => {
    let markFirstWriteStarted: () => void = () => {}
    const firstWriteStarted = new Promise<void>((resolve) => {
      markFirstWriteStarted = resolve
    })
    let releaseFirstWrite: () => void = () => {}
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let writeCount = 0
    const h = harness({
      disk: '# Base\n',
      beforeWrite: async () => {
        writeCount += 1
        if (writeCount === 1) {
          markFirstWriteStarted()
          await firstWriteGate
        }
      },
    })
    h.session.load()
    await settled()

    h.session.editorChanged('# Pending\n')
    const priorFlush = h.session.flush()
    await firstWriteStarted
    const firstAppend = h.session.commitBodyAppend('First')
    const secondAppend = h.session.commitBodyAppend('Second')
    const freshest = h.session.content()

    releaseFirstWrite()
    await expect(Promise.all([priorFlush, firstAppend, secondAppend])).resolves.toEqual([
      undefined,
      true,
      true,
    ])
    expect(h.writes).toHaveLength(2)
    expect(h.writes.at(-1)?.contents).toBe(freshest)
    expect(h.session.content()).toBe(freshest)
    expect(h.snapshots.at(-1)?.dirty).toBe(false)

    await h.session.flush()
    expect(h.writes).toHaveLength(2)
    expect(h.session.content()).toBe(freshest)
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

  it('preserves a newer editor change when the transactional write fails in flight', async () => {
    const source = '+ [ ] x\n'
    let markWriteStarted: () => void = () => {}
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve
    })
    let releaseWrite: () => void = () => {}
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const h = harness({
      disk: source,
      beforeWrite: async () => {
        markWriteStarted()
        await writeGate
      },
    })
    h.session.load()
    await settled()
    h.failWrites('disk full')

    const toggling = h.session.commitTaskToggle(firstTask(source))
    await writeStarted
    h.session.editorChanged('+ [x] x\nnewer user edit\n')
    releaseWrite()

    await expect(toggling).rejects.toThrow('disk full')
    expect(h.session.content()).toBe('+ [x] x\nnewer user edit\n')
    expect(h.applied.at(-1)).toBe('+ [x] x\n')
  })

  it('propagates TaskStaleError when the task line is gone', async () => {
    const source = '+ [ ] gone\n'
    const h = harness({ disk: source })
    h.session.load()
    await settled()

    h.session.editorChanged('+ [ ] something else entirely\n')
    await expect(h.session.commitTaskToggle(firstTask(source))).rejects.toBeInstanceOf(TaskStaleError)
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
