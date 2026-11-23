import { afterEach, describe, expect, it } from 'vitest'
import { TaskHarness } from './task-harness.ts'

const harnesses: TaskHarness[] = []

/**
 * A started harness over `files`, closed after the test.
 */
async function start(files: Readonly<Record<string, string>>): Promise<TaskHarness> {
  const harness = new TaskHarness({ files })
  harnesses.push(harness)
  await harness.start()
  return harness
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.close()
  }
})

describe('TaskHarness', () => {
  it('steps the pipeline one event at a time', async () => {
    const harness = await start({ 'notes/a.md': '+ [ ] one\n' })
    const indexed = () => harness.indexStore.applied().map((note) => note.path)
    expect(harness.view().map((row) => row.markdown)).toEqual(['one'])
    expect(indexed()).toEqual(['notes/a.md'])

    harness.holdWrites()
    const editing = harness.tasks.editTask(harness.tasks.get().open![0]!, 'two')
    expect(harness.files.files().get('notes/a.md')).toBe('+ [ ] one\n')
    await harness.landWrite()
    await editing
    expect(harness.files.files().get('notes/a.md')).toBe('+ [ ] two\n')
    expect(indexed()).toEqual(['notes/a.md', 'notes/a.md'])

    await harness.deliverWatcherBatch()
    expect(indexed()).toEqual(['notes/a.md', 'notes/a.md'])

    harness.editExternally('notes/b.md', '+ [ ] three\n')
    await harness.startPass()
    expect(indexed()).toEqual(['notes/a.md', 'notes/a.md'])
    await harness.endPass()
    expect(indexed()).toEqual(['notes/a.md', 'notes/a.md', 'notes/b.md'])

    harness.suspend()
    harness.editExternally('notes/b.md', '+ [ ] four\n')
    await harness.deliverWatcherBatch()
    expect(indexed()).toHaveLength(3)
    await harness.resume()
    expect(indexed()).toHaveLength(4)

    await harness.drain()
    expect(harness.view().map((row) => row.markdown)).toEqual(['two', 'four'])
  })
})

describe('note commit', () => {
  it('is readable from the index once it returns', async () => {
    const harness = await start({ 'notes/a.md': '+ [ ] one\n' })

    const { revision, indexSeq } = await harness.documents.commitSourceEdit(
      'notes/a.md',
      (source) => source.replace('one', 'two'),
      { generation: harness.session.generation },
    )

    const read = await harness.database.read('index_tasks', { checked: false, paths: null })
    expect(indexSeq).not.toBeNull()
    expect(read.seq).toBeGreaterThanOrEqual(indexSeq!)
    expect(read.notes.map((note) => [note.hash, note.tasks.map((task) => task.markdown)])).toEqual([
      [revision, ['two']],
    ])
  })
})

describe('note commit echo', () => {
  it('applies the projection once, and the watcher echo applies nothing', async () => {
    const harness = await start({ 'notes/a.md': '+ [ ] one\n' })
    const before = harness.indexStore.calls().length

    await harness.documents.commitSourceEdit(
      'notes/a.md',
      (source) => source.replace('one', 'two'),
      { generation: harness.session.generation },
    )
    await harness.index.drained()
    expect(
      harness.indexStore
        .calls()
        .slice(before)
        .map((call) => call.method),
    ).toEqual(['applyBatch'])

    await harness.deliverWatcherBatch()
    expect(harness.indexStore.calls()).toHaveLength(before + 1)
  })
})

describe('drained task view', () => {
  it('equals the open tasks of the files after writes, external edits, a pass, and a suspend', async () => {
    const harness = await start({
      'notes/a.md': '## Tasks\n\n+ [ ] one\n+ [ ] two\n',
      'notes/b.md': '+ [ ] three\n',
    })
    const row = (markdown: string) => {
      return harness.tasks.get().open!.find((task) => task.markdown === markdown)!
    }

    await harness.tasks.editTask(row('one'), 'one, edited')
    await harness.deliverWatcherBatch()
    harness.editExternally('notes/b.md', '+ [ ] zero\n+ [ ] three\n')
    await harness.deliverWatcherBatch()
    await harness.drain()
    expect(harness.view()).toEqual(harness.projectFiles())

    await harness.tasks.completeTasks([row('two')])
    await harness.startPass()
    await harness.endPass()
    await harness.tasks.addTaskAfter(row('three'), 'four')
    harness.suspend()
    harness.editExternally('notes/c.md', '+ [ ] five\n')
    await harness.deliverWatcherBatch()
    await harness.resume()
    await harness.drain()

    expect(harness.view().map((task) => task.markdown)).toEqual([
      'one, edited',
      'zero',
      'four',
      '',
      'five',
    ])
    expect(harness.view()).toEqual(harness.projectFiles())
  })

  it('equals the open tasks of the files after a failed pass, a suspend, and a watcher error', async () => {
    const harness = await start({
      'notes/a.md': '+ [ ] one\n',
      'notes/b.md': '+ [ ] two\n',
      'notes/c.md': '+ [ ] three\n',
    })

    await harness.startPass()
    harness.editExternally('notes/a.md', '+ [ ] one, during a failed pass\n')
    await harness.deliverWatcherBatch()
    await harness.failPass(new Error('scan failed'))

    harness.suspend()
    harness.editExternally('notes/b.md', '+ [ ] two, while suspended\n')
    await harness.deliverWatcherBatch()
    await harness.resume()

    harness.editExternally('notes/c.md', '+ [ ] three, lost by the watcher\n')
    await harness.failWatcher()
    await harness.failPass(new Error('scan failed'))
    expect(harness.view()).not.toEqual(harness.projectFiles())
    await harness.drain()

    expect(harness.view().map((task) => task.markdown)).toEqual([
      'one, during a failed pass',
      'two, while suspended',
      'three, lost by the watcher',
    ])
    expect(harness.view()).toEqual(harness.projectFiles())
  })
})
