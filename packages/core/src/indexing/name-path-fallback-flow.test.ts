import { describe, expect, it } from 'vitest'

import { createTestDatabaseService } from '../testing/database.ts'
import {
  connectIndex,
  expectSuggestionOpensItsPath,
  disconnectIndex,
  project,
} from './flow-test-harness.ts'

describe('colon and slash title flow', () => {
  it('projects, resolves, backlinks, and autocompletes a colon title', async () => {
    const database = createTestDatabaseService()
    const targetPath = 'notes/test-long-with-parens-ampersand-follow-up.md'
    database.applyProjection(
      project(targetPath, '# Test: Long With Parens & Ampersand Follow-up\n', 20),
    )
    database.applyProjection(
      project('daily/2026-08-04.md', 'See [[Test: Long With Parens & Ampersand Follow-up]].\n', 10),
    )
    const index = connectIndex(database)

    try {
      await expect(
        index.noteCreation.resolveOrCreateNoteWithTitle(
          'Test: Long With Parens & Ampersand Follow-up',
          1,
        ),
      ).resolves.toEqual({ kind: 'resolved', path: targetPath })

      const backlinks = await index.backlinks.getBacklinks(targetPath)
      expect(backlinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])

      const { suggestions } = await index.suggestions.suggestWikiLinkTargets('Test: Long')
      expect(suggestions.map((row) => row.insertText)).toEqual([
        'Test: Long With Parens & Ampersand Follow-up',
      ])
      await expectSuggestionOpensItsPath(index, suggestions[0]!)
    } finally {
      disconnectIndex(database)
    }
  })

  it('resolves and backlinks a slash title when no file matches the path reading', async () => {
    const database = createTestDatabaseService()
    const targetPath = 'notes/johnsally-meeting-notes.md'
    database.applyProjection(project(targetPath, '# john/sally meeting notes\n', 20))
    database.applyProjection(
      project('daily/2026-08-04.md', 'See [[john/sally meeting notes]].\n', 10),
    )
    const index = connectIndex(database)

    try {
      await expect(
        index.noteCreation.resolveOrCreateNoteWithTitle('john/sally meeting notes', 1),
      ).resolves.toEqual({
        kind: 'resolved',
        path: targetPath,
      })

      const backlinks = await index.backlinks.getBacklinks(targetPath)
      expect(backlinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])

      const { suggestions } = await index.suggestions.suggestWikiLinkTargets('john/sally')
      expect(suggestions.map((row) => row.insertText)).toEqual(['john/sally meeting notes'])
      await expectSuggestionOpensItsPath(index, suggestions[0]!)
    } finally {
      disconnectIndex(database)
    }
  })

  it('keeps the exact file win over a same-spelled title, in resolution and backlinks', async () => {
    const database = createTestDatabaseService()
    database.applyProjection(project('Projects/Plan.md', '# Weekly Planning\n', 20))
    database.applyProjection(project('notes/imposter.md', '# Projects/Plan\n', 30))
    database.applyProjection(project('daily/2026-08-04.md', 'See [[Projects/Plan]].\n', 10))
    const index = connectIndex(database)

    try {
      await expect(
        index.noteCreation.resolveOrCreateNoteWithTitle('Projects/Plan', 1),
      ).resolves.toEqual({
        kind: 'resolved',
        path: 'Projects/Plan.md',
      })

      const fileBacklinks = await index.backlinks.getBacklinks('Projects/Plan.md')
      expect(fileBacklinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])
      await expect(index.backlinks.getBacklinks('notes/imposter.md')).resolves.toEqual([])
    } finally {
      disconnectIndex(database)
    }
  })

  it('gives a rooted path no name fallback, in resolution or backlinks', async () => {
    const database = createTestDatabaseService()
    database.applyProjection(project('notes/missing.md', '# /Missing\n', 20))
    database.applyProjection(project('daily/2026-08-04.md', 'See [[/Missing]].\n', 10))
    const index = connectIndex(database)

    try {
      await expect(index.noteCreation.resolveOrCreateNoteWithTitle('/Missing', 1)).resolves.toEqual(
        {
          kind: 'unavailable',
          paths: ['Missing.md'],
        },
      )
      await expect(index.backlinks.getBacklinks('notes/missing.md')).resolves.toEqual([])
    } finally {
      disconnectIndex(database)
    }
  })

  it('backlinks a fragment-carrying slashed target through its name fallback', async () => {
    const database = createTestDatabaseService()
    const targetPath = 'notes/missingplan.md'
    database.applyProjection(project(targetPath, '# Missing/Plan\n', 20))
    database.applyProjection(project('daily/2026-08-04.md', 'See [[Missing/Plan#Next]].\n', 10))
    const index = connectIndex(database)

    try {
      await expect(
        index.noteCreation.resolveOrCreateNoteWithTitle('Missing/Plan#Next', 1),
      ).resolves.toEqual({
        kind: 'resolved',
        path: targetPath,
      })

      const backlinks = await index.backlinks.getBacklinks(targetPath)
      expect(backlinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])
    } finally {
      disconnectIndex(database)
    }
  })

  it('backlinks a .md-suffixed slashed target through its name fallback', async () => {
    const database = createTestDatabaseService()
    const targetPath = 'notes/missingplan.md'
    database.applyProjection(project(targetPath, '# Missing/Plan\n', 20))
    database.applyProjection(project('daily/2026-08-04.md', 'See [[Missing/Plan.md]].\n', 10))
    const index = connectIndex(database)

    try {
      await expect(
        index.noteCreation.resolveOrCreateNoteWithTitle('Missing/Plan.md', 1),
      ).resolves.toEqual({
        kind: 'resolved',
        path: targetPath,
      })

      const backlinks = await index.backlinks.getBacklinks(targetPath)
      expect(backlinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])
    } finally {
      disconnectIndex(database)
    }
  })
})
