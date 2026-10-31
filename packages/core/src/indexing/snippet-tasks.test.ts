import { describe, expect, it } from 'vitest'
import { applyTaskEdits } from '../markdown/task-ast.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { blockContextLinesAt, prepareBlockContext } from './block-context.ts'
import { createSourceTaskLocator, extractSnippetTasks, type SnippetTask } from './snippet-tasks.ts'

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
  const { text, lineOrigins } = blockContextLinesAt(content, posOf(content, link))
  return extractSnippetTasks(
    text,
    lineOrigins,
    createSourceTaskLocator(prepareBlockContext(content)),
  )
}

function toggled(content: string, task: SnippetTask | undefined): string {
  if (!task?.locator) {
    throw new Error('task has no locator')
  }
  return applyTaskEdits({ logger: createTestLoggerService() }, content, [
    { kind: 'toggle', task: task.locator },
  ]).source
}

describe('extractSnippetTasks', () => {
  it('anchors a round task child to its source locator', () => {
    const content = '- [[Target]] kickoff\n  + [ ] prep agenda\n  + [x] send invite\n'
    expect(tasksFor(content)).toEqual([
      {
        locator: { astPath: [0, 1], markdown: 'prep agenda', checked: false },
        checked: false,
        text: 'prep agenda',
      },
      {
        locator: { astPath: [0, 2], markdown: 'send invite', checked: true },
        checked: true,
        text: 'send invite',
      },
    ])
  })

  it('feeds applyTaskEdits a locator it accepts', () => {
    const content = '- [[Target]] kickoff\n  + [ ] prep agenda\n  + [x] send invite\n'
    const [first] = tasksFor(content)
    expect(toggled(content, first)).toBe(
      '- [[Target]] kickoff\n  + [x] prep agenda\n  + [x] send invite\n',
    )
  })

  it('locates a task whose source line has trailing whitespace', () => {
    const content = '- [[Target]] kickoff\n  + [ ] prep agenda   \n'
    const [task] = tasksFor(content)
    expect(task).toMatchObject({
      locator: { astPath: [0, 1], markdown: 'prep agenda' },
      text: 'prep agenda',
    })
  })

  it('locates a task whose marker is followed by extra whitespace', () => {
    const content = '- [[Target]] kickoff\n  + [ ]   prep agenda\n'
    const [task] = tasksFor(content)
    expect(task?.locator).toEqual({ astPath: [0, 1], markdown: 'prep agenda', checked: false })
    expect(toggled(content, task)).toContain('+ [x]')
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
    expect(task).toMatchObject({
      locator: { astPath: [0, 1, 1] },
      checked: false,
      text: 'deep task',
    })
    expect(toggled(content, task)).toContain('+ [x] deep task')
  })

  it('leaves square GFM checkboxes without a locator', () => {
    const content = '- [[Target]] plan\n  - [ ] square box\n  * [x] star box\n'
    const tasks = tasksFor(content)
    expect(tasks.map((task) => task.locator)).toEqual([null, null])
    expect(tasks.map((task) => task.checked)).toEqual([false, true])
  })

  it('counts checkboxes in document order, nested after their parent', () => {
    const content = '+ [ ] parent [[Target]]\n  + [ ] child one\n  + [ ] child two\n'
    const tasks = tasksFor(content)
    expect(tasks.map((task) => task.text)).toEqual(['parent [[Target]]', 'child one', 'child two'])
    expect(tasks.map((task) => task.locator?.astPath)).toEqual([[0], [0, 1], [0, 2]])
  })

  it('skips a task marker in an ordered list, matching the rendered checkboxes', () => {
    // meowdown keeps `1. [ ]` as literal paragraph text (flat-list has a single
    // kind), so it renders no checkbox and must not claim an index.
    const content = '- [[Target]] plan\n  1. [ ] ordered pseudo-task\n  + [ ] real task\n'
    const tasks = tasksFor(content)
    expect(tasks.map((task) => task.text)).toEqual(['real task'])
    expect(tasks[0]?.locator?.astPath).toEqual([0, 2])
  })

  it('ignores checkbox-looking text in code', () => {
    const content = '- [[Target]] plan\n  + [ ] real task\n  - `+ [ ] not a task`\n'
    const tasks = tasksFor(content)
    expect(tasks.map((task) => task.text)).toEqual(['real task'])
  })

  it('returns no tasks for a snippet without checkboxes', () => {
    const none = () => undefined
    expect(extractSnippetTasks('just a [[Target]] paragraph', [0], none)).toEqual([])
    expect(extractSnippetTasks('', [], none)).toEqual([])
  })

  it('leaves a checkbox read-only when its line has no recorded origin', () => {
    const tasks = extractSnippetTasks('+ [ ] task', [], () => {
      throw new Error('must not be asked')
    })
    expect(tasks).toEqual([{ locator: null, checked: false, text: 'task' }])
  })

  it('anchors a task under a heading-section context', () => {
    const content = '## Plan [[Target]]\n\n+ [ ] section task\n\nafter\n'
    const [task] = tasksFor(content)
    expect(task).toMatchObject({ locator: { astPath: [1], markdown: 'section task' } })
    expect(toggled(content, task)).toContain('+ [x] section task')
  })

  it('anchors a task past frontmatter with whole-file offsets', () => {
    const content = '---\ntitle: Note\n---\n\n- [[Target]] plan\n  + [ ] after frontmatter\n'
    const [task] = tasksFor(content)
    expect(task?.locator).toEqual({
      astPath: [0, 1],
      markdown: 'after frontmatter',
      checked: false,
    })
    expect(toggled(content, task)).toContain('+ [x] after frontmatter')
  })
})

describe('createSourceTaskLocator', () => {
  it('locates every round task of a note, including inside a blockquote', () => {
    const content = '+ [ ] top\n\n> + [x] quoted\n'
    const locate = createSourceTaskLocator(prepareBlockContext(content))
    expect(locate(content.indexOf('[ ]'))).toEqual({
      astPath: [0],
      markdown: 'top',
      checked: false,
    })
    expect(locate(content.indexOf('[x]'))).toEqual({
      astPath: [1, 0],
      markdown: 'quoted',
      checked: true,
    })
  })

  it('returns nothing for an offset that is not a round task marker', () => {
    const content = '+ [ ] top\n- [ ] square\n'
    const locate = createSourceTaskLocator(prepareBlockContext(content))
    expect(locate(content.indexOf('[ ] square'))).toBeUndefined()
    expect(locate(0)).toBeUndefined()
  })
})
