import { createTestAppServices } from '@reflect/app/testing'
import type { Route } from '@reflect/app'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNodeTestDatabaseService,
  createTestCoreServices,
  seedNotes,
  type TestCoreServices,
} from '@reflect/core/testing'
import { openPinnedNote, PINNED_NOTE_COMMANDS } from './pinned-note-commands.ts'

let core: TestCoreServices

beforeEach(() => {
  core = createTestCoreServices({ database: createNodeTestDatabaseService() })
  core.graphSession.setGraph({ generation: 4 })
})

afterEach(() => {
  core.database.close()
})

function pinned(title: string): string {
  return `---\npinned: true\n---\n# ${title}\n`
}

function contextFor() {
  const navigated: Route[] = []
  const context = {
    services: core,
    app: createTestAppServices(core),
    navigate: (route: Route) => {
      navigated.push(route)
    },
  }
  return { context, navigated }
}

describe('openPinnedNote', () => {
  it('opens the shelf entry at the index, in shelf order', async () => {
    seedNotes(core.database, [
      { path: 'notes/b.md', markdown: pinned('B second') },
      { path: 'notes/a.md', markdown: pinned('A first') },
      { path: 'notes/c.md', markdown: '# Not pinned\n' },
    ])
    const { context, navigated } = contextFor()

    await openPinnedNote(context, 1)
    await openPinnedNote(context, 0)

    expect(navigated).toEqual([
      { kind: 'note', path: 'notes/b.md' },
      { kind: 'note', path: 'notes/a.md' },
    ])
  })

  it('follows an unpin the index has not seen yet', async () => {
    seedNotes(core.database, [
      { path: 'notes/a.md', markdown: pinned('A first') },
      { path: 'notes/b.md', markdown: pinned('B second') },
    ])
    core.noteRows.setOverlay('notes/a.md', 4, { isPinned: false })
    const { context, navigated } = contextFor()

    await openPinnedNote(context, 0)

    expect(navigated).toEqual([{ kind: 'note', path: 'notes/b.md' }])
  })

  it('does nothing past the end of the shelf or without a graph', async () => {
    seedNotes(core.database, [{ path: 'notes/a.md', markdown: pinned('A first') }])
    const { context, navigated } = contextFor()

    await openPinnedNote(context, 3)
    core.graphSession.setGraph(null)
    await openPinnedNote(context, 0)

    expect(navigated).toEqual([])
  })

  it('reports a failed shelf read instead of rejecting', async () => {
    vi.spyOn(core.indexQuery, 'getPinnedNotes').mockRejectedValue(new Error('index gone'))
    const { context, navigated } = contextFor()

    await expect(openPinnedNote(context, 0)).resolves.toBeUndefined()

    expect(navigated).toEqual([])
    expect(context.app.operations.get()).toContainEqual(
      expect.objectContaining({ label: 'Opening pinned note', status: 'failed' }),
    )
  })
})

describe('PINNED_NOTE_COMMANDS', () => {
  it('binds ⌘6–⌘9 to the top four shelf positions', () => {
    expect(PINNED_NOTE_COMMANDS.map((command) => [command.id, command.keybinding])).toEqual([
      ['pinned.open1', 'Mod-6'],
      ['pinned.open2', 'Mod-7'],
      ['pinned.open3', 'Mod-8'],
      ['pinned.open4', 'Mod-9'],
    ])
  })
})
