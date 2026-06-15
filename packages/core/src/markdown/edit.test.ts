import { describe, expect, it } from 'vitest'
import { parseNote } from './extract'
import {
  appendBlock,
  appendUnderHeading,
  renameWikiLink,
  TaskStaleError,
  toggleTaskMarker,
} from './edit'

describe('renameWikiLink', () => {
  it('rewrites matching targets, preserves aliases, skips code and non-matches', () => {
    const source = '[[Foo]] and [[foo|bar]] and `[[Foo]]` and [[Other]]'
    expect(renameWikiLink(source, 'Foo', 'Baz')).toBe(
      '[[Baz]] and [[Baz|bar]] and `[[Foo]]` and [[Other]]',
    )
  })

  it('is a byte-identical no-op when nothing matches', () => {
    const source = 'see [[Alpha]] and [[Beta]]'
    expect(renameWikiLink(source, 'Gamma', 'Delta')).toBe(source)
  })

  it('matches on the trimmed, case-folded target', () => {
    const source = '[[ Foo ]] and [[Foo]] and [[ foo|bar]]'
    expect(renameWikiLink(source, 'Foo', 'Baz')).toBe('[[Baz]] and [[Baz]] and [[Baz|bar]]')
  })

  it('rejects a destination target containing wiki-link syntax', () => {
    expect(() => renameWikiLink('[[Foo]]', 'Foo', 'A|B')).toThrow(/invalid wiki-link target/i)
  })
})

describe('appendUnderHeading', () => {
  const doc = '# A\n\nalpha\n\n# B\n\nbeta'

  it('inserts at the end of a heading section, before the next sibling heading', () => {
    expect(appendUnderHeading(doc, 'A', '- new')).toBe('# A\n\nalpha\n\n- new\n\n# B\n\nbeta')
  })

  it('appends at end of file for the last section', () => {
    expect(appendUnderHeading(doc, 'B', '- new')).toBe('# A\n\nalpha\n\n# B\n\nbeta\n\n- new\n')
  })

  it('creates a new section when the heading is missing', () => {
    expect(appendUnderHeading(doc, 'Inbox', '- new')).toBe(
      '# A\n\nalpha\n\n# B\n\nbeta\n\n## Inbox\n\n- new\n',
    )
  })

  it('matches the heading case-insensitively', () => {
    expect(appendUnderHeading(doc, 'a', '- new')).toBe('# A\n\nalpha\n\n- new\n\n# B\n\nbeta')
  })
})

describe('appendBlock', () => {
  it('appends one blank line after the existing content', () => {
    expect(appendBlock('alpha\n', 'new text')).toBe('alpha\n\nnew text\n')
  })

  it('collapses extra trailing whitespace to the single separator', () => {
    expect(appendBlock('alpha\n\n\n', 'new text')).toBe('alpha\n\nnew text\n')
  })

  it('becomes the whole body of an empty note', () => {
    expect(appendBlock('', 'new text')).toBe('new text\n')
    expect(appendBlock('\n', 'new text')).toBe('new text\n')
  })

  it('appends after frontmatter when the note has nothing else', () => {
    expect(appendBlock('---\nprivate: true\n---\n', 'new text')).toBe(
      '---\nprivate: true\n---\n\nnew text\n',
    )
  })

  it('trims the block itself', () => {
    expect(appendBlock('alpha', '  new text \n')).toBe('alpha\n\nnew text\n')
  })
})

describe('toggleTaskMarker', () => {
  /** The first task's `{ markerOffset, raw }` as the index would record it. */
  function indexedTask(source: string) {
    const [task] = parseNote({ path: 'notes/n.md', source }).tasks
    return { markerOffset: task.markerOffset, raw: task.raw }
  }

  it('checks an open task, changing only the marker', () => {
    const source = '# Todo\n\n- [ ] buy milk\n- [ ] call mum\n'
    const result = toggleTaskMarker(source, indexedTask(source))
    expect(result.checked).toBe(true)
    expect(result.source).toBe('# Todo\n\n- [x] buy milk\n- [ ] call mum\n')
  })

  it('unchecks a completed task', () => {
    const source = '- [x] done\n'
    const result = toggleTaskMarker(source, indexedTask(source))
    expect(result.checked).toBe(false)
    expect(result.source).toBe('- [ ] done\n')
  })

  it('relocates the task by its line when an edit above shifted the offset', () => {
    const source = '- [ ] buy milk\n'
    const stale = indexedTask(source)
    // A paragraph was inserted above the task, so the recorded offset is wrong;
    // the raw line still locates it uniquely.
    const edited = `Some new intro.\n\n${source}`
    const result = toggleTaskMarker(edited, stale)
    expect(result.source).toBe('Some new intro.\n\n- [x] buy milk\n')
  })

  it('refuses loudly when the task line is gone', () => {
    const source = '- [ ] buy milk\n'
    const task = indexedTask(source)
    expect(() => toggleTaskMarker('- [ ] something else\n', task)).toThrow(TaskStaleError)
  })

  it('refuses loudly when the task line is ambiguous and the offset is stale', () => {
    const source = '- [ ] dup\n'
    const task = indexedTask(source)
    // Two identical lines and a stale offset: which one is unknowable.
    expect(() => toggleTaskMarker('intro\n\n- [ ] dup\n- [ ] dup\n', task)).toThrow(TaskStaleError)
  })

  it('round-trips back to the original after two toggles', () => {
    const source = '- [ ] task [[2026-07-01]] #tag\n'
    const once = toggleTaskMarker(source, indexedTask(source))
    const twice = toggleTaskMarker(once.source, indexedTask(once.source))
    expect(twice.source).toBe(source)
  })
})
