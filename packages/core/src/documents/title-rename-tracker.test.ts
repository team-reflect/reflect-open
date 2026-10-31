import { describe, expect, it } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createTitleRenameTracker, type TitleRename } from './title-rename-tracker.ts'

function tracked() {
  const renames: TitleRename[] = []
  const clock = createTestClockService()
  const tracker = createTitleRenameTracker({
    path: 'notes/x.md',
    quietMs: 5000,
    onRename: (rename) => {
      renames.push(rename)
    },
    clock,
  })
  return { tracker, renames, clock }
}

describe('createTitleRenameTracker', () => {
  it('fires after the quiet period once a saved title differs from baseline', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# Old Title\n')
    tracker.saved('# New Title\n')
    expect(renames).toEqual([])
    await clock.advance(5000)
    expect(renames).toEqual([{ from: 'Old Title', to: 'New Title', previousAutoAlias: null }])
  })

  it('re-arms on every save: intermediate titles never fire', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# My Note\n')
    tracker.saved('# My N\n') // mid-edit garbage state
    await clock.advance(4000)
    tracker.saved('# My Notebook\n')
    await clock.advance(4999)
    expect(renames).toEqual([])
    await clock.advance(1)
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

  it('a reverted title clears the pending rename', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.saved('# A\n') // changed their mind
    await clock.advance(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('a pure case change is not a rename (resolution is case-insensitive)', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# my note\n')
    tracker.saved('# My Note\n')
    await clock.advance(10_000)
    expect(renames).toEqual([])
  })

  it('external content re-baselines without firing and resets the alias chain', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.baseline('# C\n') // external edit adopted mid-quiet-period
    await clock.advance(10_000)
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

  it('an H1 edit under an explicit frontmatter title is not a rename', async () => {
    // `title:` is authoritative (deriveTitle precedence, same as the indexer):
    // the heading isn't the title, links resolve against `title:` regardless,
    // so there is nothing to rewrite.
    const { tracker, renames, clock } = tracked()
    tracker.baseline('---\ntitle: Canonical\n---\n# Old Heading\n')
    tracker.saved('---\ntitle: Canonical\n---\n# New Heading\n')
    await clock.advance(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('the first authored title on an untitled note is a birth (from: null), settled like a rename', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('') // fresh lazy note (⌘N): derived title is the filename
    tracker.saved('# My New\n') // intermediate typing state — must not fire
    tracker.saved('# My New Note\n')
    expect(renames).toEqual([]) // births settle through the quiet timer too
    await clock.advance(10_000)
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

  it('a birth cleared back to untitled never fires', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('')
    tracker.saved('# Oops\n')
    tracker.saved('no heading any more\n') // title deleted before it settled
    await clock.advance(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })

  it('removing the title mid-edit clears pending but keeps the baseline', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('body only, heading deleted\n')
    await clock.advance(10_000)
    expect(renames).toEqual([]) // untitled is not a rename target
    tracker.saved('# B\n')
    tracker.settle()
    expect(renames).toEqual([{ from: 'A', to: 'B', previousAutoAlias: null }])
  })

  it('does nothing after dispose', async () => {
    const { tracker, renames, clock } = tracked()
    tracker.baseline('# A\n')
    tracker.saved('# B\n')
    tracker.dispose()
    await clock.advance(10_000)
    tracker.settle()
    expect(renames).toEqual([])
  })
})
