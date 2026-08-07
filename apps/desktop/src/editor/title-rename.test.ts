import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTitleRenameTracker, type TitleRename } from './title-rename'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function tracked(options?: { canFire?: () => boolean }) {
  const renames: TitleRename[] = []
  const tracker = createTitleRenameTracker({
    path: 'notes/x.md',
    quietMs: 5000,
    onRename: (rename) => {
      renames.push(rename)
    },
    canFire: options?.canFire,
  })
  return { tracker, renames }
}

describe('createTitleRenameTracker', () => {
  it('fires after the quiet period once a saved title differs from baseline', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# Old Title\n')
    tracker.saved('# New Title\n')
    expect(renames).toEqual([])
    vi.advanceTimersByTime(5000)
    expect(renames).toEqual([{ from: 'Old Title', to: 'New Title', previousAutoAlias: null }])
  })

  it('re-arms on every save: intermediate titles never fire', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# My Note\n')
    tracker.saved('# My N\n') // mid-edit garbage state
    vi.advanceTimersByTime(4000)
    tracker.saved('# My Notebook\n')
    vi.advanceTimersByTime(4999)
    expect(renames).toEqual([])
    vi.advanceTimersByTime(1)
    expect(renames).toHaveLength(1)
    expect(renames[0]).toMatchObject({ from: 'My Note', to: 'My Notebook' })
  })

  it('settle fires the pending rename immediately', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.settle()
    expect(renames).toHaveLength(1)
    tracker.settle() // nothing pending — no double fire
    expect(renames).toHaveLength(1)
  })

  it('a reverted title clears the pending rename', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.saved('# A\n') // changed their mind
    vi.advanceTimersByTime(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('a pure case change is not a rename (resolution is case-insensitive)', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# my note\n')
    tracker.saved('# My Note\n')
    vi.advanceTimersByTime(10_000)
    expect(renames).toEqual([])
  })

  it('external content re-baselines without firing and resets the alias chain', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.baseline('# C\n') // external edit adopted mid-quiet-period
    vi.advanceTimersByTime(10_000)
    expect(renames).toEqual([])
    tracker.saved('# D\n')
    tracker.settle()
    expect(renames).toEqual([{ from: 'C', to: 'D', previousAutoAlias: null }])
  })

  it('chained renames carry the previous auto-alias for pruning', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# First\n')
    tracker.saved('# Second\n')
    tracker.settle()
    tracker.saved('# Third\n')
    tracker.settle()
    expect(renames).toEqual([
      { from: 'First', to: 'Second', previousAutoAlias: null },
      { from: 'Second', to: 'Third', previousAutoAlias: 'First' },
    ])
  })

  it('derives the title from frontmatter when present', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('---\ntitle: Real Title\n---\n# Heading\n')
    tracker.saved('---\ntitle: Renamed\n---\n# Heading\n')
    tracker.settle()
    expect(renames[0]).toMatchObject({ from: 'Real Title', to: 'Renamed' })
  })

  it('a blocked fire keeps the rename pending until the gate opens', () => {
    let conflictParked = true
    const { tracker, renames } = tracked({ canFire: () => !conflictParked })
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.settle() // blocked: conflict parked
    vi.advanceTimersByTime(10_000)
    expect(renames).toEqual([])

    conflictParked = false
    tracker.saved('# B\n') // "keep mine" re-saves the same title → re-arms
    vi.advanceTimersByTime(5000)
    expect(renames).toEqual([{ from: 'A', to: 'B', previousAutoAlias: null }])
  })

  it('an H1 edit under an explicit frontmatter title is not a rename', () => {
    // `title:` is authoritative (deriveTitle precedence, same as the indexer):
    // the heading isn't the title, links resolve against `title:` regardless,
    // so there is nothing to rewrite.
    const { tracker, renames } = tracked()
    tracker.baseline('---\ntitle: Canonical\n---\n# Old Heading\n')
    tracker.saved('---\ntitle: Canonical\n---\n# New Heading\n')
    vi.advanceTimersByTime(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('the first authored title on an untitled note is a birth (from: null), settled like a rename', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('') // fresh lazy note (⌘N): derived title is the filename
    tracker.saved('# My New\n') // intermediate typing state — must not fire
    tracker.saved('# My New Note\n')
    expect(renames).toEqual([]) // births settle through the quiet timer too
    vi.advanceTimersByTime(10_000)
    // No phantom rename from the ULID stem — a birth carries no `from` title.
    expect(renames).toEqual([{ from: null, to: 'My New Note', previousAutoAlias: null }])

    tracker.saved('# Renamed\n') // a real rename afterwards still works
    tracker.settle()
    expect(renames).toEqual([
      { from: null, to: 'My New Note', previousAutoAlias: null },
      { from: 'My New Note', to: 'Renamed', previousAutoAlias: null },
    ])
  })

  it('a birth pending at a settle point fires immediately', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('')
    tracker.saved('# Named On The Way Out\n')
    tracker.settle() // teardown/blur before the quiet period elapses
    expect(renames).toEqual([{ from: null, to: 'Named On The Way Out', previousAutoAlias: null }])
  })

  it('a birth cleared back to untitled never fires', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('')
    tracker.saved('# Oops\n')
    tracker.saved('no heading any more\n') // title deleted before it settled
    vi.advanceTimersByTime(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('removing the title mid-edit clears pending but keeps the baseline', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('body only, heading deleted\n')
    vi.advanceTimersByTime(10_000)
    expect(renames).toEqual([]) // untitled is not a rename target
    tracker.saved('# B\n')
    tracker.settle()
    expect(renames).toEqual([{ from: 'A', to: 'B', previousAutoAlias: null }])
  })

  it('does nothing after dispose', () => {
    const { tracker, renames } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.dispose()
    vi.advanceTimersByTime(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })
})
