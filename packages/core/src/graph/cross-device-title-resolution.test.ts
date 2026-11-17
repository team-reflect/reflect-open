import { describe, expect, it, vi } from 'vitest'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { createNodeTestDatabaseService, seedNotes } from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createTestIdService } from '../testing/id.ts'
import { createNoteCreationService } from './note-creation-service.ts'
import { createNoteLinkResolverService } from './note-link-resolver-service.ts'

describe('cross-device emoji title resolution', () => {
  it('reuses the synced emoji-titled note for a bare wiki link without creating -2', async () => {
    const emojiPath = 'notes/business-ideas.md'
    const linkingPath = 'notes/linking.md'
    const files = {
      [emojiPath]: '# 🧠 Business ideas\n',
      [linkingPath]: 'An external edit linked [[Business ideas]].\n',
    }
    const database = createNodeTestDatabaseService()
    seedNotes(
      database,
      Object.entries(files).map(([path, markdown]) => ({ path, markdown })),
    )
    const noteFile = createTestNoteFileService({ files })
    const create = vi.spyOn(noteFile, 'create')
    const noteLinkResolver = createNoteLinkResolverService({
      wikiResolver: createWikiResolverService({ database }),
      noteFile,
    })
    const creation = createNoteCreationService({
      noteFile,
      noteLinkResolver,
      id: createTestIdService(),
    })

    const [emojiNote] = database.query('SELECT title, title_key FROM notes WHERE path = ?', [
      emojiPath,
    ])
    expect(emojiNote).toEqual({ title: '🧠 Business ideas', title_key: '🧠 business ideas' })
    const [bareLink] = database.query(
      "SELECT target_raw, target_key FROM links WHERE source_path = ? AND kind = 'wiki'",
      [linkingPath],
    )
    // The device's exact title index cannot match `Business ideas` against
    // the indexed `🧠 Business ideas` title.
    expect(bareLink).toEqual({ target_raw: 'Business ideas', target_key: 'business ideas' })

    await expect(creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual({
      kind: 'resolved',
      path: emojiPath,
    })
    expect(create).not.toHaveBeenCalled()
    expect(noteFile.writes()).toEqual([])
    expect(noteFile.files().has('notes/business-ideas-2.md')).toBe(false)
  })
})
