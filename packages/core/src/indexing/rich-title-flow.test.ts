import { describe, expect, it } from 'vitest'
import { createNodeTestDatabaseService } from '../testing/database.ts'
import {
  connectIndex,
  expectSuggestionOpensItsPath,
  disconnectIndex,
  project,
} from './flow-test-harness.ts'

import { rewriteLinksForTitleChange } from './rename.ts'

/**
 * End-to-end flow for rich titles (titles that embed `[[wiki links]]`): the
 * derived linkable alias row makes the note discoverable and insertable
 * through the real schema, and the `note_keys` precedence machinery rejects
 * the derived address the moment a real title claims the same key.
 */
describe('rich title flow', () => {
  it('projects a derived alias and serves search, insertion, and resolution', async () => {
    const database = createNodeTestDatabaseService()
    const rich = project('notes/meeting-with-ada.md', '# Meeting with [[Ada Lovelace|Ada]]\n', 20)
    expect(rich.aliases).toEqual([{ alias: 'Meeting with Ada', aliasKey: 'meeting with ada' }])
    database.applyProjection(rich)
    const index = connectIndex(database)
    try {
      // Visible-text search: the raw title_key ("meeting with [[ada…") does
      // not contain the query, so this hit comes from the derived alias row.
      const { suggestions } = await index.suggestions.suggestWikiLinkTargets('with ada')
      expect(suggestions).toMatchObject([
        {
          path: 'notes/meeting-with-ada.md',
          title: 'Meeting with [[Ada Lovelace|Ada]]',
          target: 'Meeting with Ada',
          alias: null,
          insertText: 'Meeting with Ada',
        },
      ])
      await Promise.all(
        suggestions.map((suggestion) => expectSuggestionOpensItsPath(index, suggestion)),
      )
      await expect(index.wikiResolver.resolveWikiTarget('Meeting with Ada')).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/meeting-with-ada.md',
      })
    } finally {
      disconnectIndex(database)
    }
  })

  it('drops the derived address when a real title claims the same key', async () => {
    const database = createNodeTestDatabaseService()
    database.applyProjection(
      project('notes/meeting-with-ada.md', '# Meeting with [[Ada Lovelace|Ada]]\n', 20),
    )
    database.applyProjection(project('notes/plain.md', '# Meeting with Ada\n', 30))
    const index = connectIndex(database)
    try {
      const result = await index.suggestions.suggestWikiLinkTargets('meeting with ada')
      // The title tier outranks the rich note's derived alias, so the plainly
      // titled note keeps the name address and the rich note falls back to
      // its path; the claimed key still reaches the editor so it suppresses
      // the Create row.
      expect(result.suggestions).toMatchObject([
        { path: 'notes/plain.md', insertText: 'Meeting with Ada' },
        {
          path: 'notes/meeting-with-ada.md',
          insertText: 'notes/meeting-with-ada|Meeting with Ada',
        },
      ])
      expect(result.claimedTargetKeys).toContain('meeting with ada')
      await expect(index.wikiResolver.resolveWikiTarget('Meeting with Ada')).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/plain.md',
      })
      // Navigation surfaces keep both notes reachable.
      const navigation = await index.suggestions.suggestWikiTargets('meeting with ada')
      expect(navigation.map((suggestion) => suggestion.path).sort()).toEqual([
        'notes/meeting-with-ada.md',
        'notes/plain.md',
      ])
    } finally {
      disconnectIndex(database)
    }
  })

  it('rename refuses a derived destination another note already owns', async () => {
    const database = createNodeTestDatabaseService()
    database.applyProjection(project('notes/a.md', '# Old Meeting\n', 10))
    database.applyProjection(project('notes/plain.md', '# Meeting with Ada\n', 20))
    database.applyProjection(project('notes/source.md', 'See [[Old Meeting]].\n', 30))
    const index = connectIndex(database)
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
          sources: (targets) => index.wikiResolver.getLinkSources(targets),
          backlinks: (path) => index.backlinks.getBacklinks(path),
          read: () => 'See [[Old Meeting]].\n',
          write: (path) => {
            writes.push(path)
          },
          resolve: (target) => index.wikiResolver.resolveWikiTarget(target),
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
      disconnectIndex(database)
    }
  })

  it('a degenerate rich title falls back to a path address and stays navigable', async () => {
    const database = createNodeTestDatabaseService()
    const degenerate = project('notes/degenerate.md', '# [[ [ ]]\n', 10)
    expect(degenerate.aliases).toEqual([]) // derived form falls back to the raw title
    database.applyProjection(degenerate)
    const index = connectIndex(database)
    try {
      const result = await index.suggestions.suggestWikiLinkTargets('[[ [')
      // No name survives serialization, so the row falls back to its path
      // address instead of vanishing from the menu.
      expect(result.suggestions).toMatchObject([
        { path: 'notes/degenerate.md', insertText: 'notes/degenerate' },
      ])
      await Promise.all(
        result.suggestions.map((suggestion) => expectSuggestionOpensItsPath(index, suggestion)),
      )
      const navigation = await index.suggestions.suggestWikiTargets('[[ [')
      expect(navigation.map((suggestion) => suggestion.path)).toEqual(['notes/degenerate.md'])
    } finally {
      disconnectIndex(database)
    }
  })
})

describe('path-address fallback flow', () => {
  it('offers each duplicate-titled note its own path address', async () => {
    const database = createNodeTestDatabaseService()
    database.applyProjection(project('a/Plan.md', '# Plan\n', 20))
    database.applyProjection(project('b/Plan.md', '# Plan\n', 10))
    const index = connectIndex(database)
    try {
      const { suggestions } = await index.suggestions.suggestWikiLinkTargets('plan')
      expect(suggestions.map((row) => row.insertText).sort()).toEqual([
        'a/Plan|Plan',
        'b/Plan|Plan',
      ])
      await Promise.all(
        suggestions.map((suggestion) => expectSuggestionOpensItsPath(index, suggestion)),
      )
    } finally {
      disconnectIndex(database)
    }
  })

  it('shows the title when a duplicate-titled note is addressed by its alias', async () => {
    const database = createNodeTestDatabaseService()
    const base = 'capture-2026-10-11-220303-087-28d5'
    database.applyProjection(
      project(`notes/${base}.md`, `---\naliases: [${base}]\n---\n\n# Crone\n`, 20),
    )
    database.applyProjection(project('notes/crone.md', '# Crone\n', 10))
    const index = connectIndex(database)
    try {
      const { suggestions } = await index.suggestions.suggestWikiLinkTargets('crone')
      expect(suggestions.map((row) => row.insertText)).toEqual([
        `${base}|Crone`,
        'notes/crone|Crone',
      ])
      await Promise.all(
        suggestions.map((suggestion) => expectSuggestionOpensItsPath(index, suggestion)),
      )
    } finally {
      disconnectIndex(database)
    }
  })

  it('keeps the plain title when it is unambiguous', async () => {
    const database = createNodeTestDatabaseService()
    database.applyProjection(project('notes/unique.md', '# Unique\n', 20))
    const index = connectIndex(database)
    try {
      const { suggestions } = await index.suggestions.suggestWikiLinkTargets('unique')
      expect(suggestions.map((row) => row.insertText)).toEqual(['Unique'])
    } finally {
      disconnectIndex(database)
    }
  })

  it('drops a row whose path has no wiki spelling', async () => {
    const database = createNodeTestDatabaseService()
    database.applyProjection(project('notes/c#-notes.md', '# Plan\n', 20))
    // A trim-unstable slash segment reads back as a *name*, not a path, so
    // the round-trip proof refuses it too.
    database.applyProjection(project('notes/a /Plan.md', '# Plan\n', 15))
    database.applyProjection(project('notes/plan.md', '# Plan\n', 10))
    const index = connectIndex(database)
    try {
      const { suggestions } = await index.suggestions.suggestWikiLinkTargets('plan')
      // `#` reads as a fragment separator in every wiki consumer, so the
      // hash-named duplicate cannot be inserted; neither can the loose-slash
      // path; the clean sibling still can.
      expect(suggestions.map((row) => row.insertText)).toEqual(['notes/plan|Plan'])
    } finally {
      disconnectIndex(database)
    }
  })
})
