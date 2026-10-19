import { describe, expect, it } from 'vitest'
import { createNodeTestDatabaseService } from '../testing/database.ts'
import { connectIndex, disconnectIndex, project } from './flow-test-harness.ts'

/**
 * End-to-end flow for usage ranking: notes are projected from real Markdown
 * into the production schema, and the suggestion queries read the link counts
 * back out of it.
 */
describe('link usage flow', () => {
  it('surfaces a much-linked note that many newer matches would bury', async () => {
    const database = createNodeTestDatabaseService()
    database.applyProjection(project('notes/sam-brown.md', '# Sam Brown\n', 1))
    for (let index = 0; index < 250; index++) {
      database.applyProjection(
        project(`notes/sam-${index}.md`, `# Sam Other ${index}\n`, 1000 + index),
      )
    }
    for (let day = 10; day < 20; day++) {
      database.applyProjection(
        project(
          `daily/2026-01-${day}.md`,
          'Talked to [[Sam Brown]] and [[sam brown]].\n',
          5000 + day,
        ),
      )
    }
    const index = connectIndex(database)
    try {
      const { suggestions } = await index.suggestions.suggestWikiLinkTargets('sam')
      expect(suggestions[0]).toMatchObject({ path: 'notes/sam-brown.md' })
    } finally {
      disconnectIndex(database)
    }
  })

  it('counts links written through an alias', async () => {
    const database = createNodeTestDatabaseService()
    database.applyProjection(
      project('notes/john-smith.md', '---\naliases: [JS]\n---\n# John Smith\n', 1),
    )
    database.applyProjection(project('notes/john-doe.md', '# John Doe\n', 900))
    database.applyProjection(project('notes/a.md', '# A\n[[JS]]\n', 10))
    database.applyProjection(project('notes/b.md', '# B\n[[JS]]\n', 11))
    const index = connectIndex(database)
    try {
      const suggestions = await index.suggestions.suggestWikiTargets('john')
      expect(suggestions.map((s) => s.path)).toEqual(['notes/john-smith.md', 'notes/john-doe.md'])
    } finally {
      disconnectIndex(database)
    }
  })

  it('fills the unqueried list with the most-linked notes and no dailies', async () => {
    const database = createNodeTestDatabaseService()
    database.applyProjection(project('notes/hub.md', '# Hub\n', 1))
    database.applyProjection(project('notes/fresh.md', '# Fresh\n', 900))
    database.applyProjection(project('daily/2026-01-10.md', '[[Hub]] [[2026-01-11]]\n', 5000))
    database.applyProjection(project('daily/2026-01-11.md', '[[Hub]]\n', 5001))
    const index = connectIndex(database)
    try {
      const suggestions = await index.suggestions.suggestWikiTargets('')
      expect(suggestions.map((s) => s.path)).toEqual(['notes/hub.md', 'notes/fresh.md'])
    } finally {
      disconnectIndex(database)
    }
  })
})
