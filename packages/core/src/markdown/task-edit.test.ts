import { sha256HexSync } from '@reflect/utils'
import { describe, expect, it } from 'vitest'
import { splitFrontmatter } from './frontmatter.ts'
import { applyTaskEdits, findTaskMove, type TaskEditResult } from './task-edit.ts'
import type { TaskLocator, TaskSnapshot } from './task-model.ts'
import { isSameTaskPath } from './task-path.ts'
import { projectTasks } from './task-project.ts'

/**
 * The locator of the `index`th task in `source`, as the index would store it.
 */
function locate(source: string, index = 0): TaskLocator {
  const task = projectTasks(splitFrontmatter(source).body)[index]
  if (task === undefined) {
    throw new Error(`no task #${index} in ${JSON.stringify(source)}`)
  }
  return {
    revision: sha256HexSync(source),
    astPath: task.astPath,
    markdown: task.markdown,
    checked: task.checked,
  }
}

/**
 * Where the write left the task that was at `astPath` before it.
 */
function movedFrom(result: TaskEditResult, astPath: readonly number[]): TaskSnapshot | null {
  const move = result.moved.find((candidate) => isSameTaskPath(candidate.from.astPath, astPath))
  if (move === undefined) {
    throw new Error(`no task was at ${JSON.stringify(astPath)}`)
  }
  return move.to
}

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
    const stale = { ...locate(source, 1), revision: 'older', astPath: [5] }
    expect(applyTaskEdits(source, [{ kind: 'toggle', task: stale }]).source).toBe(
      '+   [ ] a\n+   [x] b\n',
    )
  })

  it('refuses a locator from another revision that matches several identical tasks', () => {
    const source = '+ [ ] same\n+ [ ] same\n'
    const stale = { ...locate(source, 1), revision: 'older' }
    expect(() => applyTaskEdits(source, [{ kind: 'toggle', task: stale }])).toThrow(
      expect.objectContaining({ kind: 'ambiguous' }),
    )
  })

  it('edits the task at the path of a locator read at the revision of the note', () => {
    const source = '+ [ ] a\n+ [ ] b\n'
    const unsaved = { ...locate(source, 1), markdown: 'b, edited in a row' }
    expect(applyTaskEdits(source, [{ kind: 'toggle', task: unsaved }]).source).toBe(
      '+ [ ] a\n+ [x] b\n',
    )
  })

  it('refuses a task that is gone', () => {
    const source = '+ [ ] dup\n+ [ ] dup\n'
    const gone = { ...locate(source), revision: 'older', markdown: 'zzz' }
    expect(() => applyTaskEdits(source, [{ kind: 'toggle', task: gone }])).toThrow(
      expect.objectContaining({ kind: 'stale' }),
    )
  })

  it('never reaches a checkbox inside a code block', () => {
    const source = '+ [ ] real\n\n```\n+ [ ] fake\n```\n'
    const fake: TaskLocator = { revision: '', astPath: [2], markdown: 'fake', checked: false }
    expect(() => applyTaskEdits(source, [{ kind: 'toggle', task: fake }])).toThrow(
      expect.objectContaining({ kind: 'stale' }),
    )
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

  it('preserves the frontmatter bytes', () => {
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
    expect(() => applyTaskEdits(source, [edit])).toThrow(
      expect.objectContaining({ kind: 'invalidContent' }),
    )
  })

  it('refuses a continuation line that would open a new block', () => {
    const source = '+ [ ] a\n'
    const edit = { kind: 'setMarkdown', task: locate(source), markdown: 'one\n- two' } as const
    expect(() => applyTaskEdits(source, [edit])).toThrow(
      expect.objectContaining({ kind: 'invalidContent' }),
    )
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

  it('continues the task’s own list when the task is at the root', () => {
    const source =
      '## Chores\n\n+ [ ] first\n  + [ ] nested\n+ [ ] peer\n\nprose\n\n### Sub\n\n+ [ ] later\n'
    const result = applyTaskEdits(source, [
      { kind: 'insert', at: { kind: 'contextEnd', task: locate(source, 0) }, markdown: '' },
    ])
    expect(result.source).toBe(
      '## Chores\n\n+ [ ] first\n  + [ ] nested\n+ [ ] peer\n+ [ ] \n\nprose\n\n### Sub\n\n+ [ ] later\n',
    )
    expect(result.inserted[0]).toMatchObject({ astPath: [3], breadcrumbs: ['Chores'] })
  })

  it('stops a root list at a list with another marker', () => {
    const source = '+ [ ] a\n- bullet\n'
    const result = applyTaskEdits(source, [
      { kind: 'insert', at: { kind: 'contextEnd', task: locate(source) }, markdown: '' },
    ])
    expect(result.source).toBe('+ [ ] a\n+ [ ] \n- bullet\n')
  })
})

describe('applyTaskEdits: insert into the Tasks section', () => {
  const section = { kind: 'insert', at: { kind: 'tasksSection' }, markdown: '' } as const

  it.each([
    ['', '## Tasks\n\n+ [ ] \n'],
    ['intro\n', 'intro\n\n## Tasks\n\n+ [ ] \n'],
    ['intro\n\n\n', 'intro\n\n## Tasks\n\n+ [ ] \n\n\n'],
    ['- a\n\n\n', '- a\n\n## Tasks\n\n+ [ ] \n\n\n'],
    ['intro\n\n\n\nmore\n\n', 'intro\n\n\n\nmore\n\n## Tasks\n\n+ [ ] \n\n'],
    ['\n\n', '## Tasks\n\n+ [ ] \n\n\n'],
    ['## Tasks\n\n+ [ ] old\n', '## Tasks\n\n+ [ ] old\n+ [ ] \n'],
    ['## tasks\n\nprose\n', '## tasks\n\n+ [ ] \n\nprose\n'],
    ['## [[Tasks]]\n', '## [[Tasks]]\n\n+ [ ] \n'],
    ['## [[Tasks|To do]]\n', '## [[Tasks|To do]]\n\n+ [ ] \n'],
    ['# Tasks\n\n+ [ ] old\n', '# Tasks\n\n+ [ ] old\n+ [ ] \n'],
    ['## **Tasks**\n\n+ [ ] old\n', '## **Tasks**\n\n+ [ ] old\n+ [ ] \n'],
    ['## Tasks\n\n- [ ] checkbox\n', '## Tasks\n\n+ [ ] \n- [ ] checkbox\n'],
    ['## Tasks\n\n* bullet\n', '## Tasks\n\n+ [ ] \n* bullet\n'],
    [
      '## Tasks\n\n- bullet\n\n+ [ ] old\n\nprose\n\n## Later\n\n+ [ ] later\n',
      '## Tasks\n\n- bullet\n+ [ ] old\n+ [ ] \n\nprose\n\n## Later\n\n+ [ ] later\n',
    ],
    [
      '## Tasks\n\nintro\n\n### Child\n\n+ [ ] nested\n',
      '## Tasks\n\n+ [ ] \n\nintro\n\n### Child\n\n+ [ ] nested\n',
    ],
    ['## Tasks\n\n+ Project\n  + [ ] nested\n', '## Tasks\n\n+ Project\n  + [ ] nested\n+ [ ] \n'],
    ['## Tasks\n\n\n+ [ ] old\n', '## Tasks\n\n\n+ [ ] old\n+ [ ] \n'],
  ])('inserts an empty task into %j', (source, expected) => {
    expect(applyTaskEdits(source, [section]).source).toBe(expected)
  })

  it.each(['### Tasks', '> ## Tasks', '- ## Tasks', String.raw`## \[[Tasks]]`])(
    'does not reuse %s',
    (heading) => {
      const source = `${heading}\n\nexisting\n`
      expect(applyTaskEdits(source, [{ ...section, markdown: 'new' }]).source).toBe(
        `${source}\n## Tasks\n\n+ [ ] new\n`,
      )
    },
  )

  it('keeps frontmatter and reports where the other tasks moved', () => {
    const source = '---\nid: x\n---\n## Tasks\n\n+ [ ] a\n\n## Later\n\n+ [ ] b\n+ [ ] c\n'
    const result = applyTaskEdits(source, [section])
    expect(result.source).toBe(
      '---\nid: x\n---\n## Tasks\n\n+ [ ] a\n+ [ ] \n\n## Later\n\n+ [ ] b\n+ [ ] c\n',
    )
    expect(result.inserted[0]).toMatchObject({ astPath: [2], breadcrumbs: ['Tasks'] })
    expect(movedFrom(result, [1])).toMatchObject({ astPath: [1] })
    expect(movedFrom(result, [3])).toMatchObject({ astPath: [4], breadcrumbs: ['Later'] })
    expect(movedFrom(result, [4])).toMatchObject({ astPath: [5] })
  })

  it('places the new task with the given text', () => {
    expect(applyTaskEdits('## Tasks\n', [{ ...section, markdown: 'buy milk' }]).source).toBe(
      '## Tasks\n\n+ [ ] buy milk\n',
    )
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

  it('refuses a context insert into a parent removed earlier in the batch', () => {
    const source = '+ [ ] parent\n  + [ ] child\n'
    expect(() => {
      return applyTaskEdits(source, [
        { kind: 'remove', task: locate(source, 0) },
        { kind: 'insert', at: { kind: 'contextEnd', task: locate(source, 1) }, markdown: '' },
      ])
    }).toThrow(expect.objectContaining({ kind: 'stale' }))
  })

  it('refuses a later edit on a task removed earlier in the batch', () => {
    const source = '+ [ ] a\n'
    const task = locate(source)
    expect(() => {
      return applyTaskEdits(source, [
        { kind: 'remove', task },
        { kind: 'toggle', task },
      ])
    }).toThrow(expect.objectContaining({ kind: 'stale' }))
    expect(() => {
      return applyTaskEdits(source, [
        { kind: 'remove', task },
        { kind: 'remove', task },
      ])
    }).toThrow(expect.objectContaining({ kind: 'stale' }))
  })
})

describe('findTaskMove', () => {
  const source = 'Intro\n\n+ [ ] a\n+ [ ] b\n'
  const edit = applyTaskEdits(source, [{ kind: 'toggle', task: locate(source, 0) }])

  it('follows a locator read at the base revision by its path', () => {
    expect(findTaskMove(edit, locate(source, 0))?.to).toMatchObject({
      astPath: [1],
      checked: true,
    })
  })

  it('follows a stale locator by its content, not by whatever sits at its path', () => {
    // Indexed before the intro paragraph was added: `b` was at [1], where `a` is now.
    expect(
      findTaskMove(edit, { revision: '', astPath: [1], markdown: 'b', checked: false })?.to,
    ).toMatchObject({
      astPath: [2],
      markdown: 'b',
    })
  })

  it('returns undefined for a locator that names no task', () => {
    expect(
      findTaskMove(edit, { revision: '', astPath: [1], markdown: 'c', checked: false }),
    ).toBeUndefined()
  })

  it('takes the path among identical tasks, and none for a locator from another revision', () => {
    const twins = '+ [ ] same\n+ [ ] same\n'
    const result = applyTaskEdits(twins, [{ kind: 'toggle', task: locate(twins, 1) }])
    expect(findTaskMove(result, locate(twins, 1))?.to).toMatchObject({ checked: true })
    expect(findTaskMove(result, { ...locate(twins, 0), revision: 'older' })).toBeUndefined()
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
