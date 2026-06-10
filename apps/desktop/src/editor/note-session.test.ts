import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNoteSession, type NoteSessionSnapshot } from './note-session'
import type { RoundTripFidelity } from './roundtrip'

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
  setDisk: (contents: string) => void
  session: ReturnType<typeof createNoteSession>
}

function harness(options?: {
  write?: false
  classify?: (markdown: string) => RoundTripFidelity
  /** `null` simulates a missing file: reads throw the notFound AppError. */
  disk?: string | null
  createIfMissing?: boolean
  missingSeed?: string
}): Harness {
  const snapshots: NoteSessionSnapshot[] = []
  const writes: Array<{ path: string; contents: string }> = []
  const applied: string[] = []
  const contents: Array<{ content: string; origin: string }> = []
  let disk = options?.disk === undefined ? '# Hello\n' : options.disk
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
              writes.push({ path, contents })
              disk = contents
            },
    },
    classify: options?.classify ?? (() => 'exact'),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    applyContent: (markdown) => {
      applied.push(markdown)
    },
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
    applied,
    contents,
    setDisk: (contents) => {
      disk = contents
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
      markdown.includes('- [ ]') ? 'lossy' : 'exact'
    const { session, snapshots, setDisk } = harness({ classify: lossyWhenTasks })
    session.load()
    await settled()
    expect(snapshots.at(-1)?.protected).toBe(false)

    setDisk('- [ ] now has tasks\n')
    session.externalChanged()
    await settled()
    expect(snapshots.at(-1)?.protected).toBe(true)
    expect(snapshots.at(-1)?.initialContent).toBe('- [ ] now has tasks\n')
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
      disk: `${FM}- [ ] lossy body\n`,
      classify: (markdown) => (markdown.includes('- [ ]') ? 'lossy' : 'exact'),
    })
    h.session.load()
    await vi.runAllTimersAsync()
    const ready = h.snapshots.at(-1)
    expect(ready?.protected).toBe(true)
    // The read-only view's job is honest display of a file we refuse to
    // touch — hiding the frontmatter would misrepresent it.
    expect(ready?.initialContent).toBe(`${FM}- [ ] lossy body\n`)
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
    expect(h.contents[1].content).toBe(`${FM}# Renamed\n`)
  })
})

describe('missing-note seed (new ordinary notes)', () => {
  const SEED = '# Untitled\n'

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
    // The rename tracker baselines on the real (empty) disk content, so the
    // first authored title is a birth, not a rename from "Untitled".
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
})
