import { parseMarkdownAst } from '@meowdown/markdown'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { splitFrontmatter } from './frontmatter.ts'
import {
  applyTaskEdits,
  findTaskMove,
  getRoundTasks,
  getTaskDueDate,
  NoteNotSerializableError,
  projectTasks,
  TaskStaleError,
  type TaskEditResult,
  type TaskLocator,
  type TaskSnapshot,
} from './task-ast.ts'
import { isSameTaskPath } from './task-path.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** The locator of the `index`th task in `source`, as the index would store it. */
function locate(source: string, index = 0): TaskLocator {
  const task = projectTasks(splitFrontmatter(source).body)[index]
  if (task === undefined) {
    throw new Error(`no task #${index} in ${JSON.stringify(source)}`)
  }
  return { astPath: task.astPath, markdown: task.markdown, checked: task.checked }
}

/** Where the write left the task that was at `astPath` before it. */
function movedFrom(result: TaskEditResult, astPath: readonly number[]): TaskSnapshot | null {
  const move = result.moved.find((candidate) => isSameTaskPath(candidate.from.astPath, astPath))
  if (move === undefined) {
    throw new Error(`no task was at ${JSON.stringify(astPath)}`)
  }
  return move.to
}

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
})

describe('applyTaskEdits: toggle', () => {
  it('checks an open task and unchecks a completed one', () => {
    const source = '+ [ ] buy milk\n+ [x] call mum\n'
    expect(applyTaskEdits(source, [{ kind: 'toggle', task: locate(source, 0) }]).source).toBe(
      '+ [x] buy milk\n+ [x] call mum\n',
    )
    expect(applyTaskEdits(source, [{ kind: 'toggle', task: locate(source, 1) }]).source).toBe(
      '+ [ ] buy milk\n+ [ ] call mum\n',
    )
  })

  it('keeps the marker gap and relocates a task whose path drifted', () => {
    const source = '+   [ ] a\n+   [ ] b\n'
    const stale = { ...locate(source, 1), astPath: [5] }
    expect(applyTaskEdits(source, [{ kind: 'toggle', task: stale }]).source).toBe(
      '+   [ ] a\n+   [x] b\n',
    )
  })

  it('takes the first of several identical tasks when the path is stale, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const source = '+ [ ] same\n+ [ ] same\n'
    const stale = { ...locate(source, 1), astPath: [7] }
    expect(applyTaskEdits(source, [{ kind: 'toggle', task: stale }]).source).toBe(
      '+ [x] same\n+ [ ] same\n',
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('taking the first of 2'))
  })

  it('refuses a task that is gone', () => {
    const source = '+ [ ] dup\n+ [ ] dup\n'
    const gone = { ...locate(source), markdown: 'zzz' }
    expect(() => applyTaskEdits(source, [{ kind: 'toggle', task: gone }])).toThrow(TaskStaleError)
  })

  it('never reaches a checkbox inside a code block', () => {
    const source = '+ [ ] real\n\n```\n+ [ ] fake\n```\n'
    const fake: TaskLocator = { astPath: [2], markdown: 'fake', checked: false }
    expect(() => applyTaskEdits(source, [{ kind: 'toggle', task: fake }])).toThrow(TaskStaleError)
  })

  it('toggles inside a blockquote and under an ordered item', () => {
    const quoted = '> + [ ] q\n'
    expect(applyTaskEdits(quoted, [{ kind: 'toggle', task: locate(quoted) }]).source).toBe(
      '> + [x] q\n',
    )
    const ordered = '1. first\n   + [ ] x\n'
    expect(applyTaskEdits(ordered, [{ kind: 'toggle', task: locate(ordered) }]).source).toBe(
      '1. first\n   + [x] x\n',
    )
  })

  it('preserves CRLF line endings and the frontmatter bytes', () => {
    const crlf = '# T\r\n\r\n+ [ ] a\r\n'
    expect(applyTaskEdits(crlf, [{ kind: 'toggle', task: locate(crlf) }]).source).toBe(
      '# T\r\n\r\n+ [x] a\r\n',
    )
    const fronted = '---\nid: x\n---\n+ [ ] a\n'
    expect(applyTaskEdits(fronted, [{ kind: 'toggle', task: locate(fronted) }]).source).toBe(
      '---\nid: x\n---\n+ [x] a\n',
    )
  })

  it('keeps an empty bullet line', () => {
    const source = '- a\n-\n- b\n+ [ ] t\n'
    expect(applyTaskEdits(source, [{ kind: 'toggle', task: locate(source) }]).source).toBe(
      '- a\n-\n- b\n+ [x] t\n',
    )
  })

  it('maps every task to its unchanged place', () => {
    const source = '+ [ ] a\n+ [ ] b\n'
    const result = applyTaskEdits(source, [{ kind: 'toggle', task: locate(source, 0) }])
    expect(movedFrom(result, [0])).toMatchObject({
      astPath: [0],
      checked: true,
    })
    expect(movedFrom(result, [1])).toMatchObject({ astPath: [1] })
    expect(result.tasks.map((task) => task.markdown)).toEqual(['a', 'b'])
  })
})

describe('applyTaskEdits: setMarkdown', () => {
  it('replaces the paragraph, keeping bullet, marker, and an uppercase [X]', () => {
    const source = '+ [X] done\n+ [ ] other\n'
    const edit = { kind: 'setMarkdown', task: locate(source), markdown: ' done it ' } as const
    expect(applyTaskEdits(source, [edit]).source).toBe('+ [X] done it\n+ [ ] other\n')
  })

  it('keeps the indentation of a nested item and writes links verbatim', () => {
    const source = '- parent\n  + [ ] old\n'
    const edit = {
      kind: 'setMarkdown',
      task: locate(source),
      markdown: 'see [[Note]] #tag',
    } as const
    expect(applyTaskEdits(source, [edit]).source).toBe('- parent\n  + [ ] see [[Note]] #tag\n')
  })

  it('clears to an empty task that stays a task', () => {
    const source = '+ [ ] text\n'
    const result = applyTaskEdits(source, [
      { kind: 'setMarkdown', task: locate(source), markdown: '' },
    ])
    expect(result.source).toBe('+ [ ] \n')
    expect(result.tasks).toHaveLength(1)
  })

  it('returns the same bytes for an unchanged paragraph', () => {
    const source = '+ [ ] same\n'
    const edit = { kind: 'setMarkdown', task: locate(source), markdown: 'same' } as const
    expect(applyTaskEdits(source, [edit]).source).toBe(source)
  })

  it('refuses a blank line, which would split the paragraph', () => {
    const source = '+ [ ] a\n'
    const edit = { kind: 'setMarkdown', task: locate(source), markdown: 'one\n\ntwo' } as const
    expect(() => applyTaskEdits(source, [edit])).toThrow(/one paragraph/)
  })

  it('refuses a continuation line that would open a new block', () => {
    const source = '+ [ ] a\n'
    const edit = { kind: 'setMarkdown', task: locate(source), markdown: 'one\n- two' } as const
    expect(() => applyTaskEdits(source, [edit])).toThrow(NoteNotSerializableError)
  })
})

describe('applyTaskEdits: remove', () => {
  it('removes a middle task and closes the gap', () => {
    const source = '+ [ ] a\n+ [ ] b\n+ [ ] c\n'
    const result = applyTaskEdits(source, [{ kind: 'remove', task: locate(source, 1) }])
    expect(result.source).toBe('+ [ ] a\n+ [ ] c\n')
    expect(movedFrom(result, [1])).toBeNull()
    expect(movedFrom(result, [2])).toMatchObject({ astPath: [1] })
  })

  it('empties a note whose only block was the task', () => {
    const source = '+ [ ] only\n'
    expect(applyTaskEdits(source, [{ kind: 'remove', task: locate(source) }]).source).toBe('')
  })

  it('removes the whole paragraph and lifts nested blocks into its place', () => {
    const source = '+ [ ] parent\n  more\n  + [ ] child\n+ [ ] next\n'
    const result = applyTaskEdits(source, [{ kind: 'remove', task: locate(source, 0) }])
    expect(result.source).toBe('+ [ ] child\n+ [ ] next\n')
    expect(movedFrom(result, [0, 1])).toMatchObject({ astPath: [0] })
  })

  it('leaves surrounding prose intact', () => {
    const source = 'before\n\n+ [ ] gone\n\nafter\n'
    expect(applyTaskEdits(source, [{ kind: 'remove', task: locate(source) }]).source).toBe(
      'before\n\nafter\n',
    )
  })
})

describe('applyTaskEdits: toBullet', () => {
  it('drops the marker and keeps the bullet, content, and neighbours', () => {
    const source = '+ [ ] a\n+ [x] b [[Note]]\n+ [ ] c\n'
    const result = applyTaskEdits(source, [{ kind: 'toBullet', task: locate(source, 1) }])
    expect(result.source).toBe('+ [ ] a\n+ b [[Note]]\n+ [ ] c\n')
    expect(movedFrom(result, [1])).toBeNull()
    expect(movedFrom(result, [2])).toMatchObject({ astPath: [2] })
  })

  it('collapses an empty task to a bare bullet', () => {
    const source = '+ [ ] \n'
    expect(applyTaskEdits(source, [{ kind: 'toBullet', task: locate(source) }]).source).toBe('+\n')
  })
})

describe('applyTaskEdits: insert', () => {
  const empty = { kind: 'insert', at: { kind: 'documentEnd' }, markdown: '' } as const

  it('starts an empty note with a single empty task', () => {
    const result = applyTaskEdits('', [empty])
    expect(result.source).toBe('+ [ ] \n')
    expect(result.inserted).toEqual([
      { astPath: [0], markdown: '', breadcrumbs: [], checked: false },
    ])
  })

  it('continues a trailing task list and follows prose after a blank line', () => {
    expect(applyTaskEdits('+ [ ] a\n', [empty]).source).toBe('+ [ ] a\n+ [ ] \n')
    expect(applyTaskEdits('para\n', [empty]).source).toBe('para\n\n+ [ ] \n')
    expect(applyTaskEdits('# T\n', [empty]).source).toBe('# T\n\n+ [ ] \n')
  })

  it('appends after frontmatter and a missing final newline', () => {
    expect(applyTaskEdits('---\nid: x\n---\n', [empty]).source).toBe('---\nid: x\n---\n+ [ ] \n')
    expect(applyTaskEdits('# T\n\n+ [ ] x', [empty]).source).toBe('# T\n\n+ [ ] x\n+ [ ] \n')
  })

  it('adds a sibling at the end of the task context', () => {
    const source = '- Shopping\n  + [ ] milk\n  + [ ] eggs\n- Other\n'
    const result = applyTaskEdits(source, [
      { kind: 'insert', at: { kind: 'contextEnd', task: locate(source, 0) }, markdown: '' },
    ])
    expect(result.source).toBe('- Shopping\n  + [ ] milk\n  + [ ] eggs\n  + [ ] \n- Other\n')
    expect(result.inserted[0]).toMatchObject({ astPath: [0, 3] })
  })

  it('refuses a context insert for a task at the root', () => {
    const source = '+ [ ] root\n'
    expect(() =>
      applyTaskEdits(source, [
        { kind: 'insert', at: { kind: 'contextEnd', task: locate(source) }, markdown: '' },
      ]),
    ).toThrow(TaskStaleError)
  })

  it('inserts right after a task and shifts the siblings behind it', () => {
    const source = '- Shopping\n  + [ ] milk\n  + [ ] eggs\n'
    const result = applyTaskEdits(source, [
      { kind: 'insert', at: { kind: 'afterTask', task: locate(source, 0) }, markdown: 'bread' },
    ])
    expect(result.source).toBe('- Shopping\n  + [ ] milk\n  + [ ] bread\n  + [ ] eggs\n')
    expect(movedFrom(result, [0, 1])).toMatchObject({ astPath: [0, 1] })
    expect(movedFrom(result, [0, 2])).toMatchObject({ astPath: [0, 3] })
    expect(result.inserted[0]).toMatchObject({ astPath: [0, 2], markdown: 'bread' })
  })

  it('inserts after any block, such as a heading', () => {
    const result = applyTaskEdits('# T\n\npara\n', [
      { kind: 'insert', at: { kind: 'afterBlock', astPath: [0] }, markdown: 'todo' },
    ])
    expect(result.source).toBe('# T\n\n+ [ ] todo\n\npara\n')
  })

  it('refuses an insert position that no longer exists', () => {
    expect(() =>
      applyTaskEdits('# T\n', [
        { kind: 'insert', at: { kind: 'afterBlock', astPath: [4] }, markdown: '' },
      ]),
    ).toThrow(TaskStaleError)
  })
})

describe('applyTaskEdits: batches', () => {
  it('resolves a removed anchor and inserts at its context end in one write', () => {
    const source = '- Shopping\n  + [ ] milk\n  + [ ] eggs\n- Other\n'
    const eggs = locate(source, 1)
    const result = applyTaskEdits(source, [
      { kind: 'remove', task: eggs },
      { kind: 'insert', at: { kind: 'contextEnd', task: eggs }, markdown: '' },
    ])
    expect(result.source).toBe('- Shopping\n  + [ ] milk\n  + [ ] \n- Other\n')
    expect(movedFrom(result, [0, 2])).toBeNull()
    expect(movedFrom(result, [0, 1])).toMatchObject({ astPath: [0, 1] })
    expect(result.inserted[0]).toEqual({
      astPath: [0, 2],
      markdown: '',
      breadcrumbs: ['Shopping'],
      checked: false,
    })
  })

  it('edits a task and toggles it in one write, addressing it as it was', () => {
    const source = '+ [ ] draft\n'
    const task = locate(source)
    const result = applyTaskEdits(source, [
      { kind: 'setMarkdown', task, markdown: 'final' },
      { kind: 'toggle', task },
    ])
    expect(result.source).toBe('+ [x] final\n')
    expect(movedFrom(result, [0])).toMatchObject({
      markdown: 'final',
      checked: true,
    })
  })

  it('removes a parent task and then its lifted child in one write', () => {
    const source = '+ [ ] parent\n  + [ ] child\n+ [ ] after\n'
    const result = applyTaskEdits(source, [
      { kind: 'remove', task: locate(source, 0) },
      { kind: 'remove', task: locate(source, 1) },
    ])
    expect(result.source).toBe('+ [ ] after\n')
    expect(result.moved.map((move) => move.to)).toEqual([
      null,
      null,
      { astPath: [0], markdown: 'after', breadcrumbs: [], checked: false },
    ])
  })

  it('inserts after a child whose parent was removed earlier in the batch', () => {
    const source = '+ [ ] parent\n  + [ ] child\n+ [ ] after\n'
    const result = applyTaskEdits(source, [
      { kind: 'remove', task: locate(source, 0) },
      { kind: 'insert', at: { kind: 'afterTask', task: locate(source, 1) }, markdown: 'new' },
    ])
    expect(result.source).toBe('+ [ ] child\n+ [ ] new\n+ [ ] after\n')
    expect(result.inserted[0]).toMatchObject({ astPath: [1], breadcrumbs: [] })
  })

  it('refuses a context insert into a parent removed earlier in the batch', () => {
    const source = '+ [ ] parent\n  + [ ] child\n'
    expect(() =>
      applyTaskEdits(source, [
        { kind: 'remove', task: locate(source, 0) },
        { kind: 'insert', at: { kind: 'contextEnd', task: locate(source, 1) }, markdown: '' },
      ]),
    ).toThrow(TaskStaleError)
  })

  it('refuses a later edit on a task removed earlier in the batch', () => {
    const source = '+ [ ] a\n'
    const task = locate(source)
    expect(() =>
      applyTaskEdits(source, [
        { kind: 'remove', task },
        { kind: 'toggle', task },
      ]),
    ).toThrow(TaskStaleError)
    expect(() =>
      applyTaskEdits(source, [
        { kind: 'remove', task },
        { kind: 'remove', task },
      ]),
    ).toThrow(TaskStaleError)
  })
})

describe('findTaskMove', () => {
  const source = 'Intro\n\n+ [ ] a\n+ [ ] b\n'
  const { moved } = applyTaskEdits(source, [{ kind: 'toggle', task: locate(source, 0) }])

  it('follows a locator by its path while the content still matches', () => {
    expect(findTaskMove(moved, locate(source, 0))?.to).toMatchObject({
      astPath: [1],
      checked: true,
    })
  })

  it('follows a stale locator by its content, not by whatever sits at its path', () => {
    // Indexed before the intro paragraph was added: `b` was at [1], where `a` is now.
    expect(findTaskMove(moved, { astPath: [1], markdown: 'b', checked: false })?.to).toMatchObject({
      astPath: [2],
      markdown: 'b',
    })
  })

  it('returns undefined for a locator that names no task', () => {
    expect(findTaskMove(moved, { astPath: [1], markdown: 'c', checked: false })).toBeUndefined()
  })

  it('prefers the path match over identical content, else takes the first and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const twins = '+ [ ] same\n+ [ ] same\n'
    const result = applyTaskEdits(twins, [{ kind: 'toggle', task: locate(twins, 1) }])
    expect(findTaskMove(result.moved, locate(twins, 1))?.to).toMatchObject({ checked: true })
    expect(warn).not.toHaveBeenCalled()
    expect(
      findTaskMove(result.moved, { astPath: [5], markdown: 'same', checked: false })?.from,
    ).toMatchObject({ astPath: [0] })
    expect(warn).toHaveBeenCalledOnce()
  })
})

describe('applyTaskEdits: fidelity guard', () => {
  it('normalizes layout the serializer owns but keeps every block', () => {
    const source = '- p\n    - c\n        + [ ] t\n'
    expect(applyTaskEdits(source, [{ kind: 'toggle', task: locate(source) }]).source).toBe(
      '- p\n  - c\n    + [x] t\n',
    )
  })
})
