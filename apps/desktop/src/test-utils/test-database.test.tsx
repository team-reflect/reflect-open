import { describe, expect, it } from 'vitest'
import { buildIndexedNote, createSuggestionService, parseNote } from '@reflect/core'
import { createTestCoreServices, seedNotes } from '@reflect/core/testing'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'

function projection(path: string, source: string) {
  return buildIndexedNote(parseNote({ path, source }), {
    fileHash: `hash-${path}`,
    mtime: 1,
    source,
  })
}

describe('createWasmTestDatabaseService', () => {
  it('answers the shared queries from seeded projections', async () => {
    const database = createWasmTestDatabaseService()
    database.applyProjection(projection('notes/hub.md', '# Hub\n'))
    database.applyProjection(projection('daily/2026-01-10.md', '[[Hub]]\n'))
    const suggestionService = createSuggestionService({ database })
    try {
      const suggestions = await suggestionService.suggestWikiTargets('hub')
      expect(suggestions.map((suggestion) => suggestion.path)).toEqual(['notes/hub.md'])
    } finally {
      database.close()
    }
  })

  it('rejects queries after close', async () => {
    const database = createWasmTestDatabaseService()
    database.close()
    await expect(database.runQuery('select 1', [])).rejects.toMatchObject({ kind: 'unknown' })
  })
})

describe('createTestCoreServices in the browser', () => {
  it('reads the index through the wasm database it is given', async () => {
    const core = createTestCoreServices({ database: createWasmTestDatabaseService() })
    seedNotes(core.database, [{ path: 'notes/hub.md', markdown: '# Hub\n' }])
    try {
      await expect(core.wikiResolver.resolveWikiTarget('Hub')).resolves.toEqual({
        kind: 'resolved',
        ref: 'notes/hub.md',
      })
    } finally {
      core.database.close()
    }
  })
})
