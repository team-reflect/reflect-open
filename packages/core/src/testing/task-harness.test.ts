import { afterEach, describe, expect, it } from 'vitest'
import { createTaskHarness, type TaskHarness } from './task-harness.ts'

const harnesses: TaskHarness[] = []

/**
 * A started harness over `files`, closed after the test.
 */
async function start(files: Readonly<Record<string, string>>): Promise<TaskHarness> {
  const harness = createTaskHarness({ files })
  harnesses.push(harness)
  await harness.start()
  return harness
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.close()
  }
})

describe('createTaskHarness', () => {
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
