import { describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge'
import {
  applyProjection,
  connectIndex,
  expectSuggestionOpensItsPath,
  openMigratedIndex,
  project,
} from './flow-test-harness'
import {
  getBacklinks,
  getLinkSources,
  resolveWikiTarget,
  suggestWikiLinkTargets,
  suggestWikiTargets,
} from './queries'
import { rewriteLinksForTitleChange } from './rename'

/**
 * End-to-end flow for rich titles (titles that embed `[[wiki links]]`): the
 * derived linkable alias row makes the note discoverable and insertable
 * through the real schema, and the `note_keys` precedence machinery rejects
 * the derived address the moment a real title claims the same key.
 */
describe('rich title flow', () => {
  it('projects a derived alias and serves search, insertion, and resolution', async () => {
    const database = openMigratedIndex()
    const rich = project(
      'notes/meeting-with-ada.md',
      '# Meeting with [[Ada Lovelace|Ada]]\n',
      20,
    )
    expect(rich.aliases).toEqual([
      { alias: 'Meeting with Ada', aliasKey: 'meeting with ada' },
    ])
    applyProjection(database, rich)
    connectIndex(database)
    try {
      // Visible-text search: the raw title_key ("meeting with [[ada…") does
      // not contain the query, so this hit comes from the derived alias row.
      const { suggestions } = await suggestWikiLinkTargets('with ada')
      expect(suggestions).toMatchObject([
        {
          path: 'notes/meeting-with-ada.md',
          title: 'Meeting with [[Ada Lovelace|Ada]]',
          target: 'Meeting with Ada',
          alias: null,
          insertText: 'Meeting with Ada',
        },
      ])
      await Promise.all(suggestions.map(expectSuggestionOpensItsPath))
      await expect(resolveWikiTarget('Meeting with Ada')).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/meeting-with-ada.md',
      })
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('drops the derived address when a real title claims the same key', async () => {
    const database = openMigratedIndex()
    applyProjection(
      database,
      project('notes/meeting-with-ada.md', '# Meeting with [[Ada Lovelace|Ada]]\n', 20),
    )
    applyProjection(database, project('notes/plain.md', '# Meeting with Ada\n', 30))
    connectIndex(database)
    try {
      const result = await suggestWikiLinkTargets('meeting with ada')
      // The title tier outranks the rich note's derived alias, so only the
      // plainly titled note is selectable; the claimed key still reaches the
      // editor so it suppresses the Create row.
      expect(result.suggestions).toMatchObject([
        { path: 'notes/plain.md', insertText: 'Meeting with Ada' },
      ])
      expect(result.claimedTargetKeys).toContain('meeting with ada')
      await expect(resolveWikiTarget('Meeting with Ada')).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/plain.md',
      })
      // Navigation surfaces keep both notes reachable.
      const navigation = await suggestWikiTargets('meeting with ada')
      expect(navigation.map((suggestion) => suggestion.path).sort()).toEqual([
        'notes/meeting-with-ada.md',
        'notes/plain.md',
      ])
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('rename refuses a derived destination another note already owns', async () => {
    const database = openMigratedIndex()
    applyProjection(database, project('notes/a.md', '# Old Meeting\n', 10))
    applyProjection(database, project('notes/plain.md', '# Meeting with Ada\n', 20))
    applyProjection(database, project('notes/source.md', 'See [[Old Meeting]].\n', 30))
    connectIndex(database)
    try {
      // Renaming A to a rich title whose derived target is plain.md's title:
      // rewriting `[[Old Meeting]]` to `[[Meeting with Ada]]` would silently
      // repoint the link at plain.md (title tier wins), so nothing is written.
      const writes: string[] = []
      const result = await rewriteLinksForTitleChange({
        path: 'notes/a.md',
        from: 'Old Meeting',
        to: 'Meeting with [[Ada Lovelace|Ada]]',
        io: {
          sources: getLinkSources,
          backlinks: getBacklinks,
          read: async () => 'See [[Old Meeting]].\n',
          write: async (path) => {
            writes.push(path)
          },
          resolve: resolveWikiTarget,
        },
      })
      expect(result).toEqual({
        rewritten: [],
        failed: [],
        collision: false,
        destinationBlocked: true,
      })
      expect(writes).toEqual([])
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('a degenerate rich title is unaddressable but stays navigable', async () => {
    const database = openMigratedIndex()
    const degenerate = project('notes/degenerate.md', '# [[ [ ]]\n', 10)
    expect(degenerate.aliases).toEqual([]) // derived form falls back to the raw title
    applyProjection(database, degenerate)
    connectIndex(database)
    try {
      const result = await suggestWikiLinkTargets('[[ [')
      expect(result.suggestions).toEqual([])
      const navigation = await suggestWikiTargets('[[ [')
      expect(navigation.map((suggestion) => suggestion.path)).toEqual([
        'notes/degenerate.md',
      ])
    } finally {
      setBridge(null)
      database.close()
    }
  })
})
