import { sleep } from '@ocavue/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    const editing = harness.edit(harness.tasks.get().open![0]!, 'two')
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

    await harness.edit(row('one'), 'one, edited')
    await harness.deliverWatcherBatch()
    harness.editExternally('notes/b.md', '+ [ ] zero\n+ [ ] three\n')
    await harness.deliverWatcherBatch()
    await harness.drain()
    expect(harness.view()).toEqual(harness.projectFiles())

    await harness.tasks.commands.toggle([row('two')])
    await harness.startPass()
    await harness.endPass()
    await harness.edit(row('three'), 'four')
    harness.suspend()
    harness.editExternally('notes/c.md', '+ [ ] five\n')
    await harness.deliverWatcherBatch()
    await harness.resume()
    await harness.drain()

    expect(harness.view().map((task) => task.markdown)).toEqual([
      'one, edited',
      'zero',
      'four',
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

describe('task rows during an index rebuild', () => {
  it('keep showing, under their ids, while the index holds no row', async () => {
    const harness = await start({ 'notes/a.md': '+ [ ] one\n+ [ ] two\n' })
    const before = harness.tasks.get().open
    let whileEmpty: unknown
    const clear = harness.indexStore.clear.bind(harness.indexStore)
    vi.spyOn(harness.indexStore, 'clear').mockImplementation(async (generation) => {
      const commit = await clear(generation)
      await sleep(0)
      whileEmpty = harness.tasks.get().open
      return commit
    })

    await harness.index.rebuildVisibly()
    await harness.drain()

    expect(whileEmpty).toBe(before)
    expect(harness.tasks.get().open?.map((row) => row.taskId)).toEqual(
      before?.map((row) => row.taskId),
    )
    expect(harness.view()).toEqual(harness.projectFiles())
  })
})

/**
 * A pseudo-random number generator over `seed`: the same numbers on every run.
 */
function createRandom(seed: number): (limit: number) => number {
  let state = seed
  return (limit) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state % limit
  }
}

describe('task rows under interleaved writes and file changes', () => {
  const NOTES = ['notes/a.md', 'notes/b.md', 'daily/2026-11-23.md']

  it.each([1, 2, 3, 4, 5, 6])('show each task once and end as the files, seed %i', async (seed) => {
    const harness = await start({
      'notes/a.md': '## Tasks\n\n+ [ ] a1\n+ [ ] a2\n  + [ ] a3\n',
      'notes/b.md': '+ [ ] same\n+ [ ] same\n',
    })
    const random = createRandom(seed)
    const writes: Promise<unknown>[] = []
    const pick = () => {
      const open = harness.tasks.get().open ?? []
      return open[random(Math.max(open.length, 1))]
    }

    for (let step = 0; step < 40; step += 1) {
      const row = pick()
      switch (random(7)) {
        case 0:
          if (row !== undefined) writes.push(harness.edit(row, `edit ${step}`))
          break
        case 1:
          if (row !== undefined) writes.push(harness.tasks.commands.toggle([row]))
          break
        case 2:
          if (row !== undefined) {
            writes.push(harness.edit(harness.tasks.commands.continueAfter(row), `new ${step}`))
          }
          break
        case 3:
          if (row !== undefined) writes.push(harness.tasks.commands.remove([row]))
          break
        case 4: {
          const path = NOTES[random(NOTES.length)]!
          const source = harness.files.files().get(path) ?? ''
          harness.editExternally(path, `+ [ ] outside ${step}\n${source}`)
          break
        }
        case 5:
          await harness.deliverWatcherBatch()
          break
        case 6:
          await harness.startPass()
          await harness.endPass()
          break
      }
      await sleep(0)
      const shown = [...(harness.tasks.get().open ?? []), ...harness.tasks.get().struck]
      expect(new Set(shown.map((task) => task.taskId)).size).toBe(shown.length)
    }

    await Promise.allSettled(writes)
    await harness.drain()
    expect(harness.view()).toEqual(harness.projectFiles())
  })
})
