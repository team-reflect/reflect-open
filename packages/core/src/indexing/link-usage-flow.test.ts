import { describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge'
import { applyProjection, connectIndex, openMigratedIndex, project } from './flow-test-harness'
import { suggestWikiLinkTargets, suggestWikiTargets } from './queries'

/**
 * End-to-end flow for usage ranking: notes are projected from real Markdown
 * into the production schema, and the suggestion queries read the link counts
 * back out of it.
 */
describe('link usage flow', () => {
  it('surfaces a much-linked note that many newer matches would bury', async () => {
    const database = openMigratedIndex()
    applyProjection(database, project('notes/sam-brown.md', '# Sam Brown\n', 1))
    for (let index = 0; index < 250; index++) {
      applyProjection(
        database,
        project(`notes/sam-${index}.md`, `# Sam Other ${index}\n`, 1000 + index),
      )
    }
    for (let day = 10; day < 20; day++) {
      applyProjection(
        database,
        project(
          `daily/2026-01-${day}.md`,
          'Talked to [[Sam Brown]] and [[sam brown]].\n',
          5000 + day,
        ),
      )
    }
    connectIndex(database)
    try {
      const { suggestions } = await suggestWikiLinkTargets('sam')
      expect(suggestions[0]).toMatchObject({ path: 'notes/sam-brown.md' })
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('counts links written through an alias', async () => {
    const database = openMigratedIndex()
    applyProjection(
      database,
      project('notes/john-smith.md', '---\naliases: [JS]\n---\n# John Smith\n', 1),
    )
    applyProjection(database, project('notes/john-doe.md', '# John Doe\n', 900))
    applyProjection(database, project('notes/a.md', '# A\n[[JS]]\n', 10))
    applyProjection(database, project('notes/b.md', '# B\n[[JS]]\n', 11))
    connectIndex(database)
    try {
      const suggestions = await suggestWikiTargets('john')
      expect(suggestions.map((s) => s.path)).toEqual(['notes/john-smith.md', 'notes/john-doe.md'])
    } finally {
      setBridge(null)
      database.close()
    }
  })

  it('fills the unqueried list with the most-linked notes and no dailies', async () => {
    const database = openMigratedIndex()
    applyProjection(database, project('notes/hub.md', '# Hub\n', 1))
    applyProjection(database, project('notes/fresh.md', '# Fresh\n', 900))
    applyProjection(database, project('daily/2026-01-10.md', '[[Hub]] [[2026-01-11]]\n', 5000))
    applyProjection(database, project('daily/2026-01-11.md', '[[Hub]]\n', 5001))
    connectIndex(database)
    try {
      const suggestions = await suggestWikiTargets('')
      expect(suggestions.map((s) => s.path)).toEqual(['notes/hub.md', 'notes/fresh.md'])
    } finally {
      setBridge(null)
      database.close()
    }
  })
})
