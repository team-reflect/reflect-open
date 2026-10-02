import { describe, expect, it } from 'vitest'
import { parseNote } from './extract.ts'
import { headingMatchesBacklinkedTitle, linkedHeadingTarget } from './heading-blocks.ts'

function parseHeading(source: string) {
  const parsed = parseNote({ path: 'notes/Example.md', source })
  const heading = parsed.headings[0]
  if (heading === undefined) throw new Error('Fixture must contain a heading')
  return { heading, wikiLinks: parsed.wikiLinks }
}

describe('linkedHeadingTarget', () => {
  it.each([
    { name: 'an ATX heading', source: '## [[Tasks]]\n', target: 'Tasks' },
    { name: 'an aliased link', source: '## [[TASKS|House chores]]\n', target: 'TASKS' },
    { name: 'a padded target', source: '## [[ Tasks |House chores]]\n', target: 'Tasks' },
    { name: 'closing hashes', source: '## [[Tasks]] ###\n', target: 'Tasks' },
    { name: 'indentation', source: '   ## [[Tasks]] ###\n', target: 'Tasks' },
    { name: 'tabs around content', source: '## \t[[Tasks]]\t ###\t\n', target: 'Tasks' },
    { name: 'a level-one heading', source: '# [[Tasks]]\n', target: 'Tasks' },
    { name: 'a level-six heading', source: '###### [[Tasks]]\n', target: 'Tasks' },
    { name: 'a setext H1', source: '[[Tasks]]\n===\n', target: 'Tasks' },
    { name: 'a setext H2', source: '[[Tasks|House chores]]\n---\n', target: 'Tasks' },
    {
      name: 'frontmatter and CRLF offsets',
      source: '---\r\nprivate: true\r\n---\r\n\r\n## [[Tasks]] ##\r\n',
      target: 'Tasks',
    },
    {
      name: 'a setext heading after frontmatter',
      source: '---\r\nprivate: true\r\n---\r\n\r\n[[Tasks]]\r\n---\r\n',
      target: 'Tasks',
    },
  ])('identifies the target of $name', ({ source, target }) => {
    const { heading, wikiLinks } = parseHeading(source)

    expect(linkedHeadingTarget(source, heading, wikiLinks)).toBe(target)
    expect(headingMatchesBacklinkedTitle(source, heading, wikiLinks, 'tasks')).toBe(true)
  })

  it.each([
    { name: 'an empty heading', source: '##\n' },
    { name: 'an empty heading with closing hashes', source: '## ###\n' },
    { name: 'an alias without a target', source: '## [[|Tasks]]\n' },
    { name: 'a blank target', source: '## [[ |Tasks]]\n' },
    { name: 'escaped brackets', source: '## \\[[Tasks]]\n' },
    { name: 'inline code', source: '## `[[Tasks]]`\n' },
    { name: 'an embed', source: '## ![[Tasks]]\n' },
    { name: 'emphasis around a link', source: '## **[[Tasks]]**\n' },
    { name: 'prefix prose', source: '## My [[Tasks]]\n' },
    { name: 'suffix prose', source: '## [[Tasks]] today\n' },
    { name: 'multiple links', source: '## [[Tasks]] [[Tasks]]\n' },
    { name: 'a literal hash suffix', source: '## [[Tasks]]#\n' },
    { name: 'a multiline setext heading', source: '[[Tasks]]\nand more\n---\n' },
  ])('does not identify $name as a linked section', ({ source }) => {
    const { heading, wikiLinks } = parseHeading(source)

    expect(linkedHeadingTarget(source, heading, wikiLinks)).toBeNull()
    expect(headingMatchesBacklinkedTitle(source, heading, wikiLinks, 'Tasks')).toBe(false)
  })

  it('does not use a link from a different heading', () => {
    const source = '## Tasks\n\n## [[Tasks]]\n'
    const { heading, wikiLinks } = parseHeading(source)

    expect(linkedHeadingTarget(source, heading, wikiLinks)).toBeNull()
  })

  it('uses the parsed target with Markdown escapes already resolved', () => {
    const source = '## [[Tasks\\!|Inbox]]\n'
    const { heading, wikiLinks } = parseHeading(source)

    expect(linkedHeadingTarget(source, heading, wikiLinks)).toBe('Tasks!')
    expect(headingMatchesBacklinkedTitle(source, heading, wikiLinks, 'Tasks!')).toBe(true)
  })
})

describe('headingMatchesBacklinkedTitle', () => {
  it.each(['## Tasks\n', '## TASKS ###\n', 'Tasks\n---\n'])(
    'matches a plain heading case-insensitively: %s',
    (source) => {
      const { heading, wikiLinks } = parseHeading(source)

      expect(headingMatchesBacklinkedTitle(source, heading, wikiLinks, 'tasks')).toBe(true)
      expect(linkedHeadingTarget(source, heading, wikiLinks)).toBeNull()
    },
  )

  it('matches the target rather than the alias', () => {
    const source = '## [[House chores|Tasks]]\n'
    const { heading, wikiLinks } = parseHeading(source)

    expect(headingMatchesBacklinkedTitle(source, heading, wikiLinks, 'House chores')).toBe(true)
    expect(headingMatchesBacklinkedTitle(source, heading, wikiLinks, 'Tasks')).toBe(false)
  })

  it.each(['Task', 'Tasks:', 'Todo', 'House chores'])(
    'preserves the distinct heading %s',
    (title) => {
      const source = `## ${title}\n`
      const { heading, wikiLinks } = parseHeading(source)

      expect(headingMatchesBacklinkedTitle(source, heading, wikiLinks, 'Tasks')).toBe(false)
      expect(headingMatchesBacklinkedTitle(source, heading, wikiLinks, title)).toBe(true)
    },
  )
})
