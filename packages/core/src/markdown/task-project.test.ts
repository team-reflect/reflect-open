import { parseMarkdownAst } from '@meowdown/markdown'
import { describe, expect, it } from 'vitest'
import { applyTaskEdits } from './task-edit.ts'
import { getRoundTasks, getTaskDueDate, projectTasks } from './task-project.ts'

describe('projectTasks', () => {
  it('projects round tasks with their path, markdown, and state', () => {
    expect(projectTasks('+ [ ] buy milk\n+ [x] call mum\n')).toEqual([
      {
        astPath: [0],
        markdown: 'buy milk',
        breadcrumbs: [],
        checked: false,
        dueDate: null,
      },
      {
        astPath: [1],
        markdown: 'call mum',
        breadcrumbs: [],
        checked: true,
        dueDate: null,
      },
    ])
  })

  it('drops surrounding whitespace from the task Markdown', () => {
    expect(projectTasks('+ [ ] padded   \n').map((task) => task.markdown)).toEqual(['padded'])
  })

  it('treats an uppercase [X] marker as checked', () => {
    expect(projectTasks('+ [X] done\n')[0]).toMatchObject({ markdown: 'done', checked: true })
  })

  it('keeps inline syntax in markdown', () => {
    expect(projectTasks('+ [ ] call [[Bob]] about **billing**\n')[0]?.markdown).toBe(
      'call [[Bob]] about **billing**',
    )
  })

  it('addresses nested tasks under their parent item', () => {
    const tasks = projectTasks('+ [ ] parent\n  + [x] child\n')
    expect(tasks.map((task) => [task.astPath, task.markdown, task.checked])).toEqual([
      [[0], 'parent', false],
      [[0, 1], 'child', true],
    ])
  })

  it('includes round tasks nested under ordered items and inside blockquotes', () => {
    const tasks = projectTasks('1. first\n   + [ ] under ordered\n\n> + [ ] quoted\n')
    expect(tasks.map((task) => [task.astPath, task.markdown])).toEqual([
      [[0, 1], 'under ordered'],
      [[1, 0], 'quoted'],
    ])
  })

  it('ignores checkboxes inside fenced code', () => {
    expect(
      projectTasks('+ [ ] real\n\n```\n+ [ ] not a task\n```\n').map((task) => task.markdown),
    ).toEqual(['real'])
  })

  it('ignores square checklists, ordered checkboxes, and a bare `+ [ ]` without a space', () => {
    expect(projectTasks('- [ ] checklist\n* [x] checklist\n1. [ ] ordered\n+ [ ]\n')).toEqual([])
  })

  it('yields no tasks for plain bullets', () => {
    expect(projectTasks('- just a bullet\n- another\n')).toEqual([])
  })

  it('uses the whole first paragraph, continuation lines included', () => {
    expect(projectTasks('+ [ ] a long task\n  continues here\n')[0]?.markdown).toBe(
      'a long task\ncontinues here',
    )
  })

  it('captures ancestor list items as breadcrumbs, outermost first, as markdown', () => {
    expect(
      projectTasks('+ Project [[Alpha]]\n  + **Phase one**\n    + [ ] ship it\n')[0],
    ).toMatchObject({
      markdown: 'ship it',
      breadcrumbs: ['Project [[Alpha]]', '**Phase one**'],
    })
  })

  it('keeps a wrapped parent paragraph as one breadcrumb', () => {
    expect(
      projectTasks('+ **Project Alpha**\n  continues on this line\n  + [ ] ship it\n')[0]
        ?.breadcrumbs,
    ).toEqual(['**Project Alpha**\ncontinues on this line'])
  })

  it('uses a parent task as the breadcrumb of its subtasks', () => {
    const tasks = projectTasks('+ [ ] parent task\n  + [x] child task\n')
    expect(tasks.map((task) => task.breadcrumbs)).toEqual([[], ['parent task']])
  })

  it('starts breadcrumbs with the chain of headings above the task', () => {
    const body =
      '# Home\n\n## House chore\n\n+ Kitchen\n  + [ ] wash dishes\n\n### Garden\n\n+ [ ] water plants\n\n## Work\n\n+ [ ] send update\n'
    expect(projectTasks(body).map((task) => task.breadcrumbs)).toEqual([
      ['Home', 'House chore', 'Kitchen'],
      ['Home', 'House chore', 'Garden'],
      ['Home', 'Work'],
    ])
  })

  it('keeps a Tasks heading in the chain like any other', () => {
    const body = '# Home\n\n## Tasks\n\n+ [ ] top\n+ Kitchen\n  + [ ] child\n'
    expect(projectTasks(body).map((task) => task.breadcrumbs)).toEqual([
      ['Home', 'Tasks'],
      ['Home', 'Tasks', 'Kitchen'],
    ])
  })

  it('closes a section at the next heading of the same or a higher level', () => {
    const body =
      '## House chore\n\n+ [ ] first\n\n### Tasks\n\n+ [ ] second\n\n## Work\n\n+ [ ] third\n'
    expect(projectTasks(body).map((task) => task.breadcrumbs)).toEqual([
      ['House chore'],
      ['House chore', 'Tasks'],
      ['Work'],
    ])
  })

  it('ignores quoted, nested, and fenced headings as sections', () => {
    const body =
      '## House chore\n\n> ## Quoted\n\n- ## Listed\n\n+ [ ] first\n\n```\n## Fenced\n```\n\n+ [ ] second\n'
    expect(projectTasks(body).map((task) => task.breadcrumbs)).toEqual([
      ['House chore'],
      ['House chore'],
    ])
  })

  it('stores heading labels as Markdown', () => {
    expect(projectTasks('## **House chore**\n\n+ [ ] a\n')[0]?.breadcrumbs).toEqual([
      '**House chore**',
    ])
  })

  it('reads the first calendar date link as the due date, per task', () => {
    expect(
      projectTasks('+ [ ] ship it [[2026-07-01]] and review [[2026-08-01]]\n')[0]?.dueDate,
    ).toBe('2026-07-01')
    expect(projectTasks('+ [ ] not a real day [[2026-02-31]]\n')[0]?.dueDate).toBeNull()
    expect(
      projectTasks('+ [ ] parent\n  + [ ] child [[2026-07-01]]\n').map((task) => task.dueDate),
    ).toEqual([null, '2026-07-01'])
  })
})

describe('getTaskDueDate', () => {
  it('returns the first calendar-valid date link', () => {
    expect(getTaskDueDate('a [[Note]] b [[2026-07-01]] c [[2026-08-01]]')).toBe('2026-07-01')
    expect(getTaskDueDate('no date')).toBeNull()
    expect(getTaskDueDate('[[2026-02-31]]')).toBeNull()
  })
})

describe('getRoundTasks', () => {
  it('walks every round task in document order with its parent', () => {
    const document = parseMarkdownAst('- Shopping\n  + [ ] milk\n  + [ ] eggs\n')
    const entries = getRoundTasks(document)
    expect(entries.map((entry) => entry.astPath)).toEqual([
      [0, 1],
      [0, 2],
    ])
    expect(entries[0]?.parent).toBe(document.children[0])
  })

  it('reports the same breadcrumbs as the projection and the edit result', () => {
    const body = '# Home\n\n## Chores\n\n+ [ ] a\n'
    const breadcrumbs = ['Home', 'Chores']
    expect(getRoundTasks(parseMarkdownAst(body))[0]?.breadcrumbs).toEqual(breadcrumbs)
    expect(projectTasks(body)[0]?.breadcrumbs).toEqual(breadcrumbs)
    expect(applyTaskEdits(body, []).tasks[0]?.breadcrumbs).toEqual(breadcrumbs)
  })
})
