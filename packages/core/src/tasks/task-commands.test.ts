import { sleep } from '@ocavue/utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskHarness } from '../testing/task-harness.ts'
import type { OpenTask } from './open-task.ts'
import type { TaskCommands } from './task-commands.ts'
import { todaysDailyTarget } from './task-navigation.ts'

const A = 'notes/a.md'
const B = 'notes/b.md'
const TODAY = todaysDailyTarget('2026-06-14')

let harness: TaskHarness
let commands: TaskCommands

/**
 * Put `files` on disk and in the index, and return the open rows.
 */
async function start(files: Readonly<Record<string, string>>): Promise<readonly OpenTask[]> {
  harness = new TaskHarness({ files })
  commands = harness.tasks.commands
  await harness.start()
  return harness.tasks.get().open!
}

function file(path: string): string | undefined {
  return harness.files.files().get(path)
}

function shown(): Array<[taskId: string, markdown: string]> {
  return harness.tasks.get().open!.map((row) => [row.taskId, row.markdown])
}

afterEach(() => {
  harness.close()
})

describe('writes', () => {
  it('writes the changes of one command to one note in one write', async () => {
    const rows = await start({ [A]: '+ [ ] 1\n+ [ ] 2\n+ [ ] 3\n+ [ ] 4\n+ [ ] 5\n' })
    const reads = harness.files.getReads().length

    await commands.toggle(rows)

    expect(harness.files.getWrites(A)).toEqual(['+ [x] 1\n+ [x] 2\n+ [x] 3\n+ [x] 4\n+ [x] 5\n'])
    expect(harness.files.getReads()).toHaveLength(reads + 1)
    expect(harness.tasks.get().struck.map((row) => row.taskId)).toEqual(
      rows.map((row) => row.taskId),
    )
  })

  it('writes each note of a command once', async () => {
    const rows = await start({ [A]: '+ [ ] one\n+ [ ] two\n', [B]: '+ [ ] three\n' })

    await commands.remove(rows)

    expect(harness.files.getWrites(A)).toEqual([''])
    expect(harness.files.getWrites(B)).toEqual([''])
    expect(shown()).toEqual([])
  })

  it('takes the address of a task when its write starts', async () => {
    const rows = await start({ [A]: '+ [ ] one\n+ [ ] two\n+ [ ] three\n' })
    harness.holdWrites()

    const first = commands.remove([rows[0]!])
    const second = commands.remove([rows[2]!])
    expect(shown()).toEqual([[rows[1]!.taskId, 'two']])
    await harness.landWrite()
    await harness.landWrite()
    await Promise.all([first, second])

    expect(harness.files.getWrites(A)).toEqual(['+ [ ] two\n+ [ ] three\n', '+ [ ] two\n'])
  })

  it('keeps every command of a task that is toggled twice at once', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })

    const first = commands.toggle(rows)
    await Promise.all([first, commands.toggle(harness.tasks.get().struck)])

    expect(harness.files.getWrites(A)).toEqual(['+ [x] one\n', '+ [ ] one\n'])
    expect(shown()).toEqual([[rows[0]!.taskId, 'one']])
  })

  it('leaves a task checked that was completed elsewhere before its write starts', async () => {
    const rows = await start({ [A]: '+ [ ] one\n+ [ ] two\n' })
    harness.holdWrites()

    const removing = commands.remove([rows[1]!])
    const completing = commands.complete([rows[0]!])
    harness.editExternally(A, '+ [x] one\n+ [ ] two\n')
    await harness.deliverWatcherBatch()
    await harness.landWrite()
    await Promise.all([removing, completing])

    expect(file(A)).toBe('+ [x] one\n')
    expect(harness.files.getWrites(A)).toHaveLength(1)
  })

  it('completes a task that is added to a batch in flight', async () => {
    const rows = await start({ [A]: '+ [ ] one\n+ [ ] two\n+ [ ] three\n' })
    harness.holdWrites()

    const batch = commands.toggle([rows[0]!, rows[1]!])
    const single = commands.toggle([rows[2]!])
    await harness.landWrite()
    await harness.landWrite()
    await Promise.all([batch, single])

    expect(file(A)).toBe('+ [x] one\n+ [x] two\n+ [x] three\n')
    expect(shown()).toEqual([])
  })
})

describe('a task that changed under a command', () => {
  /**
   * Change `A` on disk and in the index while the rows still show the old text.
   */
  async function changeBehindRows(source: string): Promise<void> {
    harness.holdReads()
    harness.editExternally(A, source)
    await harness.deliverWatcherBatch()
  }

  it('reads the note again and writes once more', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })
    await changeBehindRows('+ [ ] one changed\n')

    const toggling = commands.toggle(rows)
    await sleep(0)
    await harness.landRead()
    await harness.landRead()
    await toggling

    expect(file(A)).toBe('+ [x] one changed\n')
    expect(harness.progress.get()).toEqual([])
  })

  it('writes nothing and shows no failure when the task left the note', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })
    await changeBehindRows('gone\n')

    const toggling = commands.toggle(rows)
    await sleep(0)
    await harness.landRead()
    await harness.landRead()
    await toggling

    expect(file(A)).toBe('gone\n')
    expect(shown()).toEqual([])
    expect(harness.progress.get()).toEqual([])
  })
})

describe('typed text', () => {
  it('writes the text when the row is left', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })

    commands.setDraft(rows[0]!, 'one more')
    expect(harness.files.getWrites(A)).toEqual([])
    await commands.commit(rows[0]!)

    expect(harness.files.getWrites(A)).toEqual(['+ [ ] one more\n'])
  })

  it('writes nothing for text equal to the task, or that differs in outer spaces only', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })

    await commands.commit(rows[0]!)
    commands.setDraft(rows[0]!, ' one ')
    await commands.commit(rows[0]!)

    expect(harness.files.getWrites(A)).toEqual([])
  })

  it('removes a task whose text was cleared, whatever the command', async () => {
    const rows = await start({ [A]: '+ [ ] one\n+ [ ] two\n' })

    commands.setDraft(rows[0]!, '')
    await commands.commit(rows[0]!)
    commands.setDraft(harness.tasks.get().open![0]!, ' ')
    await commands.toggle(harness.tasks.get().open!)

    expect(harness.files.getWrites(A)).toEqual(['+ [ ] two\n', ''])
  })

  it('saves the text in the write of the command that names the task', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })

    commands.setDraft(rows[0]!, 'one more')
    await commands.toggle(rows)

    expect(harness.files.getWrites(A)).toEqual(['+ [x] one more\n'])
  })

  it('schedules the typed text', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })

    commands.setDraft(rows[0]!, 'one more')
    await commands.schedule(rows, '2026-06-20')

    expect(harness.files.getWrites(A)).toEqual(['+ [ ] one more [[2026-06-20]]\n'])
  })

  it('shows a line and writes nothing for text that is not one task', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })

    commands.setDraft(rows[0]!, 'one\n\ntwo')
    await commands.commit(rows[0]!)

    expect(harness.files.getWrites(A)).toEqual([])
    expect(harness.progress.findByLabel('Saving task')?.message).toBe(
      'This text cannot be saved as one task. Remove the line that starts a new block.',
    )
  })

  it('keeps the text in the row when its write fails, and writes it later', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })
    const write = vi.spyOn(commands, 'write').mockRejectedValueOnce(new Error('disk full'))

    commands.setDraft(rows[0]!, 'one more')
    await commands.toggle(rows)
    expect(shown()).toEqual([[rows[0]!.taskId, 'one more']])
    expect(file(A)).toBe('+ [ ] one\n')

    write.mockRestore()
    await commands.commitDrafts()
    expect(file(A)).toBe('+ [ ] one more\n')
    expect(shown()).toEqual([[rows[0]!.taskId, 'one more']])
  })

  it('saves every typed text when the app is about to stop', async () => {
    const rows = await start({ [A]: '+ [ ] one\n' })
    const filled = commands.add(TODAY)
    const empty = commands.add(TODAY)

    commands.setDraft(rows[0]!, 'one more')
    commands.setDraft(filled, 'buy milk')
    await commands.commitDrafts()

    expect(file(A)).toBe('+ [ ] one more\n')
    expect(file(TODAY.notePath)).toBe('## Tasks\n\n+ [ ] buy milk\n')
    expect(shown()).toContainEqual([empty.taskId, ''])
  })
})

describe('a new task', () => {
  it('shows a row at once and writes nothing while it has no text', async () => {
    await start({})

    const row = commands.add(TODAY)
    expect(shown()).toEqual([[row.taskId, '']])
    expect(row).toMatchObject({ ...TODAY, breadcrumbs: ['Tasks'], checked: false })
    await commands.commit(row)

    expect(shown()).toEqual([])
    expect(harness.files.writes()).toEqual([])
    expect(file(TODAY.notePath)).toBeUndefined()
  })

  it('is written once, with its text, and keeps its id', async () => {
    await start({})

    const row = commands.add(TODAY)
    commands.setDraft(row, 'buy milk')
    await commands.commit(row)

    expect(harness.files.getWrites(TODAY.notePath)).toEqual(['## Tasks\n\n+ [ ] buy milk\n'])
    expect(shown()).toEqual([[row.taskId, 'buy milk']])
  })

  it('is written checked when it is completed', async () => {
    await start({})

    const row = commands.add(TODAY)
    commands.setDraft(row, 'buy milk')
    await commands.toggle([row])

    expect(harness.files.getWrites(TODAY.notePath)).toEqual(['## Tasks\n\n+ [x] buy milk\n'])
    expect(harness.tasks.get().struck.map((task) => task.taskId)).toEqual([row.taskId])
  })

  it('is dropped with no write when it is removed', async () => {
    await start({})

    const row = commands.add(TODAY)
    commands.setDraft(row, 'buy milk')
    await commands.remove([row])

    expect(shown()).toEqual([])
    expect(harness.files.writes()).toEqual([])
  })

  it('is written as a bullet when it is converted', async () => {
    await start({})

    const row = commands.add(TODAY)
    commands.setDraft(row, 'buy milk')
    await commands.convert([row])

    expect(harness.files.getWrites(TODAY.notePath)).toEqual(['## Tasks\n\n+ buy milk\n'])
    expect(shown()).toEqual([])
  })

  it('never reaches the file empty while three tasks are entered one after the other', async () => {
    await start({})

    const first = commands.add(TODAY)
    commands.setDraft(first, 'a')
    const second = commands.continueAfter(first)
    commands.setDraft(second, 'b')
    const third = commands.continueAfter(second)
    commands.setDraft(third, 'c')
    const fourth = commands.continueAfter(third)
    await commands.commit(fourth)
    await vi.waitFor(() => {
      return expect(file(TODAY.notePath)).toBe('## Tasks\n\n+ [ ] a\n+ [ ] b\n+ [ ] c\n')
    })

    expect(harness.files.getWrites(TODAY.notePath)).toEqual([
      '## Tasks\n\n+ [ ] a\n',
      '## Tasks\n\n+ [ ] a\n+ [ ] b\n',
      '## Tasks\n\n+ [ ] a\n+ [ ] b\n+ [ ] c\n',
    ])
    expect(shown()).toEqual([
      [first.taskId, 'a'],
      [second.taskId, 'b'],
      [third.taskId, 'c'],
    ])
  })

  it('ends the list of the task it continues', async () => {
    const rows = await start({ [A]: '+ Group\n  + [ ] first\n+ [ ] last\n' })

    commands.setDraft(rows[0]!, 'first!')
    const row = commands.continueAfter(rows[0]!)
    expect(shown()).toEqual([
      [rows[0]!.taskId, 'first!'],
      [row.taskId, ''],
      [rows[1]!.taskId, 'last'],
    ])
    commands.setDraft(row, 'second')
    await commands.commit(row)

    expect(harness.files.getWrites(A)).toEqual([
      '+ Group\n  + [ ] first!\n+ [ ] last\n',
      '+ Group\n  + [ ] first!\n  + [ ] second\n+ [ ] last\n',
    ])
  })

  it('takes the place of the empty new task it continues', async () => {
    const rows = await start({ [A]: '+ Group\n  + [ ] first\n+ [ ] last\n' })

    const empty = commands.continueAfter(rows[0]!)
    const row = commands.continueAfter(empty)
    commands.setDraft(row, 'second')
    await commands.commit(row)

    expect(file(A)).toBe('+ Group\n  + [ ] first\n  + [ ] second\n+ [ ] last\n')
    expect(shown().map(([taskId]) => taskId)).toEqual([
      rows[0]!.taskId,
      row.taskId,
      rows[1]!.taskId,
    ])
  })

  it('keeps its row and its text when its write fails', async () => {
    await start({})
    const write = vi.spyOn(commands, 'write').mockRejectedValueOnce(new Error('disk full'))

    const row = commands.add(TODAY)
    commands.setDraft(row, 'buy milk')
    await commands.commit(row)
    expect(shown()).toEqual([[row.taskId, 'buy milk']])
    expect(harness.progress.findByLabel('Saving task')?.message).toBe(
      'The task could not be saved.',
    )

    write.mockRestore()
    await commands.commitDrafts()
    expect(file(TODAY.notePath)).toBe('## Tasks\n\n+ [ ] buy milk\n')
    expect(shown()).toEqual([[row.taskId, 'buy milk']])
  })
})
