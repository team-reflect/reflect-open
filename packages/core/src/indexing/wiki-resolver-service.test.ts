import { describe, expect, it } from 'vitest'
import {
  createNodeTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
  type TestNote,
} from '../testing/database.ts'
import { createWikiResolverService } from './wiki-resolver-service.ts'

function seeded(notes: readonly TestNote[]): TestDatabaseService {
  const database = createNodeTestDatabaseService()
  seedNotes(database, notes)
  return database
}

describe('getWikiAddressForPath', () => {
  it('uses the note_keys winner for the canonical title address', async () => {
    const database = seeded([{ path: 'notes/ada.md', markdown: '# Ada Lovelace\n' }])

    await expect(
      createWikiResolverService({ database }).getWikiAddressForPath('notes/ada.md'),
    ).resolves.toMatchObject({
      path: 'notes/ada.md',
      title: 'Ada Lovelace',
      insertText: 'Ada Lovelace',
    })
  })

  it('rescues an ambiguous title with a unique alias', async () => {
    const database = seeded([
      { path: 'notes/ada.md', markdown: '---\naliases: [Augusta Ada King]\n---\n# Ada Lovelace\n' },
      { path: 'notes/ada-2.md', markdown: '# Ada Lovelace\n' },
    ])

    await expect(
      createWikiResolverService({ database }).getWikiAddressForPath('notes/ada.md'),
    ).resolves.toMatchObject({
      path: 'notes/ada.md',
      alias: 'Augusta Ada King',
      insertText: 'Augusta Ada King|Ada Lovelace',
    })
  })

  it('returns null when the path is absent or a template', async () => {
    const database = seeded([{ path: 'templates/journal.md', markdown: '# Journal\n' }])
    const wikiResolver = createWikiResolverService({ database })

    await expect(wikiResolver.getWikiAddressForPath('notes/missing.md')).resolves.toBeNull()
    await expect(wikiResolver.getWikiAddressForPath('templates/journal.md')).resolves.toBeNull()
  })
})

describe('resolveWikiTarget', () => {
  it('resolves through the canonical note_keys winner map in one query', async () => {
    const database = seeded([
      { path: 'notes/alias.md', markdown: '---\naliases: [Dad]\n---\n# Father\n' },
      { path: 'notes/winner.md', markdown: '# Dad\n' },
    ])

    await expect(
      createWikiResolverService({ database }).resolveWikiTarget('  DAD  '),
    ).resolves.toEqual({ kind: 'resolved', ref: 'notes/winner.md' })
    expect(database.getQueries()).toHaveLength(1)
  })

  it('preserves trimmed text when the canonical address is unresolved', async () => {
    const database = seeded([{ path: 'notes/winner.md', markdown: '# Dad\n' }])

    await expect(
      createWikiResolverService({ database }).resolveWikiTarget('  Missing  '),
    ).resolves.toEqual({ kind: 'unresolved', text: 'Missing' })
  })

  it('short-circuits a blank target before querying the index', async () => {
    const database = createNodeTestDatabaseService()

    await expect(createWikiResolverService({ database }).resolveWikiTarget('   ')).resolves.toEqual(
      { kind: 'unresolved', text: '' },
    )
    expect(database.getQueries()).toEqual([])
  })
})

describe('findWikiTargetMatch', () => {
  it('returns the winning tier in one indexed read, preserving ambiguity', async () => {
    const database = seeded([
      { path: 'notes/business-ideas.md', markdown: '# Business Ideas\n' },
      { path: 'notes/business-ideas-2.md', markdown: '# Business Ideas\n' },
      { path: 'notes/plans.md', markdown: '---\naliases: [Business Ideas]\n---\n# Plans\n' },
    ])

    await expect(
      createWikiResolverService({ database }).findWikiTargetMatch('business ideas'),
    ).resolves.toEqual({
      tier: 2,
      paths: ['notes/business-ideas-2.md', 'notes/business-ideas.md'],
    })
    expect(database.getQueries()).toHaveLength(1)
  })

  it('reports an unclaimed key as tier 0 and never queries when the key is blank', async () => {
    const database = createNodeTestDatabaseService()
    const wikiResolver = createWikiResolverService({ database })

    await expect(wikiResolver.findWikiTargetMatch('missing')).resolves.toEqual({
      tier: 0,
      paths: [],
    })
    await expect(wikiResolver.findWikiTargetMatch('')).resolves.toEqual({ tier: 0, paths: [] })
    expect(database.getQueries()).toHaveLength(1)
  })

  it('reads a daily-date claim from the same table as every other tier', async () => {
    const database = seeded([{ path: 'daily/2026-06-09.md', markdown: 'Standup\n' }])

    await expect(
      createWikiResolverService({ database }).findWikiTargetMatch('2026-06-09'),
    ).resolves.toEqual({ tier: 1, paths: ['daily/2026-06-09.md'] })
  })
})

describe('findNotesByPathKey', () => {
  it('selects by the folded path and never queries a blank key', async () => {
    const database = seeded([
      { path: 'Projects/Plan.md', markdown: '# Plan\n' },
      { path: 'notes/plan.md', markdown: '# Plan\n' },
    ])
    const wikiResolver = createWikiResolverService({ database })

    await expect(wikiResolver.findNotesByPathKey('projects/plan.md')).resolves.toEqual([
      'Projects/Plan.md',
    ])
    await expect(wikiResolver.findNotesByPathKey('')).resolves.toEqual([])
    expect(database.getQueries()).toHaveLength(1)
  })
})

describe('getLinkSources and getPathLinkSources', () => {
  it('list distinct sources by folded target key and by folded target path', async () => {
    const database = seeded([
      { path: 'notes/target.md', markdown: '# Target\n' },
      { path: 'notes/b.md', markdown: '[[Target]] and [[target]]\n' },
      { path: 'notes/a.md', markdown: '[[TARGET]]\n' },
      { path: 'notes/c.md', markdown: '[[notes/target]]\n' },
    ])
    const wikiResolver = createWikiResolverService({ database })

    await expect(wikiResolver.getLinkSources('target')).resolves.toEqual([
      'notes/a.md',
      'notes/b.md',
    ])
    await expect(wikiResolver.getPathLinkSources('notes/target.md')).resolves.toEqual([
      'notes/c.md',
    ])
  })
})
