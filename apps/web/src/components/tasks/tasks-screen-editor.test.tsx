import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { OpenTask } from '@reflect/core'
import {
  createTestCoreServices,
  createTestDatabaseService,
  makeOpenTask as task,
  TestTaskIndex,
  type TestCoreServices,
} from '@reflect/core/testing'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { spyOnTaskWrites } from '@/test-utils/task-writes.ts'
import { TasksScreen } from './tasks-screen.tsx'

/**
 * The Tasks screen with the real inline editor: where the focus goes and where
 * typed text lands. tasks-screen.test.tsx covers selection and command routing
 * with an editor stub.
 */

let core: TestCoreServices
let getOpenTasks: ReturnType<typeof vi.fn<() => Promise<OpenTask[]>>>

beforeEach(() => {
  core = createTestCoreServices({ database: createTestDatabaseService() })
  core.clock.setNow(new Date(2026, 5, 14, 12, 0, 0).getTime())
  getOpenTasks = vi.fn<() => Promise<OpenTask[]>>().mockResolvedValue([])
  const getCompletedTasks = vi.fn<() => Promise<OpenTask[]>>().mockResolvedValue([])
  spyOnTaskWrites(
    core.tasks.commands,
    new TestTaskIndex(core.database, getOpenTasks, getCompletedTasks),
  )
})

function renderScreen() {
  return renderInApp(<TasksScreen />, {
    core,
    graph: { root: '/g', name: 'g', generation: 1 },
    settings: { dateFormat: 'mdy' },
  })
}

describe('TasksScreen with the inline editor', () => {
  it('types into a row added after the last row', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', astPath: [2], markdown: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', astPath: [3], markdown: 'last', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()
    view.container.style.height = '600px'

    await userEvent.click(view.getByRole('button', { name: 'last', exact: true }))
    await expect.element(page.locate('[data-task-editor] .ProseMirror')).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => view.container.querySelectorAll('[data-task-key]').length).toBe(3)
    await userEvent.keyboard('next')

    await expect.element(page.locate('[data-task-editor] .ProseMirror')).toHaveFocus()
    await expect.element(page.locate('[data-task-editor] .ProseMirror')).toHaveTextContent('next')
    await view.unmount()
  })

  it('types into a row added to an empty list', async () => {
    const view = await renderScreen()
    view.container.style.height = '600px'
    await expect.element(view.getByText('No tasks to show.')).toBeInTheDocument()

    await userEvent.keyboard('{Enter}')
    await expect.poll(() => view.container.querySelectorAll('[data-task-key]').length).toBe(1)
    await userEvent.keyboard('first')

    await expect.element(page.locate('[data-task-editor] .ProseMirror')).toHaveFocus()
    await expect.element(page.locate('[data-task-editor] .ProseMirror')).toHaveTextContent('first')
    await view.unmount()
  })
})
