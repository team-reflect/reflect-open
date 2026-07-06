import { describe, expect, it } from 'vitest'
import { blockContextAt, prepareBlockContext } from './block-context'

/** Offset of the first `[[target]]` occurrence — the index's `pos_from`. */
function posOf(content: string, link: string): number {
  const pos = content.indexOf(link)
  if (pos === -1) {
    throw new Error(`link ${link} not in fixture`)
  }
  return pos
}

describe('blockContextAt', () => {
  it('returns the whole paragraph, not just the physical line', () => {
    const content = 'intro line\n\nfirst wrapped line with [[Target]]\nsecond wrapped line\n\nafter\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      'first wrapped line with [[Target]]\nsecond wrapped line',
    )
  })

  it('maps whole-file offsets across frontmatter', () => {
    const content = '---\ntitle: Note\n---\n\na paragraph with [[Target]] inside\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      'a paragraph with [[Target]] inside',
    )
  })

  it('returns the heading plus its section, stopping at the next heading of any level', () => {
    const content = [
      '# Title',
      '',
      'intro',
      '',
      '## Meeting [[Target]]',
      '',
      'notes for the meeting',
      '',
      '- a bullet',
      '',
      '### Sub',
      '',
      'unrelated',
      '',
    ].join('\n')
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '## Meeting [[Target]]\n\nnotes for the meeting\n\n- a bullet',
    )
  })

  it('runs a trailing heading section to the end of the document', () => {
    const content = '## Heading [[Target]]\n\nlast paragraph\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '## Heading [[Target]]\n\nlast paragraph',
    )
  })

  it('shows only the heading line for a mention in the note title H1', () => {
    // Divergence from old Reflect, where titles lived outside the document: the
    // section rule would inline the entire note for a title mention.
    const content = '# Meeting with [[Target]]\n\nagenda item one\n\nagenda item two\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '# Meeting with [[Target]]',
    )
  })

  it('keeps the section rule for a non-title H1', () => {
    const content = '# Title\n\nintro\n\n# Second [[Target]]\n\nsection body\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '# Second [[Target]]\n\nsection body',
    )
  })

  it('treats a setext H1 title the same as an ATX title', () => {
    const content = 'With [[Target]]\n====\n\nbody paragraph\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe('With [[Target]]\n====')
  })

  it('returns a top-level list item with all its children, mentioning or not', () => {
    const content = [
      '- kickoff with [[Target]]',
      '  - prep the agenda',
      '  - book the room',
      '- unrelated sibling',
      '',
    ].join('\n')
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '- kickoff with [[Target]]\n  - prep the agenda\n  - book the room',
    )
  })

  it('keeps task children inside a top-level item', () => {
    const content = '- [[Target]] kickoff\n  + [ ] prep agenda\n  + [x] send invite\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '- [[Target]] kickoff\n  + [ ] prep agenda\n  + [x] send invite',
    )
  })

  it('shows a nested mention under its parent line, dropping mention-less siblings', () => {
    const content = [
      '- parent line',
      '  - mention of [[Target]]',
      '    - grandchild detail',
      '  - unrelated sibling',
      '',
    ].join('\n')
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '- parent line\n  - mention of [[Target]]\n    - grandchild detail',
    )
  })

  it('keeps sibling branches that mention the same target', () => {
    const content = [
      '- parent line',
      '  - first [[Target]] mention',
      '  - also [[Target]] here',
      '  - nothing relevant',
      '',
    ].join('\n')
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '- parent line\n  - first [[Target]] mention\n  - also [[Target]] here',
    )
  })

  it('co-groups sibling branches through any of the target keys, like V1 id matching', () => {
    const content = [
      '- parent line',
      '  - one [[Project X]]',
      '  - two [[projx]]',
      '  - three [[Other Note]]',
      '',
    ].join('\n')
    const targetKeys = new Set(['project x', 'projx'])
    expect(blockContextAt(content, posOf(content, '[[Project X]]'), targetKeys)).toBe(
      '- parent line\n  - one [[Project X]]\n  - two [[projx]]',
    )
  })

  it('matches sibling mentions case-insensitively, like link resolution', () => {
    const content = '- parent line\n  - one [[Target]]\n  - two [[target]]\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '- parent line\n  - one [[Target]]\n  - two [[target]]',
    )
  })

  it('handles ordered lists, keeping source numbering', () => {
    const content = '1. parent line\n   2. mention of [[Target]]\n   3. unrelated\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '1. parent line\n   2. mention of [[Target]]',
    )
  })

  it('keeps both paragraphs of a loose list item', () => {
    const content = '- first paragraph\n\n  second [[Target]] paragraph\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '- first paragraph\n\n  second [[Target]] paragraph',
    )
  })

  it('dedents tab-indented nesting by the parent indent only', () => {
    const content = '- top\n\t- middle\n\t\t- deep [[Target]]\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '- middle\n\t- deep [[Target]]',
    )
  })

  it('climbs exactly one ancestor level for a deeply nested mention', () => {
    const content = [
      '- top item',
      '  - middle item',
      '    - deep [[Target]] mention',
      '  - other branch',
      '',
    ].join('\n')
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '- middle item\n  - deep [[Target]] mention',
    )
  })

  it('strips blockquote chrome from a quoted paragraph', () => {
    const content = '> quoted [[Target]] mention\n> second quoted line\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      'quoted [[Target]] mention\nsecond quoted line',
    )
  })

  it('returns the whole table for a mention in a cell', () => {
    const content = '| a | b |\n| --- | --- |\n| [[Target]] | y |\n'
    expect(blockContextAt(content, posOf(content, '[[Target]]'))).toBe(
      '| a | b |\n| --- | --- |\n| [[Target]] | y |',
    )
  })

  it('falls back to the bare line when the offset drifted between blocks', () => {
    const content = 'first paragraph\n\nsecond paragraph\n'
    expect(blockContextAt(content, content.indexOf('\n\n') + 1)).toBe('')
  })

  it('extracts several contexts from one prepared source', () => {
    const content = '---\ntitle: Note\n---\n\nfirst [[Target]] mention\n\n- second [[Target]]\n'
    const source = prepareBlockContext(content)
    expect(blockContextAt(source, posOf(content, '[[Target]]'))).toBe('first [[Target]] mention')
    expect(blockContextAt(source, content.lastIndexOf('[[Target]]'))).toBe('- second [[Target]]')
  })
})
