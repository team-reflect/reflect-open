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
    expect(indexed()).toEqual(['notes/a.md'])

    harness.holdReads()
    await harness.deliverWatcherBatch()
    expect(indexed()).toEqual(['notes/a.md', 'notes/a.md'])
    await harness.failRead(new Error('no index'))
    expect(harness.tasks.get().openFailed).toBe(true)

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
    expect(harness.tasks.get().openFailed).toBe(false)
    expect(harness.view().map((row) => row.markdown)).toEqual(['two', 'four'])
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
})
