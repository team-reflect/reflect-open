import { noop } from '@ocavue/utils'
import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import {
  createTestCoreServices,
  createTestDatabaseService,
  makeOpenTask,
} from '@reflect/core/testing'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { TaskEditor } from './task-editor.tsx'

describe('TaskEditor', () => {
  it('keeps the typed text and leaves the row on Escape', async () => {
    const core = createTestCoreServices({ database: createTestDatabaseService() })
    const setDraft = vi.spyOn(core.tasks.commands, 'setDraft')
    const commit = vi.spyOn(core.tasks.commands, 'commit').mockResolvedValue()
    const task = makeOpenTask({ notePath: 'notes/a.md', astPath: [2], markdown: 'one' })
    const onCancel = vi.fn()
    const view = await renderInApp(
      <TaskEditor
        task={task}
        onContinue={noop}
        onCancel={onCancel}
        onComplete={noop}
        onConvertToBullet={noop}
        onDelete={noop}
        onDeleteEmpty={noop}
        onNavigate={noop}
      />,
      { core },
    )

    await expect.element(page.locate('.ProseMirror')).toHaveFocus()
    await userEvent.keyboard('more ')
    await userEvent.keyboard('{Escape}')

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(setDraft).toHaveBeenLastCalledWith(task, 'more one')
    expect(commit).not.toHaveBeenCalled()

    await view.unmount()
    await expect.poll(() => commit.mock.calls).toEqual([[task]])
  })
})
