import { vi, type Mock } from 'vitest'
import type { TestTaskIndex } from '@reflect/core/testing'
import type { TaskAction, TaskCommands, TaskLocator } from '@reflect/core'
import type { MaybePromise } from '@reflect/utils'

/**
 * The address of a task a write changed.
 */
export type WrittenTask = TaskLocator & { notePath: string }

/**
 * The spies of {@link spyOnTaskWrites}. A spy that returns a promise holds
 * its write until the promise settles, and a rejection fails the write.
 */
export interface TaskWriteSpies {
  /**
   * Called once for each task a write changes, with every action on that task.
   */
  writeTask: Mock<(task: WrittenTask, actions: TaskAction[]) => MaybePromise<void>>
  /**
   * Called once for each task a write adds.
   */
  insertTask: Mock<
    (notePath: string, task: { markdown: string; checked: boolean }) => MaybePromise<void>
  >
}

/**
 * Replace the file writes of `commands` with writes to `taskIndex`, and
 * report each write task by task.
 */
export function spyOnTaskWrites(commands: TaskCommands, taskIndex: TestTaskIndex): TaskWriteSpies {
  const spies: TaskWriteSpies = { writeTask: vi.fn(), insertTask: vi.fn() }
  vi.spyOn(commands, 'write').mockImplementation(async (_generation, notePath, edits) => {
    const changed = new Map<TaskLocator, TaskAction[]>()
    for (const edit of edits) {
      if (edit.kind === 'insert') {
        await spies.insertTask(notePath, {
          markdown: edit.markdown,
          checked: edit.checked === true,
        })
      } else {
        const { task, ...action } = edit
        const sameTask = [...changed.keys()].find((key) => {
          return key.astPath.join('.') === task.astPath.join('.')
        })
        changed.set(sameTask ?? task, [...(changed.get(sameTask ?? task) ?? []), action])
      }
    }
    for (const [task, actions] of changed) {
      await spies.writeTask({ notePath, ...task }, actions)
    }
    return taskIndex.write(notePath, edits)
  })
  return spies
}
