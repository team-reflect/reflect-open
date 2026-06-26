import { describe, expect, it } from 'vitest'
import { hasAuthoredTitle, isTagName, parseNote } from './extract'

function parse(source: string, path = 'notes/test.md') {
  return parseNote({ path, source })
}

describe('parseNote — wiki links', () => {
  it('extracts plain, aliased, and date targets with positions', () => {
    const note = parse('See [[Charlotte]] and [[Project X|the project]] on [[2026-06-09]].')
    expect(note.wikiLinks.map((w) => ({ target: w.target, alias: w.alias }))).toEqual([
      { target: 'Charlotte', alias: undefined },
      { target: 'Project X', alias: 'the project' },
      { target: '2026-06-09', alias: undefined },
    ])
    const first = note.wikiLinks[0]!
    expect(note.text.slice(0)).toContain('Charlotte')
    expect(first.from).toBe('See '.length)
    expect(first.to).toBe('See [[Charlotte]]'.length)
  })

  it('renders markdown escapes inside wiki-link targets and aliases', () => {
    const note = parse('See [[www\\.reddit.com/r/test|www\\.reddit.com]].')
    expect(note.wikiLinks.map((w) => ({ target: w.target, alias: w.alias }))).toEqual([
      { target: 'www.reddit.com/r/test', alias: 'www.reddit.com' },
    ])
    expect(note.text).toBe('See www.reddit.com/r/test www.reddit.com.')
  })

  it('does not match wiki links inside code spans or empty brackets', () => {
    const note = parse('Code `[[NotALink]]` stays literal, and [[]] is ignored.')
    expect(note.wikiLinks).toEqual([])
  })

  it('does not let a wiki link span a line break', () => {
    const note = parse('[[broken\nlink]]')
    expect(note.wikiLinks).toEqual([])
  })
})

describe('parseNote — headings & title', () => {
  it('extracts ATX headings with level and slug', () => {
    const note = parse('# Title\n\n## A Section!\n\nbody')
    expect(note.headings).toEqual([
      expect.objectContaining({ level: 1, text: 'Title', slug: 'title' }),
      expect.objectContaining({ level: 2, text: 'A Section!', slug: 'a-section' }),
    ])
  })

  it('renders markdown escapes in headings and derived titles', () => {
    const note = parse('# www\\.reddit.com/r/test\n\nbody')
    expect(note.title).toBe('www.reddit.com/r/test')
    expect(note.headings[0]).toEqual(
      expect.objectContaining({ text: 'www.reddit.com/r/test', slug: 'wwwredditcomrtest' }),
    )
    expect(note.text).toBe('www.reddit.com/r/test body')
  })

  it('derives title from frontmatter, else first H1, else filename/date', () => {
    expect(parse('---\ntitle: From FM\n---\n# Ignored').title).toBe('From FM')
    expect(parse('# The H1\n\nbody').title).toBe('The H1')
    expect(parse('no heading', 'notes/charlotte-maccaw.md').title).toBe('charlotte-maccaw')
    expect(parse('no heading', 'daily/2026-06-09.md').title).toBe('2026-06-09')
  })

  it('hasAuthoredTitle mirrors the derivation: true iff the title is not a path fallback', () => {
    expect(hasAuthoredTitle(parse('---\ntitle: From FM\n---\nbody'))).toBe(true)
    expect(hasAuthoredTitle(parse('# The H1\n\nbody'))).toBe(true)
    expect(hasAuthoredTitle(parse('no heading', 'notes/charlotte-maccaw.md'))).toBe(false)
    expect(hasAuthoredTitle(parse('## only a section', 'notes/x.md'))).toBe(false)
    expect(hasAuthoredTitle(parse('---\ntitle: "  "\n---\nbody'))).toBe(false)
    expect(hasAuthoredTitle(parse('no heading', 'daily/2026-06-09.md'))).toBe(false)
  })
})

describe('isTagName', () => {
  it('accepts names the #tag grammar can produce', () => {
    expect(isTagName('book')).toBe(true)
    expect(isTagName('project/reflect')).toBe(true)
    expect(isTagName('v2_plan-b')).toBe(true)
    expect(isTagName('café')).toBe(true)
  })

  it('rejects names the indexer can never produce', () => {
    expect(isTagName('')).toBe(false)
    expect(isTagName('my tag')).toBe(false)
    expect(isTagName('123abc')).toBe(false)
    expect(isTagName('#book')).toBe(false)
    expect(isTagName('-dash')).toBe(false)
  })
})

describe('parseNote — links, assets, tags, text', () => {
  it('separates external links (with domain) from asset references', () => {
    const note = parse('[site](https://example.com/x) and ![pic](assets/photo.png)')
    expect(note.links).toEqual([
      expect.objectContaining({ href: 'https://example.com/x', text: 'site', domain: 'example.com' }),
    ])
    expect(note.assets).toEqual([expect.objectContaining({ path: 'assets/photo.png' })])
  })

  it('decodes percent-encoded asset hrefs to the on-disk path', () => {
    const note = parse('![pic](assets/my%20photo.png) and ![two](assets/a%2Bb.pdf)')
    expect(note.assets.map((asset) => asset.path)).toEqual([
      'assets/my photo.png',
      'assets/a+b.pdf',
    ])
  })

  it('canonicalizes ./ and .. asset path spellings to the on-disk form', () => {
    const note = parse('![a](./assets/a.png) ![b](assets/sub/../b.png) ![c](assets//c.png)')
    expect(note.assets.map((asset) => asset.path)).toEqual([
      'assets/a.png',
      'assets/b.png',
      'assets/c.png',
    ])
  })

  it('extracts body #tags only, deduped case-insensitively', () => {
    const note = parse('#alpha and #Alpha and #beta/sub, but not #123 or a#b')
    expect(note.tags).toEqual(['alpha', 'beta/sub'])
  })

  it('ignores a frontmatter tags key as a tag source', () => {
    const note = parse('---\ntags: [fromfm]\n---\nbody #real')
    expect(note.tags).toEqual(['real'])
  })

  it('produces collapsed plain text (markup stripped, wiki target+alias kept)', () => {
    const note = parse('# Hi\n\nSome **bold** text with [[Link|alias]].')
    expect(note.text).toBe('Hi Some bold text with Link alias.')
  })

  it('keeps markdown escapes literal inside code text', () => {
    const note = parse('Rendered www\\.reddit.com, code `www\\.reddit.com`.\n\n```\nwww\\.reddit.com\n```')
    expect(note.text).toBe('Rendered www.reddit.com, code www\\.reddit.com. www\\.reddit.com')
  })

  it('keeps #tags inside fenced code out of the tag list', () => {
    const note = parse('real #tag\n\n```\nnot #acode tag\n```')
    expect(note.tags).toEqual(['tag'])
  })
})

describe('parseNote — tasks', () => {
  it('extracts open and checked round task checkboxes with text, raw, marker offset', () => {
    const note = parse('+ [ ] buy milk\n+ [x] call mum\n')
    expect(note.tasks).toEqual([
      { text: 'buy milk', raw: '[ ] buy milk', checked: false, markerOffset: 2, dueDate: null },
      { text: 'call mum', raw: '[x] call mum', checked: true, markerOffset: 17, dueDate: null },
    ])
  })

  it('treats an uppercase [X] marker as checked', () => {
    const note = parse('+ [X] done\n')
    expect(note.tasks).toEqual([
      { text: 'done', raw: '[X] done', checked: true, markerOffset: 2, dueDate: null },
    ])
  })

  it('strips inline syntax from text but keeps it verbatim in raw', () => {
    const note = parse('+ [ ] call [[Bob]] about **billing**\n')
    const item = note.tasks[0]!
    expect(item.text).toBe('call Bob about billing')
    expect(item.raw).toBe('[ ] call [[Bob]] about **billing**')
    // markerOffset points at the `[` of the checkbox, not the wiki link.
    expect(item.checked).toBe(false)
    expect(item.markerOffset).toBe(2)
  })

  it('offsets the marker past frontmatter', () => {
    const source = '---\nid: abc\n---\n+ [ ] later\n'
    const note = parse(source)
    const item = note.tasks[0]!
    expect(item.markerOffset).toBe(source.indexOf('[ ]'))
    expect(source.slice(item.markerOffset, item.markerOffset + item.raw.length)).toBe(item.raw)
  })

  it('captures nested sub-tasks as their own rows', () => {
    const note = parse('+ [ ] parent\n  + [x] child\n')
    expect(note.tasks.map((task) => ({ text: task.text, checked: task.checked }))).toEqual([
      { text: 'parent', checked: false },
      { text: 'child', checked: true },
    ])
  })

  it('ignores checkboxes inside fenced code', () => {
    const note = parse('+ [ ] real\n\n```\n+ [ ] not a task\n```\n')
    expect(note.tasks).toEqual([
      { text: 'real', raw: '[ ] real', checked: false, markerOffset: 2, dueDate: null },
    ])
  })

  it('ignores square checklist and ordered checkbox items', () => {
    const note = parse('- [ ] checklist\n* [x] checklist\n1. [ ] ordered\n')
    expect(note.tasks).toEqual([])
  })

  it('yields no tasks for a plain bullet list', () => {
    const note = parse('- just a bullet\n- another\n')
    expect(note.tasks).toEqual([])
  })

  it('reads the first calendar [[YYYY-MM-DD]] link in the item as the due date', () => {
    const note = parse('+ [ ] ship it [[2026-07-01]] and review [[2026-08-01]]\n')
    expect(note.tasks[0]!.dueDate).toBe('2026-07-01') // first date link wins
  })

  it('ignores an impossible date as a due date', () => {
    const note = parse('+ [ ] not a real day [[2026-02-31]]\n')
    expect(note.tasks[0]!.dueDate).toBeNull()
  })

  it('does not borrow a due-date link from a neighbouring task', () => {
    const note = parse('+ [ ] no date here\n+ [ ] dated [[2026-07-01]]\n')
    expect(note.tasks.map((task) => task.dueDate)).toEqual([null, '2026-07-01'])
  })
})
