import { describe, expect, it } from 'vitest'
import { parseNote } from './extract'
import {
  appendBlock,
  appendTaskLine,
  appendUnderHeading,
  clearTaskDueDate,
  editTaskLine,
  removeTaskLine,
  renameWikiLink,
  setTaskDueDate,
  taskLineToBullet,
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
    const task = parseNote({ path: 'notes/n.md', source }).tasks[0]!
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

  it('relocates to the real task line, not a coincidental inline match', () => {
    const task = indexedTask('- [ ] dup\n')
    // The same text appears inline (not a task) and as a task, and the recorded
    // offset is stale. Relocation re-extracts tasks, so it can only toggle the
    // real list item — the inline mention is untouched.
    const result = toggleTaskMarker('mention [ ] dup inline\n\n- [ ] dup\n', task)
    expect(result.source).toBe('mention [ ] dup inline\n\n- [x] dup\n')
  })

  it('never toggles a marker that only appears inside a code block', () => {
    const task = indexedTask('- [ ] incode\n')
    // The line moved into a fenced code block, so it is no longer a task; a raw
    // string search would have spliced it, but re-extraction sees no task.
    expect(() => toggleTaskMarker('```\n- [ ] incode\n```\n', task)).toThrow(TaskStaleError)
  })

  it('refuses the offset fast-path when its byte-matching line is no longer a task', () => {
    // `[ ] x` still sits verbatim at offset 4, but inside a fenced code block —
    // so it is not a parsed task. The fast path must re-validate, not trust bytes.
    expect(() => toggleTaskMarker('```\n[ ] x\n```\n', { markerOffset: 4, raw: '[ ] x' })).toThrow(
      TaskStaleError,
    )
  })

  it('round-trips back to the original after two toggles', () => {
    const source = '- [ ] task [[2026-07-01]] #tag\n'
    const once = toggleTaskMarker(source, indexedTask(source))
    const twice = toggleTaskMarker(once.source, indexedTask(once.source))
    expect(twice.source).toBe(source)
  })
})

describe('editTaskLine', () => {
  /** The first task's `{ markerOffset, raw }` as the index would record it. */
  function indexedTask(source: string) {
    const task = parseNote({ path: 'notes/n.md', source }).tasks[0]!
    return { markerOffset: task.markerOffset, raw: task.raw }
  }

  it('replaces the content after the marker, keeping bullet and marker', () => {
    const source = '# Todo\n\n- [ ] buy milk\n- [ ] call mum\n'
    expect(editTaskLine(source, indexedTask(source), 'buy oat milk')).toBe(
      '# Todo\n\n- [ ] buy oat milk\n- [ ] call mum\n',
    )
  })

  it('preserves a checked marker and the line ending', () => {
    const source = '- [x] done\n'
    expect(editTaskLine(source, indexedTask(source), 'really done')).toBe('- [x] really done\n')
  })

  it('keeps the indentation and bullet style of a nested item', () => {
    const source = '  * [ ] nested task\n'
    expect(editTaskLine(source, indexedTask(source), 'edited')).toBe('  * [ ] edited\n')
  })

  it('trims surrounding whitespace from the new content', () => {
    const source = '- [ ] a\n'
    expect(editTaskLine(source, indexedTask(source), '  spaced  ')).toBe('- [ ] spaced\n')
  })

  it('rewrites links and tags in the new content verbatim', () => {
    const source = '- [ ] plain\n'
    expect(editTaskLine(source, indexedTask(source), 'ship [[2026-07-01]] #release')).toBe(
      '- [ ] ship [[2026-07-01]] #release\n',
    )
  })

  it('clears to a bare marker when the content is empty', () => {
    const source = '- [ ] gone soon\n'
    expect(editTaskLine(source, indexedTask(source), '   ')).toBe('- [ ]\n')
  })

  it('relocates by the raw line when an edit above shifted the offset', () => {
    const source = '- [ ] buy milk\n'
    const stale = indexedTask(source)
    expect(editTaskLine(`Intro.\n\n${source}`, stale, 'buy oat milk')).toBe(
      'Intro.\n\n- [ ] buy oat milk\n',
    )
  })

  it('refuses content with an embedded newline (would split the item)', () => {
    const source = '- [ ] one\n'
    expect(() => editTaskLine(source, indexedTask(source), 'one\n- [ ] two')).toThrow(TaskStaleError)
  })

  it('refuses content with a carriage return too', () => {
    const source = '- [ ] one\n'
    expect(() => editTaskLine(source, indexedTask(source), 'one\r- [ ] two')).toThrow(TaskStaleError)
  })

  it('refuses loudly when the task line is gone', () => {
    const source = '- [ ] buy milk\n'
    const task = indexedTask(source)
    expect(() => editTaskLine('- [ ] something else\n', task, 'x')).toThrow(TaskStaleError)
  })
})

describe('appendTaskLine', () => {
  it('starts the note with a single empty task', () => {
    const { source, markerOffset } = appendTaskLine('')
    expect(source).toBe('- [ ] \n')
    const task = parseNote({ path: 'n.md', source }).tasks[0]!
    expect(task.markerOffset).toBe(markerOffset)
    expect(task.text).toBe('')
    expect(task.checked).toBe(false)
  })

  it('continues an existing task list and reports the new marker offset', () => {
    const { source, markerOffset } = appendTaskLine('- [ ] buy milk\n')
    expect(source).toBe('- [ ] buy milk\n- [ ] \n')
    const tasks = parseNote({ path: 'n.md', source }).tasks
    expect(tasks).toHaveLength(2)
    expect(tasks[1]!.markerOffset).toBe(markerOffset)
    expect(tasks[1]!.text).toBe('')
  })

  it('appends after prose, with the marker locatable by the parser', () => {
    const { source, markerOffset } = appendTaskLine('# Notes\n\nsome intro')
    const tasks = parseNote({ path: 'n.md', source }).tasks
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.markerOffset).toBe(markerOffset)
  })
})

describe('setTaskDueDate', () => {
  it('appends a due-date link to undated content', () => {
    expect(setTaskDueDate('buy milk', '2026-07-01')).toBe('buy milk [[2026-07-01]]')
  })

  it('becomes the whole content when it was empty', () => {
    expect(setTaskDueDate('', '2026-07-01')).toBe('[[2026-07-01]]')
  })

  it('replaces an existing due-date link, keeping the rest', () => {
    expect(setTaskDueDate('ship [[2026-06-01]] #release', '2026-07-01')).toBe(
      'ship [[2026-07-01]] #release',
    )
  })

  it('replaces the first valid date link and drops its alias', () => {
    expect(setTaskDueDate('do [[2026-06-01|June 1]]', '2026-07-01')).toBe('do [[2026-07-01]]')
  })

  it('ignores a non-date wiki link and appends instead', () => {
    expect(setTaskDueDate('see [[Project]]', '2026-07-01')).toBe('see [[Project]] [[2026-07-01]]')
  })

  it('skips an impossible date and appends a fresh one', () => {
    // [[2026-02-31]] isn't a real day, so it isn't a due date — append, don't replace.
    expect(setTaskDueDate('plan [[2026-02-31]]', '2026-07-01')).toBe(
      'plan [[2026-02-31]] [[2026-07-01]]',
    )
  })
})

describe('clearTaskDueDate', () => {
  it('removes the due-date link and tidies the whitespace', () => {
    expect(clearTaskDueDate('ship [[2026-06-01]] #release')).toBe('ship #release')
  })

  it('leaves content without a due date untouched', () => {
    expect(clearTaskDueDate('see [[Project]]')).toBe('see [[Project]]')
  })

  it('empties content that was only a due date', () => {
    expect(clearTaskDueDate('[[2026-06-01]]')).toBe('')
  })
})

describe('removeTaskLine', () => {
  function indexedTask(source: string, index = 0) {
    const task = parseNote({ path: 'notes/n.md', source }).tasks[index]!
    return { markerOffset: task.markerOffset, raw: task.raw }
  }

  it('removes a middle task line and closes the gap', () => {
    const source = '- [ ] a\n- [ ] b\n- [ ] c\n'
    expect(removeTaskLine(source, indexedTask(source, 1))).toBe('- [ ] a\n- [ ] c\n')
  })

  it('removes the first task line', () => {
    const source = '- [ ] a\n- [ ] b\n'
    expect(removeTaskLine(source, indexedTask(source, 0))).toBe('- [ ] b\n')
  })

  it('empties a note whose only line was the task', () => {
    expect(removeTaskLine('- [ ] only\n', indexedTask('- [ ] only\n'))).toBe('')
  })

  it('removes a final task with no trailing newline, keeping the line above', () => {
    const source = 'intro\n- [ ] last'
    expect(removeTaskLine(source, indexedTask(source))).toBe('intro\n')
  })

  it('leaves surrounding prose intact', () => {
    const source = '# Notes\n\n- [ ] task\n\nMore prose.\n'
    expect(removeTaskLine(source, indexedTask(source))).toBe('# Notes\n\n\nMore prose.\n')
  })

  it('refuses loudly when the task line is gone', () => {
    const task = indexedTask('- [ ] buy milk\n')
    expect(() => removeTaskLine('- [ ] something else\n', task)).toThrow(TaskStaleError)
  })
})

describe('taskLineToBullet', () => {
  function indexedTask(source: string, index = 0) {
    const task = parseNote({ path: 'notes/n.md', source }).tasks[index]!
    return { markerOffset: task.markerOffset, raw: task.raw }
  }

  it('drops the marker, leaving the bullet and content', () => {
    const source = '- [ ] buy milk\n'
    expect(taskLineToBullet(source, indexedTask(source))).toBe('- buy milk\n')
  })

  it('drops a checked marker too', () => {
    const source = '- [x] done\n'
    expect(taskLineToBullet(source, indexedTask(source))).toBe('- done\n')
  })

  it('preserves the bullet character and indentation', () => {
    const source = '  * [ ] sub\n'
    expect(taskLineToBullet(source, indexedTask(source))).toBe('  * sub\n')
  })

  it('collapses an empty task to a bare bullet', () => {
    const source = '- [ ] \n'
    expect(taskLineToBullet(source, indexedTask(source))).toBe('- \n')
  })

  it('keeps wiki links and tags in the content', () => {
    const source = '- [ ] ship [[2026-07-01]] #release\n'
    expect(taskLineToBullet(source, indexedTask(source))).toBe('- ship [[2026-07-01]] #release\n')
  })

  it('converts a middle task, leaving its neighbours as tasks', () => {
    const source = '- [ ] a\n- [ ] b\n- [ ] c\n'
    expect(taskLineToBullet(source, indexedTask(source, 1))).toBe('- [ ] a\n- b\n- [ ] c\n')
  })

  it('relocates by raw when an edit above drifts the offset', () => {
    const source = '- [ ] buy milk\n'
    const stale = indexedTask(source)
    expect(taskLineToBullet(`Intro.\n\n${source}`, stale)).toBe('Intro.\n\n- buy milk\n')
  })

  it('refuses loudly when the task line is gone', () => {
    const task = indexedTask('- [ ] buy milk\n')
    expect(() => taskLineToBullet('- [ ] something else\n', task)).toThrow(TaskStaleError)
  })
})
