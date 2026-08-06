import { describe, expect, it } from 'vitest'
import { resolveOrCreateNoteWithTitle } from '../graph/create-note'
import { setBridge } from '../ipc/bridge'
import {
  applyProjection,
  connectIndex,
  expectSuggestionOpensItsPath,
  openMigratedIndex,
  project,
} from './flow-test-harness'
import { getBacklinks, suggestWikiLinkTargets } from './queries'

describe('colon and slash title flow', () => {
  it('projects, resolves, backlinks, and autocompletes a colon title', async () => {
    const database = openMigratedIndex()
    const targetPath = 'notes/test-long-with-parens-ampersand-follow-up.md'
    applyProjection(
      database,
      project(targetPath, '# Test: Long With Parens & Ampersand Follow-up\n', 20),
    )
    applyProjection(
      database,
      project('daily/2026-08-04.md', 'See [[Test: Long With Parens & Ampersand Follow-up]].\n', 10),
    )
    connectIndex(database)

    try {
      await expect(
        resolveOrCreateNoteWithTitle('Test: Long With Parens & Ampersand Follow-up', 1),
      ).resolves.toEqual({ kind: 'resolved', path: targetPath })

      const backlinks = await getBacklinks(targetPath)
      expect(backlinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])

      const { suggestions } = await suggestWikiLinkTargets('Test: Long')
      expect(suggestions.map((row) => row.insertText)).toEqual([
        'Test: Long With Parens & Ampersand Follow-up',
      ])
      await expectSuggestionOpensItsPath(suggestions[0]!)
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('resolves and backlinks a slash title when no file matches the path reading', async () => {
    const database = openMigratedIndex()
    const targetPath = 'notes/johnsally-meeting-notes.md'
    applyProjection(database, project(targetPath, '# john/sally meeting notes\n', 20))
    applyProjection(
      database,
      project('daily/2026-08-04.md', 'See [[john/sally meeting notes]].\n', 10),
    )
    connectIndex(database)

    try {
      await expect(resolveOrCreateNoteWithTitle('john/sally meeting notes', 1)).resolves.toEqual({
        kind: 'resolved',
        path: targetPath,
      })

      const backlinks = await getBacklinks(targetPath)
      expect(backlinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])

      const { suggestions } = await suggestWikiLinkTargets('john/sally')
      expect(suggestions.map((row) => row.insertText)).toEqual(['john/sally meeting notes'])
      await expectSuggestionOpensItsPath(suggestions[0]!)
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('keeps the exact file win over a same-spelled title, in resolution and backlinks', async () => {
    const database = openMigratedIndex()
    applyProjection(database, project('Projects/Plan.md', '# Weekly Planning\n', 20))
    applyProjection(database, project('notes/imposter.md', '# Projects/Plan\n', 30))
    applyProjection(database, project('daily/2026-08-04.md', 'See [[Projects/Plan]].\n', 10))
    connectIndex(database)

    try {
      await expect(resolveOrCreateNoteWithTitle('Projects/Plan', 1)).resolves.toEqual({
        kind: 'resolved',
        path: 'Projects/Plan.md',
      })

      const fileBacklinks = await getBacklinks('Projects/Plan.md')
      expect(fileBacklinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])
      await expect(getBacklinks('notes/imposter.md')).resolves.toEqual([])
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('gives a rooted path no name fallback, in resolution or backlinks', async () => {
    const database = openMigratedIndex()
    applyProjection(database, project('notes/missing.md', '# /Missing\n', 20))
    applyProjection(database, project('daily/2026-08-04.md', 'See [[/Missing]].\n', 10))
    connectIndex(database)

    try {
      await expect(resolveOrCreateNoteWithTitle('/Missing', 1)).resolves.toEqual({
        kind: 'unavailable',
        paths: ['Missing.md'],
      })
      await expect(getBacklinks('notes/missing.md')).resolves.toEqual([])
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('backlinks a fragment-carrying slashed target through its name fallback', async () => {
    const database = openMigratedIndex()
    const targetPath = 'notes/missingplan.md'
    applyProjection(database, project(targetPath, '# Missing/Plan\n', 20))
    applyProjection(database, project('daily/2026-08-04.md', 'See [[Missing/Plan#Next]].\n', 10))
    connectIndex(database)

    try {
      await expect(resolveOrCreateNoteWithTitle('Missing/Plan#Next', 1)).resolves.toEqual({
        kind: 'resolved',
        path: targetPath,
      })

      const backlinks = await getBacklinks(targetPath)
      expect(backlinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('backlinks a .md-suffixed slashed target through its name fallback', async () => {
    const database = openMigratedIndex()
    const targetPath = 'notes/missingplan.md'
    applyProjection(database, project(targetPath, '# Missing/Plan\n', 20))
    applyProjection(database, project('daily/2026-08-04.md', 'See [[Missing/Plan.md]].\n', 10))
    connectIndex(database)

    try {
      await expect(resolveOrCreateNoteWithTitle('Missing/Plan.md', 1)).resolves.toEqual({
        kind: 'resolved',
        path: targetPath,
      })

      const backlinks = await getBacklinks(targetPath)
      expect(backlinks.map((row) => row.sourcePath)).toEqual(['daily/2026-08-04.md'])
    } finally {
      setBridge(null)
      database.close()
    }
  })
})
