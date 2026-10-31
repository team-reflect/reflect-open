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

    const emojiNote = await database.db
      .selectFrom('notes')
      .where('path', '=', emojiPath)
      .select(['title', 'titleKey'])
      .executeTakeFirst()
    expect(emojiNote).toEqual({ title: '🧠 Business ideas', titleKey: '🧠 business ideas' })
    const bareLink = await database.db
      .selectFrom('links')
      .where('sourcePath', '=', linkingPath)
      .where('kind', '=', 'wiki')
      .select(['targetRaw', 'targetKey'])
      .executeTakeFirst()
    // The device's exact title index cannot match `Business ideas` against
    // the indexed `🧠 Business ideas` title.
    expect(bareLink).toEqual({ targetRaw: 'Business ideas', targetKey: 'business ideas' })

    await expect(
      creation.resolveOrCreateNoteWithTitle(bareLink?.targetRaw ?? '', 7),
    ).resolves.toEqual({ kind: 'resolved', path: emojiPath })
    expect(create).not.toHaveBeenCalled()
    expect(noteFile.writes()).toEqual([])
    expect(noteFile.files().has('notes/business-ideas-2.md')).toBe(false)
  })
})
