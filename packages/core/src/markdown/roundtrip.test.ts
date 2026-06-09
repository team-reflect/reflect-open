import { describe, expect, it } from 'vitest'
import { renameWikiLink } from './edit'
import { parseNote } from './extract'

/**
 * Golden corpus + non-destructiveness gates (Plan 03). Markdown is the source of
 * truth and files may be edited outside Reflect, so the bar is: every input
 * parses into a usable note, and position-based edits touch only what they must.
 */
const CORPUS: Record<string, string> = {
  reflect: '---\nid: 01HXX\naliases: [pjx]\n---\n# Project X\n\nLinks [[Charlotte]] and #status/active.\n',
  obsidian: '# Notes\n\nSee [[Some Page|alias]] and ![img](assets/a.png) and [ext](https://x.com).\n',
  gfm: '## Tasks\n\n- [ ] todo\n- [x] done\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n~~strike~~\n',
  brokenFrontmatter: '---\nfoo: [unclosed\n---\n# Still Readable\n\n[[Linked]]\n',
  crlf: '# Title\r\n\r\nA [[Wiki]] link.\r\n',
  noFrontmatter: 'just text with a #tag and a [[Link]]\n',
  emptyFrontmatter: '---\n---\n# Body\n',
}

describe('markdown corpus', () => {
  it('parses every fixture into a usable note without throwing', () => {
    for (const [name, source] of Object.entries(CORPUS)) {
      const note = parseNote({ path: `notes/${name}.md`, source })
      expect(note.title, name).toBeTypeOf('string')
      expect(note.title.length, name).toBeGreaterThan(0)
    }
  })

  it('keeps broken frontmatter readable: warns but still extracts links', () => {
    const note = parseNote({ path: 'notes/broken.md', source: CORPUS.brokenFrontmatter })
    expect(note.frontmatterWarning).toBeDefined()
    expect(note.title).toBe('Still Readable')
    expect(note.wikiLinks.map((w) => w.target)).toEqual(['Linked'])
  })

  it('separates the Reflect fixture into frontmatter, links, and tags', () => {
    const note = parseNote({ path: 'notes/reflect.md', source: CORPUS.reflect })
    expect(note.id).toBe('01HXX')
    expect(note.title).toBe('Project X')
    expect(note.wikiLinks.map((w) => w.target)).toEqual(['Charlotte'])
    expect(note.tags).toEqual(['status/active'])
  })
})

describe('edits are non-destructive', () => {
  it('renaming a non-existent target is byte-identical across the whole corpus', () => {
    for (const source of Object.values(CORPUS)) {
      expect(renameWikiLink(source, 'Nonexistent', 'Whatever')).toBe(source)
    }
  })

  it('preserves CRLF line endings outside the edited span', () => {
    const renamed = renameWikiLink(CORPUS.crlf, 'Wiki', 'Renamed')
    expect(renamed).toBe('# Title\r\n\r\nA [[Renamed]] link.\r\n')
  })
})
