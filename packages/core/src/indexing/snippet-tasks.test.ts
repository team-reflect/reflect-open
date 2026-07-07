import { describe, expect, it } from 'vitest'
import { toggleTaskMarker } from '../markdown/edit'
import { blockContextLinesAt } from './block-context'
import { extractSnippetTasks, type SnippetTask } from './snippet-tasks'

/** Offset of the first `[[target]]` occurrence — the index's `pos_from`. */
function posOf(content: string, link: string): number {
  const pos = content.indexOf(link)
  if (pos === -1) {
    throw new Error(`link ${link} not in fixture`)
  }
  return pos
}

/** The full pipeline the panel runs: source → block context → task anchors. */
function tasksFor(content: string, link = '[[Target]]'): SnippetTask[] {
  const { text, lineOrigins, lineSourceTexts } = blockContextLinesAt(content, posOf(content, link))
  return extractSnippetTasks(text, lineOrigins, lineSourceTexts)
}

describe('extractSnippetTasks', () => {
  it('anchors a round task child to its source marker offset', () => {
    const content = '- [[Target]] kickoff\n  + [ ] prep agenda\n  + [x] send invite\n'
    const tasks = tasksFor(content)
    expect(tasks).toEqual([
      {
        markerOffset: content.indexOf('[ ]'),
        raw: '[ ] prep agenda',
        checked: false,
        round: true,
        text: 'prep agenda',
      },
      {
        markerOffset: content.indexOf('[x]'),
        raw: '[x] send invite',
        checked: true,
        round: true,
        text: 'send invite',
      },
    ])
  })

  it('feeds toggleTaskMarker the exact coordinates it validates', () => {
    const content = '- [[Target]] kickoff\n  + [ ] prep agenda\n  + [x] send invite\n'
    const [first] = tasksFor(content)
    const toggled = toggleTaskMarker(content, { markerOffset: first!.markerOffset, raw: first!.raw })
    expect(toggled.checked).toBe(true)
    expect(toggled.source).toBe('- [[Target]] kickoff\n  + [x] prep agenda\n  + [x] send invite\n')
  })

  it('preserves trailing whitespace in the source raw line', () => {
    const content = '- [[Target]] kickoff\n  + [ ] prep agenda   \n'
    const [task] = tasksFor(content)
    expect(task).toMatchObject({
      markerOffset: content.indexOf('[ ]'),
      raw: '[ ] prep agenda   ',
      text: 'prep agenda',
    })
    expect(toggleTaskMarker(content, task!).source).toBe(
      '- [[Target]] kickoff\n  + [x] prep agenda   \n',
    )
  })

  it('anchors correctly through a dedented nested context', () => {
    const content = [
      '- top item',
      '  - middle [[Target]] item',
      '    + [ ] deep task',
      '  - other branch',
      '',
    ].join('\n')
    const [task] = tasksFor(content)
    expect(task).toMatchObject({ round: true, checked: false, text: 'deep task' })
    expect(content.slice(task!.markerOffset, task!.markerOffset + 3)).toBe('[ ]')
    expect(toggleTaskMarker(content, task!).source).toContain('+ [x] deep task')
  })

  it('marks square GFM checkboxes as not round', () => {
    const content = '- [[Target]] plan\n  - [ ] square box\n  * [x] star box\n'
    const tasks = tasksFor(content)
    expect(tasks.map((task) => task.round)).toEqual([false, false])
    expect(tasks.map((task) => task.checked)).toEqual([false, true])
  })

  it('counts checkboxes in document order, nested after their parent', () => {
    const content = '+ [ ] parent [[Target]]\n  + [ ] child one\n  + [ ] child two\n'
    const tasks = tasksFor(content)
    expect(tasks.map((task) => task.text)).toEqual([
      'parent [[Target]]',
      'child one',
      'child two',
    ])
    // Each anchors at increasing source offsets.
    const offsets = tasks.map((task) => task.markerOffset)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
  })

  it('skips a task marker in an ordered list, matching the rendered checkboxes', () => {
    // meowdown keeps `1. [ ]` as literal paragraph text (flat-list has a single
    // kind), so it renders no checkbox and must not claim an index.
    const content = '- [[Target]] plan\n  1. [ ] ordered pseudo-task\n  + [ ] real task\n'
    const tasks = tasksFor(content)
    expect(tasks.map((task) => task.text)).toEqual(['real task'])
  })

  it('ignores checkbox-looking text in code', () => {
    const content = '- [[Target]] plan\n  + [ ] real task\n  - `+ [ ] not a task`\n'
    // The inline-code sibling doesn't mention the target, so only the item's
    // own lines survive — but even in a wider context, code never counts.
    const tasks = tasksFor(content)
    expect(tasks.map((task) => task.text)).toEqual(['real task'])
  })

  it('returns no tasks for a snippet without checkboxes', () => {
    expect(extractSnippetTasks('just a [[Target]] paragraph', [0])).toEqual([])
    expect(extractSnippetTasks('', [])).toEqual([])
  })

  it('anchors by -1 when a line has no recorded origin, leaving only raw relocation', () => {
    const snippet = '+ [ ] task'
    const tasks = extractSnippetTasks(snippet, [])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.markerOffset).toBe(-1)
    // A unique raw still relocates safely…
    expect(toggleTaskMarker(snippet, tasks[0]!).source).toBe('+ [x] task')
    // …an ambiguous one refuses instead of guessing.
    const ambiguous = '+ [ ] task\n+ [ ] task'
    const twins = extractSnippetTasks(ambiguous, [])
    expect(() => toggleTaskMarker(ambiguous, twins[0]!)).toThrowError()
  })

  it('anchors a task under a heading-section context', () => {
    const content = '## Plan [[Target]]\n\n+ [ ] section task\n\nafter\n'
    const [task] = tasksFor(content)
    expect(task).toMatchObject({ raw: '[ ] section task', round: true })
    expect(toggleTaskMarker(content, task!).source).toContain('+ [x] section task')
  })
})
