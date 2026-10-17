import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { createTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createTestIdService } from '../testing/id.ts'
import {
  createNoteCreationService,
  deferredCreationPolicy,
  isUntitledNotePath,
} from './note-creation-service.ts'
import { createNoteLinkResolverService } from './note-link-resolver-service.ts'

interface Graph {
  /**
   * Notes projected into the index.
   */
  readonly indexed?: readonly TestNote[]
  /**
   * Files on disk.
   */
  readonly files?: Record<string, string>
  /**
   * On-disk paths listed as iCloud placeholders.
   */
  readonly placeholders?: readonly string[]
  /**
   * Listed paths whose reads fail with an `io` error.
   */
  readonly readErrors?: readonly string[]
}

const ids = createTestIdService({ seed: 'create-note' })
const FIRST_ID = ids.noteId()
const SECOND_ID = ids.noteId()

function setup({ indexed = [], files = {}, placeholders = [], readErrors = [] }: Graph = {}) {
  const database = createTestDatabaseService()
  seedNotes(database, indexed)
  const noteFile = createTestNoteFileService({ files, evicted: placeholders })
  for (const path of [...placeholders, ...readErrors]) {
    noteFile.set(path, '')
  }
  const readFile = noteFile.read.bind(noteFile)
  const read = vi.spyOn(noteFile, 'read').mockImplementation(async (path, generation) => {
    if (readErrors.includes(path)) {
      throw new AppError('io', `${path} is temporarily unreadable`)
    }
    return await readFile(path, generation)
  })
  const listNotes = vi.spyOn(noteFile, 'listNotes')
  const createFile = noteFile.create.bind(noteFile)
  const create = vi.spyOn(noteFile, 'create')
  const noteLinkResolver = createNoteLinkResolverService({
    wikiResolver: createWikiResolverService({ database }),
    noteFile,
  })
  const creation = createNoteCreationService({
    noteFile,
    noteLinkResolver,
    id: createTestIdService({ seed: 'create-note' }),
  })
  return {
    database,
    noteFile,
    read,
    listNotes,
    create,
    createFile,
    creation,
    /**
     * How many `note_claims` lookups ran.
     */
    claimLookups: () =>
      database.getQueries().filter((query) => query.sql.includes('note_claims')).length,
  }
}

describe('createNoteWithTitle', () => {
  it('writes a slug-named note with id frontmatter and the title as H1', async () => {
    const graph = setup()

    const path = await graph.creation.createNoteWithTitle('  New Idea ', 7)

    expect(path).toBe('notes/new-idea.md')
    expect(graph.noteFile.writes()).toEqual([
      { path, contents: `---\nid: ${FIRST_ID}\n---\n\n# New Idea\n`, generation: 7 },
    ])
  })

  it('drops a leading emoji from the filename slug but preserves it byte-exactly in the H1', async () => {
    const graph = setup()

    const path = await graph.creation.createNoteWithTitle('🧠 Business ideas', 7)

    expect(path).toBe('notes/business-ideas.md')
    expect(graph.noteFile.getWrites(path)).toEqual([
      `---\nid: ${FIRST_ID}\n---\n\n# 🧠 Business ideas\n`,
    ])
  })

  it('suffixes the slug when the bare path is taken', async () => {
    const graph = setup({ files: { 'notes/new-idea.md': '# Older idea\n' } })

    await expect(graph.creation.createNoteWithTitle('New Idea', 7)).resolves.toBe(
      'notes/new-idea-2.md',
    )
    expect(graph.noteFile.files().get('notes/new-idea.md')).toBe('# Older idea\n')
  })

  it('places an optional body block under the H1', async () => {
    const graph = setup()

    await graph.creation.createNoteWithTitle('Ada Lovelace', 7, '- Type: #person')

    expect(graph.noteFile.getWrites('notes/ada-lovelace.md')).toEqual([
      `---\nid: ${FIRST_ID}\n---\n\n# Ada Lovelace\n\n- Type: #person\n`,
    ])
  })

  it('fails loudly after 1000 taken paths instead of overwriting one', async () => {
    const graph = setup()
    graph.create.mockResolvedValue({ kind: 'collision' })

    await expect(graph.creation.createNoteWithTitle('Busy', 7)).rejects.toThrow(
      'no available note path for slug "busy" after 1000 attempts',
    )
    expect(graph.create).toHaveBeenCalledTimes(1000)
    expect(graph.create).toHaveBeenLastCalledWith('notes/busy-1000.md', expect.any(String), 7)
  })
})

describe('resolveOrCreateNoteWithTitle', () => {
  it('uses exact index resolution before reading the slug family', async () => {
    const graph = setup({ indexed: [{ path: 'notes/indexed.md', markdown: '# Business ideas\n' }] })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'resolved', path: 'notes/indexed.md' },
    )
    expect(graph.listNotes).not.toHaveBeenCalled()
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('preserves indexed daily-date precedence over a regular title', async () => {
    const graph = setup({
      indexed: [
        { path: 'daily/2026-06-09.md', markdown: 'Daily contents\n' },
        { path: 'notes/date-title.md', markdown: '# 2026-06-09\n' },
      ],
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('2026-06-09', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    // The tier-1 daily claim resolves without a disk probe.
    expect(graph.read).not.toHaveBeenCalled()
  })

  it('reuses an unindexed daily file instead of creating a regular date-titled note', async () => {
    const graph = setup({ files: { 'daily/2026-06-09.md': 'Daily contents\n' } })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('2026-06-09', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'daily/2026-06-09.md',
    })
    expect(graph.read).toHaveBeenCalledWith('daily/2026-06-09.md', 7)
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('refuses multiple indexed notes claiming the same exact title', async () => {
    const graph = setup({
      indexed: [
        { path: 'notes/business-ideas-2.md', markdown: '# Business ideas\n' },
        { path: 'notes/business-ideas.md', markdown: '# Business ideas\n' },
      ],
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'ambiguous', paths: ['notes/business-ideas-2.md', 'notes/business-ideas.md'] },
    )
    expect(graph.listNotes).not.toHaveBeenCalled()
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('prefers indexed title matches over aliases', async () => {
    const graph = setup({
      indexed: [
        { path: 'notes/titled.md', markdown: '# Business ideas\n' },
        { path: 'notes/alias-a.md', markdown: '---\naliases: [Business ideas]\n---\n# A\n' },
        { path: 'notes/alias-b.md', markdown: '---\naliases: [Business ideas]\n---\n# B\n' },
      ],
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'resolved', path: 'notes/titled.md' },
    )
  })

  it('refuses multiple indexed notes claiming the same exact alias', async () => {
    const graph = setup({
      indexed: [
        { path: 'notes/alias-a.md', markdown: '---\naliases: [Business ideas]\n---\n# A\n' },
        { path: 'notes/alias-b.md', markdown: '---\naliases: [Business ideas]\n---\n# B\n' },
      ],
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'ambiguous', paths: ['notes/alias-a.md', 'notes/alias-b.md'] },
    )
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('reuses an exact title or alias from the on-disk slug family', async () => {
    const graph = setup({
      files: {
        'notes/business-ideas.md': '# Business ideas\n',
        'notes/business-ideas-2.md': '---\naliases: [Side project]\n---\n# Incubator\n',
      },
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'resolved', path: 'notes/business-ideas.md' },
    )
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('prefers an exact on-disk title over an exact alias', async () => {
    const graph = setup({
      files: {
        'notes/business-ideas.md': '# Business ideas\n',
        'notes/business-ideas-2.md': '---\naliases: [Business ideas]\n---\n# Incubator\n',
      },
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'resolved', path: 'notes/business-ideas.md' },
    )
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('reuses exactly one leading-emoji fallback match', async () => {
    const graph = setup({ files: { 'notes/business-ideas.md': '# 🧠Business ideas\n' } })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'resolved', path: 'notes/business-ideas.md' },
    )
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('prefers an on-disk fallback title over a fallback alias', async () => {
    const graph = setup({
      files: {
        'notes/business-ideas.md': '# 🧠 Business ideas\n',
        'notes/business-ideas-2.md': '---\naliases: ["💡 Business ideas"]\n---\n# Incubator\n',
      },
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'resolved', path: 'notes/business-ideas.md' },
    )
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('includes parsed aliases in the fallback match', async () => {
    const graph = setup({
      files: {
        'notes/business-ideas.md': '---\naliases: ["🧠Business ideas"]\n---\n# Incubator\n',
      },
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'resolved', path: 'notes/business-ideas.md' },
    )
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('refuses to pick between multiple exact-title matches', async () => {
    // The historic duplicate bug's own output: two files claiming the same
    // title. Sorted-first would even prefer the `-2` dupe over the original.
    const graph = setup({
      files: {
        'notes/business-ideas.md': '# Business ideas\n',
        'notes/business-ideas-2.md': '# Business ideas\n',
      },
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'ambiguous', paths: ['notes/business-ideas-2.md', 'notes/business-ideas.md'] },
    )
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('reports an unavailable slug-family member instead of mislabeling it ambiguous', async () => {
    const graph = setup({
      files: {
        'notes/business-ideas.md': '# 🧠 Business ideas\n',
        'notes/business-ideas-2.md': '# 💡 Business ideas\n',
      },
      placeholders: ['notes/business-ideas-3.md'],
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'unavailable', paths: ['notes/business-ideas-3.md'] },
    )
    expect(graph.create).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'eviction placeholder',
      unavailable: { placeholders: ['notes/business-ideas-2.md'] },
    },
    {
      label: 'read failure',
      unavailable: { readErrors: ['notes/business-ideas-2.md'] },
    },
  ])('refuses an exact disk match beside an unreadable $label', async ({ unavailable }) => {
    const graph = setup({
      files: { 'notes/business-ideas.md': '# Business ideas\n' },
      ...unavailable,
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'unavailable', paths: ['notes/business-ideas-2.md'] },
    )
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('re-resolves after the disk scan before creating', async () => {
    const graph = setup()
    graph.listNotes.mockImplementationOnce(async () => {
      seedNotes(graph.database, [{ path: 'notes/synced.md', markdown: '# Synced\n' }])
      return []
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Synced', 7)).resolves.toEqual({
      kind: 'resolved',
      path: 'notes/synced.md',
    })
    expect(graph.claimLookups()).toBe(2)
    expect(graph.create).not.toHaveBeenCalled()
  })

  it('re-resolves an atomic-claim collision instead of creating a suffix', async () => {
    const graph = setup()
    graph.create.mockImplementationOnce(async (path, contents, generation) => {
      // A sync checkout lands the winner just before this claim.
      graph.noteFile.set('notes/business-ideas.md', '# Business ideas\n')
      return await graph.createFile(path, contents, generation)
    })

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Business ideas', 7)).resolves.toEqual(
      { kind: 'resolved', path: 'notes/business-ideas.md' },
    )
    expect(graph.claimLookups()).toBe(3)
    expect(graph.listNotes).toHaveBeenCalledTimes(2)
    expect(graph.create).toHaveBeenCalledTimes(1)
    expect(graph.noteFile.files().has('notes/business-ideas-2.md')).toBe(false)
  })

  it('creates only after both index checks and the disk scan miss', async () => {
    const graph = setup()

    await expect(graph.creation.resolveOrCreateNoteWithTitle('Brand New', 7)).resolves.toEqual({
      kind: 'created',
      path: 'notes/brand-new.md',
    })
    expect(graph.claimLookups()).toBe(2)
    expect(graph.create).toHaveBeenCalledTimes(1)
  })

  it('uses the optional body only when creating a missing note', async () => {
    const graph = setup()

    await expect(
      graph.creation.resolveOrCreateNoteWithTitle('Ada Lovelace', 7, '- Type: #person'),
    ).resolves.toEqual({ kind: 'created', path: 'notes/ada-lovelace.md' })
    expect(graph.noteFile.getWrites('notes/ada-lovelace.md')).toEqual([
      `---\nid: ${FIRST_ID}\n---\n\n# Ada Lovelace\n\n- Type: #person\n`,
    ])
  })

  it('creates a colon-prefixed title as an ordinary note', async () => {
    const graph = setup()
    const path = 'notes/test-long-with-parens-ampersand-follow-up.md'

    await expect(
      graph.creation.resolveOrCreateNoteWithTitle(
        'Test: Long With Parens & Ampersand Follow-up',
        7,
      ),
    ).resolves.toEqual({ kind: 'created', path })
    expect(graph.noteFile.files().get(path)).toContain(
      '# Test: Long With Parens & Ampersand Follow-up\n',
    )
  })

  it('creates a slashed title once both of its readings miss', async () => {
    const graph = setup()
    const path = 'notes/johnsally-meeting-notes.md'

    await expect(
      graph.creation.resolveOrCreateNoteWithTitle('john/sally meeting notes', 7),
    ).resolves.toEqual({ kind: 'created', path })
    expect(graph.noteFile.files().get(path)).toContain('# john/sally meeting notes\n')
  })

  it('reuses the exact file instead of creating for a slashed spelling', async () => {
    const graph = setup({ files: { 'john/sally meeting notes.md': '# Whatever' } })

    await expect(
      graph.creation.resolveOrCreateNoteWithTitle('john/sally meeting notes', 7),
    ).resolves.toEqual({ kind: 'resolved', path: 'john/sally meeting notes.md' })
  })

  it('still refuses to create for a rooted path target', async () => {
    const graph = setup()

    await expect(graph.creation.resolveOrCreateNoteWithTitle('/Plan', 7)).resolves.toEqual({
      kind: 'unavailable',
      paths: ['Plan.md'],
    })
    expect(graph.create).not.toHaveBeenCalled()
  })
})

describe('untitledNoteSeed', () => {
  it('is an empty H1 (the caret lands there) plus a fresh id, unique per call', () => {
    const { creation } = setup()

    expect(creation.untitledNoteSeed()).toBe(`---\nid: ${FIRST_ID}\n---\n\n#\n`)
    expect(creation.untitledNoteSeed()).toBe(`---\nid: ${SECOND_ID}\n---\n\n#\n`)
  })
})

describe('isUntitledNotePath', () => {
  it('recognizes the ULID placeholder paths untitledNotePath mints', () => {
    const { creation } = setup()

    expect(isUntitledNotePath(creation.untitledNotePath())).toBe(true)
  })

  it('rejects slug-named, daily, and near-miss paths', () => {
    expect(isUntitledNotePath('notes/meeting-notes.md')).toBe(false)
    expect(isUntitledNotePath('daily/2026-06-12.md')).toBe(false)
    // A 128-bit ULID cannot start above `7` (the textual form has two spare bits).
    expect(isUntitledNotePath('notes/81arz3ndektsv4rrffq69g5fav.md')).toBe(false)
    // Right length, but `u` is outside the Crockford base32 alphabet.
    expect(isUntitledNotePath('notes/uuuuuuuuuuuuuuuuuuuuuuuuuu.md')).toBe(false)
    // A ULID-shaped name outside notes/ is not a placeholder.
    expect(isUntitledNotePath('01jxk2v9qz3m4n5p6r7s8t9vwx.md')).toBe(false)
  })
})

describe('deferredCreationPolicy', () => {
  it('lets a daily note be created lazily without a seed or rename tracking', () => {
    expect(deferredCreationPolicy('daily/2026-06-12.md')).toEqual({
      lazyCreatable: true,
      seedsUntitled: false,
      trackRenames: false,
    })
  })

  it('lets an untitled ULID note be created lazily from the seed, tracking renames', () => {
    expect(deferredCreationPolicy('notes/01jxk2v9qz3m4n5p6r7s8t9vwx.md')).toEqual({
      lazyCreatable: true,
      seedsUntitled: true,
      trackRenames: true,
    })
  })

  it('refuses lazy creation of a titled note but tracks its renames', () => {
    expect(deferredCreationPolicy('notes/meeting-notes.md')).toEqual({
      lazyCreatable: false,
      seedsUntitled: false,
      trackRenames: true,
    })
  })

  it('refuses lazy creation of a template and never tracks its renames', () => {
    expect(deferredCreationPolicy('templates/weekly.md')).toEqual({
      lazyCreatable: false,
      seedsUntitled: false,
      trackRenames: false,
    })
  })
})
