import { describe, expect, it, vi } from 'vitest'
import { parseMarkdownAst } from '@meowdown/markdown'
import { TaskStore, indexedTaskKey, type Task, type TaskStoreIO } from './task-store.ts'
import { inlineMarkdownToDisplayText } from '../markdown/plain-text.ts'
import { projectTaskDocument } from '../markdown/task-projection.ts'

const target = {
  notePath: 'notes/tasks.md',
  noteTitle: 'Tasks',
  dailyDate: null,
  isPinned: false,
  pinnedOrder: null,
}

/** What the SQLite index would return for `source`: round tasks with their addresses. */
function indexed(source: string | null, checked: boolean): Task[] {
  return projectTaskDocument(parseMarkdownAst(source ?? ''))
    .filter((task) => task.checked === checked)
    .map((task) => ({
      ...target,
      ...task,
      key: indexedTaskKey(target.notePath, task.astPath),
      displayText: inlineMarkdownToDisplayText(task.text),
      updatedAt: 1,
    }))
}

function harness(initial: string | null = null) {
  let source = initial
  const io = {
    read: vi.fn(async () => source),
    write: vi.fn(async (_path: string, before: string | null, next: string) => {
      if (source !== before) throw new Error('conflict')
      source = next
    }),
    failure: vi.fn<TaskStoreIO['failure']>(),
    saved: vi.fn(),
  }
  const store = new TaskStore(io)
  return {
    store,
    io,
    source: () => source,
    /** The list as the screen sees it with archived off: open rows plus this session's completions. */
    list: () => store.list(indexed(source, false)),
    /** The list with archived on. */
    all: () => store.list(indexed(source, false), indexed(source, true)),
  }
}

describe('task store', () => {
  it('never reads or writes a note for an abandoned empty task', async () => {
    const h = harness()
    const row = h.store.create(target)
    expect(h.list()).toHaveLength(1)
    h.store.draft(row, '   ')
    expect(h.store.commitDraft(row)).toBeNull()
    await h.store.flush()
    expect(h.list()).toEqual([])
    expect(h.io.read).not.toHaveBeenCalled()
    expect(h.io.write).not.toHaveBeenCalled()
  })

  it('keeps a draft in memory until the edit ends, then writes it once', async () => {
    const h = harness()
    const row = h.store.create(target)
    const version = h.store.snapshot()
    h.store.draft(row, 'buy')
    h.store.draft(row, 'buy milk')
    expect(h.store.snapshot()).toBe(version)
    expect(h.io.write).not.toHaveBeenCalled()
    h.store.commitDraft(row)
    await h.store.flush()
    expect(h.io.write).toHaveBeenCalledOnce()
    expect(h.source()).toBe('+ [ ] buy milk\n')
    h.store.commitDraft(h.list()[0]!)
    await h.store.flush()
    expect(h.io.write).toHaveBeenCalledOnce()
  })

  it('keeps the key of a task created here once the index returns it', async () => {
    const h = harness()
    const row = h.store.create(target)
    h.store.draft(row, 'created')
    h.store.commitDraft(row)
    await h.store.flush()
    expect(h.list().map((task) => task.key)).toEqual([row.key])
    h.store.update(h.list()[0]!, { checked: true })
    await h.store.flush()
    expect(h.source()).toBe('+ [x] created\n')
    expect(h.io.write).toHaveBeenCalledTimes(2)
  })

  it('folds an open draft into a change made from outside the editor', async () => {
    const h = harness()
    const row = h.store.create(target)
    h.store.draft(row, 'typed')
    h.store.update(row, { checked: true })
    await h.store.flush()
    expect(h.source()).toBe('+ [x] typed\n')
    const saved = h.all()[0]!
    h.store.draft(saved, 'typed more')
    h.store.update(saved, { dueDate: '2026-10-01' })
    await h.store.flush()
    expect(h.source()).toBe('+ [x] typed more [[2026-10-01]]\n')
  })

  it('discards a draft, and ignores changes to a task the draft emptied', async () => {
    const h = harness('+ [ ] keep\n')
    const row = h.list()[0]!
    h.store.draft(row, 'never saved')
    h.store.discardDraft(row)
    h.store.commitDraft(row)
    await h.store.flush()
    expect(h.io.write).not.toHaveBeenCalled()
    h.store.draft(row, '')
    h.store.update(row, { checked: true })
    await h.store.flush()
    expect(h.source()).not.toContain('keep')
    expect(h.list()).toEqual([])
    expect(h.io.failure).not.toHaveBeenCalled()
  })

  it('accepts twenty consecutive creates while a previous write is blocked', async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness()
    const write = h.io.write.getMockImplementation()!
    h.io.write.mockImplementationOnce(async (...args) => {
      await gate.promise
      await write(...args)
    })
    h.store.update(h.store.create(target), { text: 'task 0' })
    await vi.waitFor(() => expect(h.io.write).toHaveBeenCalledOnce())
    for (let index = 1; index < 20; index++) {
      h.store.update(h.store.create(target), { text: `task ${index}` })
    }
    const blank = h.store.create(target)
    expect(h.list()).toHaveLength(21)
    gate.resolve()
    await h.store.flush()
    h.store.update(blank, { gone: 'removed' })
    expect(h.source()?.match(/\+ \[ \]/g)).toHaveLength(20)
    expect(h.source()).toContain('task 19')
    expect(h.io.failure).not.toHaveBeenCalled()
    expect(h.list()).toHaveLength(20)
  })

  it('shows a pending change until the index reflects it', async () => {
    const gate = Promise.withResolvers<void>()
    const h = harness('+ [ ] before\n')
    const stale = indexed(h.source(), false)
    h.io.write.mockImplementationOnce(async () => {
      await gate.promise
    })
    h.store.update(stale[0]!, { text: 'after' })
    expect(h.store.list(stale)[0]?.text).toBe('after')
    gate.resolve()
    await h.store.flush()
    expect(h.store.list(stale)[0]?.text).toBe('before')
  })

  it('retains a failed change and retries without creating a duplicate', async () => {
    const h = harness()
    h.io.write.mockRejectedValueOnce(new Error('disk full'))
    h.store.update(h.store.create(target), { text: '保留文字' })
    await h.store.flush()
    expect(h.list()[0]?.text).toBe('保留文字')
    expect(h.io.failure).toHaveBeenCalledOnce()
    h.io.failure.mock.calls[0]![2]()
    await h.store.flush()
    expect(h.source()?.match(/保留文字/g)).toHaveLength(1)
    expect(h.io.saved).toHaveBeenCalledOnce()
  })

  it('keeps contextual creates beside their parent rather than at the document end', async () => {
    const h = harness('+ parent\n  + [ ] first\n\nend\n')
    const row = h.list()[0]!
    expect(row.breadcrumbs).toEqual(['parent'])
    const next = h.store.create({ ...target, breadcrumbs: ['parent'] }, row)
    h.store.update(next, { text: 'second' })
    await h.store.flush()
    expect(h.source()).toContain('  + [ ] second')
    expect(h.io.failure).not.toHaveBeenCalled()
  })

  it('holds checkbox and date changes locally until a new task has text', async () => {
    const h = harness()
    const row = h.store.create(target)
    h.store.update(row, { checked: true })
    h.store.update(row, { dueDate: '2026-10-01' })
    expect(h.io.read).not.toHaveBeenCalled()
    expect(h.store.current(row)).toMatchObject({ checked: true, dueDate: '2026-10-01' })
    h.store.update(row, { text: 'scheduled' })
    await h.store.flush()
    expect(h.source()).toContain('[x] scheduled [[2026-10-01]]')
    expect(h.io.write).toHaveBeenCalledOnce()
  })

  it('converts a new task with text into a bullet without losing it', async () => {
    const h = harness()
    const row = h.store.create(target)
    h.store.update(row, { text: 'keep this' })
    h.store.update(row, { gone: 'bullet' })
    await h.store.flush()
    expect(h.source()).toContain('+ keep this')
    expect(h.list()).toEqual([])
    expect(h.io.failure).not.toHaveBeenCalled()
  })

  it('follows a task the note moved when its text is unique', async () => {
    const h = harness('+ [ ] a\n+ [ ] b\n')
    const b = h.list()[1]!
    h.io.read.mockResolvedValueOnce('+ [ ] inserted\n+ [ ] a\n+ [ ] b\n')
    h.io.write.mockImplementationOnce(async () => {})
    h.store.update(b, { checked: true })
    await h.store.flush()
    expect(h.io.write.mock.calls[0]?.[2]).toBe('+ [ ] inserted\n+ [ ] a\n+ [x] b\n')
    expect(h.io.failure).not.toHaveBeenCalled()
  })

  it('does not redirect an edit to an ambiguous duplicate after an external change', async () => {
    const h = harness('+ [ ] same\n+ [ ] same\n')
    const row = { ...h.list()[0]!, text: 'stale text' }
    h.store.update(row, { text: 'my draft' })
    await h.store.flush()
    expect(h.io.write).not.toHaveBeenCalled()
    expect(h.list().some((task) => task.text === 'my draft')).toBe(true)
    expect(h.io.failure).toHaveBeenCalledOnce()
  })

  it('edits quoted backlink tasks without listing them', async () => {
    const source = '> + [ ] quoted\n\n+ [ ] visible\n'
    const h = harness(source)
    const quoted: Task = {
      ...target,
      key: indexedTaskKey(target.notePath, [0, 0]),
      astPath: [0, 0],
      text: 'quoted',
      displayText: 'quoted',
      checked: false,
      dueDate: null,
      breadcrumbs: [],
      updatedAt: 0,
    }
    h.store.update(quoted, { checked: true })
    h.store.update(quoted, { text: 'edited quote' })
    expect(h.all().map((task) => task.text)).toEqual(['visible'])
    await h.store.flush()
    expect(h.source()).toContain('> + [x] edited quote')
    expect(h.all().map((task) => task.text)).toEqual(['visible'])
    expect(h.io.failure).not.toHaveBeenCalled()
  })

  it('lists a completed task struck until archived, or until it is open again', async () => {
    const h = harness('+ [ ] one\n+ [ ] two\n')
    const [one, two] = h.list()
    h.store.update([one!], { checked: true })
    await h.store.flush()
    expect(h.list().map((task) => [task.text, task.checked])).toEqual([
      ['two', false],
      ['one', true],
    ])
    expect(h.store.isRecent(one!)).toBe(true)
    h.store.update([two!], { checked: true })
    await h.store.flush()
    h.store.update(h.list()[1]!, { checked: false })
    await h.store.flush()
    expect(h.list().map((task) => task.text)).toEqual(['two', 'one'])
    h.store.archive()
    expect(h.list().map((task) => task.text)).toEqual(['two'])
    expect(h.all().map((task) => task.text)).toEqual(['two', 'one'])
  })

  it('keeps a struck task and its key when a task above it is removed', async () => {
    const h = harness('+ [ ] one\n+ [ ] two\n+ [ ] three\n')
    const [one, two] = h.list()
    h.store.update([two!], { checked: true })
    await h.store.flush()
    h.store.update([one!], { gone: 'removed' })
    await h.store.flush()
    expect(h.source()).toBe('+ [x] two\n+ [ ] three\n')
    const rows = h.list()
    expect(rows.map((task) => [task.text, task.checked, h.store.isRecent(task)])).toEqual([
      ['three', false, false],
      ['two', true, true],
    ])
    expect(new Set(rows.map((task) => task.key)).size).toBe(2)
  })

  it('refuses to guess between identical tasks once the note changed elsewhere', async () => {
    const h = harness('+ [ ] same\n+ [ ] same\n')
    // A no-op change makes the store read the note once.
    h.store.update(h.list()[0]!, { text: 'same' })
    await h.store.flush()
    expect(h.io.read).toHaveBeenCalledOnce()
    const second = h.list()[1]!
    h.io.read.mockResolvedValueOnce('para\n\n+ [ ] same\n+ [ ] same\n')
    h.store.update(second, { text: 'edited second' })
    await h.store.flush()
    expect(h.io.write).not.toHaveBeenCalled()
    expect(h.io.failure).toHaveBeenCalledOnce()
    expect(h.list().some((task) => task.text === 'edited second')).toBe(true)
  })

  it('forgets a task created here once the index alone describes it', async () => {
    const h = harness()
    const row = h.store.create(target)
    h.store.update(row, { text: 'mine' })
    await h.store.flush()
    expect(h.list().map((task) => task.key)).toEqual([row.key])
    // The note editor rewrites the note: the task moves and changes.
    const rewritten = '+ [ ] above\n+ [x] mine, done in the editor\n'
    expect(h.store.list(indexed(rewritten, false)).map((task) => task.text)).toEqual(['above'])
    expect(h.store.list(indexed(rewritten, false), indexed(rewritten, true))).toHaveLength(2)
  })

  it('lists a written task once while the index refetch is still in flight', async () => {
    const h = harness()
    const gate = Promise.withResolvers<void>()
    const write = h.io.write.getMockImplementation()!
    h.io.write.mockImplementationOnce(async (...args) => {
      await write(...args)
      await gate.promise
    })
    const row = h.store.create(target)
    h.store.update(row, { text: 'written' })
    await vi.waitFor(() => expect(h.io.write).toHaveBeenCalledOnce())
    expect(h.list().map((task) => [task.key, task.text])).toEqual([[row.key, 'written']])
    gate.resolve()
    await h.store.flush()
    expect(h.list().map((task) => task.text)).toEqual(['written'])
  })

  it('keeps other changes flowing while one change waits on a conflict', async () => {
    const h = harness('+ [ ] a\n+ [ ] b\n')
    const [a, b] = h.list()
    h.store.update({ ...a!, text: 'stale' }, { text: 'edited a' })
    await h.store.flush()
    expect(h.io.failure).toHaveBeenCalledOnce()
    h.store.update([b!], { checked: true })
    await h.store.flush()
    expect(h.source()).toBe('+ [ ] a\n+ [x] b\n')
    expect(h.io.saved).not.toHaveBeenCalled()
    h.io.failure.mock.calls[0]![2]()
    await h.store.flush()
    expect(h.io.failure).toHaveBeenCalledTimes(2)
    expect(h.list().map((task) => task.text)).toEqual(['edited a', 'b'])
  })

  it('applies a change to several tasks of one note in one write', async () => {
    const h = harness('+ [ ] a\n+ [ ] b\n+ [ ] c\n')
    const [a, b] = h.list()
    h.store.update([a!, b!], { checked: true })
    await h.store.flush()
    expect(h.source()).toBe('+ [x] a\n+ [x] b\n+ [ ] c\n')
    expect(h.io.write).toHaveBeenCalledOnce()
    h.store.update(h.list(), { gone: 'removed' })
    await h.store.flush()
    expect(h.source()?.trim()).toBe('')
    expect(h.io.failure).not.toHaveBeenCalled()
  })

  it('keeps a change made during the index refetch on the right task', async () => {
    const h = harness('+ [ ] a\n+ [ ] b\n+ [ ] c\n')
    const [a, b, c] = h.list()
    h.store.update(c!, { checked: true })
    await h.store.flush()
    const gate = Promise.withResolvers<void>()
    const write = h.io.write.getMockImplementation()!
    h.io.write.mockImplementationOnce(async (...args) => {
      await write(...args)
      await gate.promise
    })
    h.store.update(a!, { gone: 'removed' })
    await vi.waitFor(() => expect(h.io.write).toHaveBeenCalledTimes(2))
    // The refetch has not landed: `b` is still keyed by its old path.
    h.store.update(b!, { checked: true })
    gate.resolve()
    await h.store.flush()
    expect(h.source()).toBe('+ [x] b\n+ [x] c\n')
    expect(h.io.failure).not.toHaveBeenCalled()
    expect(h.list().map((task) => [task.text, h.store.isRecent(task)])).toEqual(
      expect.arrayContaining([
        ['b', true],
        ['c', true],
      ]),
    )
  })

  it('flush saves typed drafts but never removes a task over an emptied one', async () => {
    const h = harness('+ [ ] keep\n')
    const row = h.list()[0]!
    h.store.draft(row, '')
    await h.store.flush()
    expect(h.io.write).not.toHaveBeenCalled()
    const fresh = h.store.create(target)
    h.store.draft(fresh, 'typed')
    await h.store.flush()
    expect(h.source()).toBe('+ [ ] keep\n+ [ ] typed\n')
    expect(h.store.commitDraft(row)).toBeNull()
    await h.store.flush()
    expect(h.source()).toBe('+ [ ] typed\n')
  })

  it('only lists a task struck when it was completed from the list', async () => {
    const h = harness('> + [ ] quoted\n\n+ [ ] visible\n')
    const quoted: Task = {
      ...target,
      key: indexedTaskKey(target.notePath, [0, 0]),
      astPath: [0, 0],
      text: 'quoted',
      displayText: 'quoted',
      checked: false,
      dueDate: null,
      breadcrumbs: [],
      updatedAt: 0,
    }
    h.store.update(quoted, { checked: true })
    h.store.update(h.list()[0]!, { checked: true })
    await h.store.flush()
    expect(h.source()).toBe('> + [x] quoted\n\n+ [x] visible\n')
    expect(h.list().map((task) => task.text)).toEqual(['visible'])
  })
})
