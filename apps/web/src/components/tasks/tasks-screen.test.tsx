import { createTestWindowService, type TestWindowService } from '@reflect/app/testing'
import { sleep } from '@ocavue/utils'
import { userEvent, type Locator } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createTestDatabaseService,
  createTestCoreServices,
  makeOpenTask as task,
  TestTaskIndex,
  type TestCoreServices,
} from '@reflect/core/testing'
import type { OpenTask } from '@reflect/core'
import { StrictMode, type ReactNode } from 'react'
import { act } from '@/test-utils/act.ts'
import { useRouterState } from '@/routing/router.tsx'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { MOD_KEY } from '@/test-utils/mod-key.ts'
import { scrollElement } from '@/test-utils/scroll.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { spyOnTaskWrites, type TaskAction, type TaskWriteSpies } from '@/test-utils/task-writes.ts'
import { useTaskDraft } from '@/lib/tasks/use-task-draft.ts'
import type { TaskEditorHandlers } from './task-editor.tsx'
import { TasksScreen } from './tasks-screen.tsx'
import { deepLinkForRoute } from '@reflect/app'

// The screen runs on the real `TaskService` of the test app services. Each
// test supplies the rows the index returns through `getOpenTasks` and
// `getCompletedTasks`, and steers the writes through the spies.
let getOpenTasks: Mock<() => Promise<OpenTask[]>>
let getCompletedTasks: Mock<() => Promise<OpenTask[]>>
let writeTask: TaskWriteSpies['writeTask']
let insertTask: TaskWriteSpies['insertTask']

type TaskActionKind = TaskAction['kind']

function isWrite(actions: readonly TaskAction[], kinds: readonly TaskActionKind[]): boolean {
  return actions.length === kinds.length && actions.every((action, i) => action.kind === kinds[i])
}

/**
 * The `writeTask` calls whose actions are exactly `kinds`, e.g. `('setMarkdown', 'toggle')`.
 */
function writesOf(...kinds: TaskActionKind[]): unknown[][] {
  return writeTask.mock.calls.filter((call) => isWrite(call[1], kinds))
}

/**
 * Reject the writes of a task whose actions are exactly `kinds`; every other write succeeds.
 */
function failWrites(kinds: TaskActionKind[], cause: Error): void {
  writeTask.mockImplementation((_task, actions) => {
    return isWrite(actions, kinds) ? Promise.reject(cause) : undefined
  })
}

// Stub the real inline editor with buttons for its keys and for typing, over
// the real draft hook, so selection and command routing is testable here.
vi.mock('./task-editor', () => ({
  TaskEditor: ({
    task,
    onContinue,
    onCancel,
    onComplete,
    onConvertToBullet,
    onDelete,
    onDeleteEmpty,
    onNavigate,
  }: TaskEditorHandlers & { task: OpenTask }) => {
    const setDraft = useTaskDraft(task)
    return (
      <div data-task-editor data-testid="task-editor">
        <span>editing: {task.text}</span>
        <button type="button" onClick={() => setDraft('edited content')}>
          type-edit
        </button>
        <button type="button" onClick={() => setDraft('')}>
          clear-edit
        </button>
        <button type="button" onClick={onContinue}>
          continue-edit
        </button>
        <button type="button" onClick={onDelete}>
          delete-edit
        </button>
        <button type="button" onClick={onDeleteEmpty}>
          delete-empty-edit
        </button>
        <button type="button" onClick={onCancel}>
          cancel-edit
        </button>
        <button type="button" onClick={onComplete}>
          complete-edit
        </button>
        <button type="button" onClick={onConvertToBullet}>
          convert-edit
        </button>
        <button type="button" onClick={() => onNavigate(1, { span: false })}>
          nav-down
        </button>
        <button type="button" onClick={() => onNavigate(-1, { span: false })}>
          nav-up
        </button>
      </div>
    )
  },
}))

function RouteProbe(): ReactNode {
  const { route } = useRouterState()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderScreen() {
  return renderInApp(
    <>
      <TasksScreen />
      <RouteProbe />
    </>,
    {
      core,
      appServices: { window: noteWindows },
      graph: { root: '/g', name: 'g', generation: 1 },
      settings: { dateFormat: 'mdy' },
    },
  ).then((view) => {
    const find = async (locator: Locator): Promise<Element> => {
      await expect.element(locator).toBeInTheDocument()
      return locator.element()
    }
    const locateByRole = view.getByRole.bind(view)
    const getByRole = (...args: Parameters<typeof view.getByRole>): Locator => {
      const [role, options] = args
      return locateByRole(
        role,
        typeof options?.name === 'string' ? { ...options, exact: true } : options,
      )
    }
    const locateByText = view.getByText.bind(view)
    const getByText = (...args: Parameters<typeof view.getByText>): Locator => {
      const [text, options] = args
      return locateByText(text, typeof text === 'string' ? { ...options, exact: true } : options)
    }
    return Object.assign(view, {
      getByRole,
      getByText,
      findByRole: (...args: Parameters<typeof view.getByRole>) => find(getByRole(...args)),
      findByTestId: (...args: Parameters<typeof view.getByTestId>) => {
        return find(view.getByTestId(...args))
      },
      findByText: (...args: Parameters<typeof view.getByText>) => find(getByText(...args)),
      getAllByRole: (...args: Parameters<typeof view.getByRole>) => getByRole(...args).elements(),
      getAllByText: (...args: Parameters<typeof view.getByText>) => getByText(...args).elements(),
      queryByRole: (...args: Parameters<typeof view.getByRole>) => getByRole(...args).query(),
      queryByTestId: (...args: Parameters<typeof view.getByTestId>) => {
        return view.getByTestId(...args).query()
      },
      queryByText: (...args: Parameters<typeof view.getByText>) => getByText(...args).query(),
    })
  })
}

const waitFor = vi.waitFor

let storage: TestCoreServices['storage']

let operations: TestCoreServices['progress']

let core: TestCoreServices
let noteWindows: TestWindowService

beforeEach(() => {
  // A fresh app per test, so its task service's recently-completed set starts empty.
  core = createTestCoreServices({ database: createTestDatabaseService() })
  noteWindows = createTestWindowService()
  operations = core.progress
  storage = core.storage
  core.clock.setNow(new Date(2026, 5, 14, 12, 0, 0).getTime())
  const tasks = core.tasks
  getOpenTasks = vi.fn<() => Promise<OpenTask[]>>().mockResolvedValue([])
  getCompletedTasks = vi.fn<() => Promise<OpenTask[]>>().mockResolvedValue([])
  const taskIndex = new TestTaskIndex(core.database, getOpenTasks, getCompletedTasks)
  const spies = spyOnTaskWrites(tasks.commands, taskIndex)
  writeTask = spies.writeTask
  insertTask = spies.insertTask
})

// Keep native browser navigation out of keyboard-handler tests in this suite.
describe('TasksScreen', () => {
  it('shows an empty state when there are no open tasks', async () => {
    getOpenTasks.mockResolvedValue([])
    const view = await renderScreen()
    await view.findByText('No tasks to show.')
    await view.unmount()
  })

  it('does not flash an empty state while archived tasks are still loading', async () => {
    storage.session.set('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    const pendingCompleted = Promise.withResolvers<OpenTask[]>()
    getCompletedTasks.mockReturnValue(pendingCompleted.promise)
    const view = await renderScreen()

    // Open resolved to []; completed still loading → no false "empty" yet.
    await waitFor(() => expect(getOpenTasks).toHaveBeenCalled())
    expect(view.queryByText('No tasks to show.')).toBeNull()

    // Completed resolves with a task → it appears (was never reported empty).
    pendingCompleted.resolve([
      task({ notePath: 'notes/p.md', text: 'archived task', noteTitle: 'P', checked: true }),
    ])
    await view.findByText('archived task')
    expect(view.queryByText('No tasks to show.')).toBeNull()
    await view.unmount()
  })

  it('shows no error for a failed read and lists the tasks once a read lands', async () => {
    getOpenTasks
      .mockRejectedValueOnce(new Error('index unavailable'))
      .mockResolvedValue([task({ notePath: 'notes/p.md', text: 'open task', noteTitle: 'P' })])
    const view = await renderScreen()
    await waitFor(() => expect(getOpenTasks).toHaveBeenCalledTimes(1))
    expect(view.queryByRole('alert')).toBeNull()

    await act(() => core.clock.advance(250))
    await view.findByText('open task')
    await view.unmount()
  })

  it('groups tasks by date bucket then note, in display order', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'daily/2026-06-14.md',
        dailyDate: '2026-06-14',
        text: 'today task',
        noteTitle: '2026-06-14',
      }),
      // Overdue needs an explicit past due date (V1 asymmetry) — a bare past
      // daily-note task would be Current.
      task({ notePath: 'notes/d.md', markdown: 'overdue task [[2026-06-10]]', noteTitle: 'D' }),
      task({ notePath: 'notes/p.md', text: 'project task', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await view.findByText('today task')
    const headers = view.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)
    expect(headers).toEqual(['Current', 'Overdue', 'Project'])
    await expect.element(view.getByText(/overdue task/)).toBeInTheDocument()
    await expect.element(view.getByText('project task')).toBeInTheDocument()
    await view.unmount()
  })

  it('renders one breadcrumb per consecutive task context and selects that context', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        text: 'first',
        noteTitle: 'Project',
        breadcrumbs: ['StartupToolbox', 'Reflections'],
      }),
      task({
        notePath: 'notes/p.md',
        astPath: [20],
        text: 'second',
        noteTitle: 'Project',
        breadcrumbs: ['StartupToolbox', 'Reflections'],
      }),
      task({
        notePath: 'notes/p.md',
        astPath: [40],
        text: 'third',
        noteTitle: 'Project',
        breadcrumbs: ['StartupToolbox', 'Later'],
      }),
    ])
    const view = await renderScreen()

    const context = await view.findByRole('button', {
      name: 'StartupToolbox → Reflections',
    })
    expect(view.getAllByText('StartupToolbox → Reflections')).toHaveLength(1)
    view.getByText('StartupToolbox → Later')

    await userEvent.click(context)
    await expect
      .element(view.getByRole('button', { name: 'Convert to bullet 2' }))
      .toBeInTheDocument()
    await view.unmount()
  })

  it('shows the full heading chain and hides only a lone Tasks parent', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        text: 'chore task',
        noteTitle: 'Project',
        breadcrumbs: ['Home', 'House chore'],
      }),
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        text: 'project task',
        noteTitle: 'Project',
        breadcrumbs: ['Tasks', 'Kitchen'],
      }),
      task({
        notePath: 'notes/p.md',
        astPath: [8],
        text: 'lone task',
        noteTitle: 'Project',
        breadcrumbs: ['Tasks'],
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'Home → House chore' })
    await view.findByRole('button', { name: 'Tasks → Kitchen' })
    await view.findByText('lone task')
    expect(view.queryByRole('button', { name: 'Tasks', exact: true })).toBeNull()
    await view.unmount()
  })

  it('selects a heading context only within its source note in date buckets', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [1],
        text: 'tidy desk',
        noteTitle: 'A',
        dailyDate: '2026-06-14',
        breadcrumbs: ['House chore'],
      }),
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        text: 'clean kitchen',
        noteTitle: 'A',
        dailyDate: '2026-06-14',
        breadcrumbs: ['House chore'],
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [1],
        text: 'water plants',
        noteTitle: 'B',
        dailyDate: '2026-06-14',
        breadcrumbs: ['House chore'],
      }),
    ])
    const view = await renderScreen()

    await view.findByText('water plants')
    const contexts = view.getAllByRole('button', { name: 'House chore', exact: true })
    expect(contexts).toHaveLength(2)
    await userEvent.click(contexts[0]!)
    await view.findByRole('button', { name: 'Convert to bullet 2' })
    await view.unmount()
  })

  it('opens a task’s source note from its title without an arrow', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        dailyDate: null,
        dueDate: '2026-06-10',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    const sourceLink = await view.findByRole('button', { name: 'Project' })
    expect(sourceLink.querySelector('svg')).toBeNull()
    await userEvent.click(sourceLink)
    expect(view.getByTestId('route').element().textContent).toContain('notes/p.md')
    await view.unmount()
  })

  it('opens a modifier-clicked task source in a new window without selecting the row', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        dailyDate: null,
        dueDate: '2026-06-10',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    fireEvent.click(await view.findByRole('button', { name: 'Project' }), {
      metaKey: true,
      ctrlKey: true,
    })

    await waitFor(() => {
      expect(noteWindows.openedNoteWindows()).toEqual([
        deepLinkForRoute({
          kind: 'note',
          path: 'notes/p.md',
        }),
      ])
    })
    expect(view.getByTestId('route').element().textContent).toBe('{"kind":"today"}')
    expect(view.queryByTestId('task-editor')).toBeNull()
    await view.unmount()
  })

  it('opens a modifier-clicked note-group title in a new window', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', text: 'project task', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    fireEvent.click(await view.findByRole('button', { name: 'Project' }), {
      metaKey: true,
      ctrlKey: true,
    })

    await waitFor(() => {
      expect(noteWindows.openedNoteWindows()).toEqual([
        deepLinkForRoute({
          kind: 'note',
          path: 'notes/p.md',
        }),
      ])
    })
    expect(view.getByTestId('route').element().textContent).toBe('{"kind":"today"}')
    await view.unmount()
  })

  it('opens a task’s source note from its date without editing the task', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'daily/2026-06-09.md',
        dailyDate: '2026-06-09',
        text: 'daily task',
        noteTitle: '2026-06-09',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Tue, June 9th, 2026' }))

    expect(view.getByTestId('route').element().textContent).toBe(
      '{"kind":"daily","date":"2026-06-09"}',
    )
    expect(view.queryByTestId('task-editor')).toBeNull()
    await view.unmount()
  })

  it('renders unfocused task content through the markdown preview', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markdown: 'ship **bold** text',
        text: 'ship bold text',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    // The preview hides the `**` marks; they stay in the DOM as `.md-mark`.
    const strong = view
      .getByRole('button', { name: /^ship/ })
      .locate('[data-mark-mode="hide"] strong')
    await expect.element(strong).toBeInTheDocument()
    expect(strong.element().textContent?.replaceAll('**', '')).toBe('bold')
    await view.unmount()
  })

  it('selects a task when clicking the row outside the text control', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', astPath: [2], text: 'full row', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'full row' })
    const row = view.container.querySelector('[data-task-key]')
    expect(row).toBeInstanceOf(HTMLElement)
    await userEvent.click(row as HTMLElement)

    expect(view.getByTestId('task-editor').element().textContent).toContain('full row')
    await view.unmount()
  })

  it('opens the inline editor on a sole selection, and Escape exits it', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', astPath: [2], text: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', astPath: [3], text: 'second', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    // A single click selects exclusively → that row swaps to the inline editor.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    expect(view.getByTestId('task-editor').element().textContent).toContain('first')
    expect(
      view.getByRole('button', { name: 'second' }).element().getAttribute('aria-pressed'),
    ).toBe('false')

    // Clicking another row moves the sole selection (and the editor) to it.
    await userEvent.click(view.getByRole('button', { name: 'second' }))
    expect(view.getByTestId('task-editor').element().textContent).toContain('second')

    await userEvent.keyboard('{Escape}')
    expect(view.queryByTestId('task-editor')).toBeNull()
    expect(view.getByRole('button', { name: 'first' }).element().getAttribute('aria-pressed')).toBe(
      'false',
    )
    await view.unmount()
  })

  it('keeps the edited row mounted while it is out of view, then scrolls the next selection into view', async () => {
    getOpenTasks.mockResolvedValue(
      Array.from({ length: 200 }, (_, index) => {
        return task({
          notePath: 'notes/p.md',
          astPath: [index],
          text: `task ${index}`,
          noteTitle: 'Project',
        })
      }),
    )
    const view = await renderScreen()
    view.container.style.height = '600px'
    await userEvent.click(await view.findByRole('button', { name: 'task 0' }))
    const scroller = view
      .getByTestId('task-editor')
      .element()
      .closest<HTMLElement>('.overflow-auto')!
    await waitFor(() => expect(view.queryByRole('button', { name: 'task 150' })).toBeNull())

    await scrollElement({ element: scroller, top: 5000 })
    await view.findByRole('button', { name: 'task 125' })
    expect(view.getByTestId('task-editor').element().textContent).toContain('task 0')

    // The row lands below the stuck group header, not under it.
    await userEvent.keyboard('{ArrowDown}')
    await waitFor(() => {
      const editor = view.getByTestId('task-editor').element()
      expect(editor.textContent).toContain('task 1')
      const header = view.getByRole('heading', { name: 'Project' }).element()
      expect(editor.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        header.getBoundingClientRect().bottom,
      )
      expect(scroller.scrollTop).toBeLessThan(100)
    })
    await view.unmount()
  })

  it('saves typed text when the row is left or on Escape, and deletes', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', astPath: [2], markdown: 'first', noteTitle: 'P' }),
      task({ notePath: 'notes/p.md', astPath: [3], markdown: 'second', noteTitle: 'P' }),
    ])
    const view = await renderScreen()

    // Type, then select another row: one setMarkdown write with the new content.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'second' }))
    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', astPath: [2] }),
        [{ kind: 'setMarkdown', markdown: 'edited content' }],
      )
    })
    await view.findByText('editing: second')

    // Type and press Escape: edit mode exits and the text is written.
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByText('cancel-edit'))
    expect(view.queryByTestId('task-editor')).toBeNull()
    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', astPath: [3] }),
        [{ kind: 'setMarkdown', markdown: 'edited content' }],
      )
    })
    expect(writeTask).toHaveBeenCalledTimes(2)

    // Re-select and delete: a remove write, row gone.
    await userEvent.click(view.getByRole('button', { name: 'edited content' }).first())
    await userEvent.click(view.getByText('delete-edit'))
    await waitFor(() => expect(writesOf('remove')).toHaveLength(1))
    await view.unmount()
  })

  it('saves typed text when the screen goes away', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('type-edit'))
    expect(writeTask).not.toHaveBeenCalled()
    await view.unmount()

    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', astPath: [2] }),
        [{ kind: 'setMarkdown', markdown: 'edited content' }],
      )
    })
  })

  it('completes from the editor: typed text and the toggle are one write', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByText('complete-edit'))
    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', astPath: [2] }),
        [{ kind: 'setMarkdown', markdown: 'edited content' }, { kind: 'toggle' }],
      )
    })
    expect(writeTask).toHaveBeenCalledTimes(1)
    await view.unmount()
  })

  it('editing an already-completed task with ⌘↵ saves the text, never reopens it', async () => {
    storage.session.set('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        markdown: 'done task',
        text: 'done task',
        checked: true,
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'done task' }))
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByText('complete-edit'))
    await waitFor(() => expect(writesOf('setMarkdown')).not.toHaveLength(0))
    // The marker stays `[x]` — no toggle back to open.
    expect(writesOf('toggle')).toHaveLength(0)
    await view.unmount()
  })

  it('completes from the editor: an unchanged task just toggles, no edit', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('complete-edit'))
    await waitFor(() => expect(writesOf('toggle')).toHaveLength(1))
    expect(writesOf('setMarkdown')).toHaveLength(0)
    await view.unmount()
  })

  it('toggles rows with ⌘-click and selects a range with shift-click', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', astPath: [2], text: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', astPath: [3], text: 'second', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', astPath: [4], text: 'third', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()
    const pressed = (name: string) => {
      return view.getByRole('button', { name }).element().getAttribute('aria-pressed') === 'true'
    }

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    // ⌘-click adds the row without clearing the rest (modifier set explicitly —
    // userEvent's held modifiers don't reach its synthetic click).
    await act(() => {
      fireEvent.click(view.getByRole('button', { name: 'third' }), MOD_KEY)
    })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, false, true])
    expect(noteWindows.openedNoteWindows()).toEqual([])

    // Shift-click from the anchor (third) back to first selects the whole range.
    await act(() => {
      fireEvent.click(view.getByRole('button', { name: 'first' }), { shiftKey: true })
    })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, true, true])
    await view.unmount()
  })

  it('selects all with ⌘A and moves a single selection with the arrow keys', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', astPath: [2], text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', astPath: [2], text: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()
    const pressed = (name: string) => {
      return view.getByRole('button', { name }).element().getAttribute('aria-pressed') === 'true'
    }

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    // Two selected → both stay buttons (the editor only opens for a sole row).
    expect([pressed('first'), pressed('second')]).toEqual([true, true])

    // ↓ collapses to a single moving selection → that row opens the editor.
    await userEvent.keyboard('{ArrowDown}')
    expect(view.getByTestId('task-editor').element().textContent).toContain('second')
    await userEvent.keyboard('{ArrowUp}')
    expect(view.getByTestId('task-editor').element().textContent).toContain('first')
    await view.unmount()
  })

  it('completes the selection with ⌘↵', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'second',
        text: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select all
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    await waitFor(() => expect(writesOf('toggle')).toHaveLength(2))
    // Completing keeps both showing struck (the middle state), not dropped.
    await waitFor(() => expect(view.getAllByRole('button', { name: /^Reopen:/ })).toHaveLength(2))
    await expect.element(view.getByText('first')).toBeInTheDocument()
    await view.unmount()
  })

  it('deletes a multi-selection with ⌘⌫', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'second',
        text: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    // ⌘⌫ deletes only outside the inline editor (a multi-selection mounts none);
    // while editing a sole task it's a text edit, so it can't race the commit.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    fireEvent.click(view.getByRole('button', { name: 'second' }), MOD_KEY)
    await userEvent.keyboard('{ControlOrMeta>}{Backspace}{/ControlOrMeta}')
    await waitFor(() => expect(writesOf('remove')).toHaveLength(2))
    await waitFor(() => expect(view.queryByText('first')).toBeNull())
    await view.unmount()
  })

  it('a note group’s "+ Add" button opens the editor of a new row and writes nothing', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/proj.md',
        astPath: [2],
        markdown: 'a',
        text: 'a',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('a')
    await userEvent.click(await view.findByRole('button', { name: 'Add a task to Project' }))
    await view.findByTestId('task-editor')
    expect(insertTask).not.toHaveBeenCalled()

    // Typed text is written once, into that note, when the row is left.
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'a' }))
    await waitFor(() => {
      expect(insertTask).toHaveBeenCalledWith('notes/proj.md', {
        markdown: 'edited content',
        checked: false,
      })
    })
    await expect.element(view.getByRole('button', { name: 'edited content' })).toBeInTheDocument()
    expect(insertTask).toHaveBeenCalledTimes(1)
    expect(writeTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('keeps the editor of a new row under StrictMode and writes nothing', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/proj.md', astPath: [2], markdown: 'a', noteTitle: 'Project' }),
    ])
    const view = await renderInApp(
      <StrictMode>
        <TasksScreen />
      </StrictMode>,
      { core, graph: { root: '/g', name: 'g', generation: 1 } },
    )

    await userEvent.click(view.getByRole('button', { name: 'Add a task to Project' }))
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await sleep(0)

    expect(view.getByTestId('task-editor').query()).not.toBeNull()
    expect(insertTask).not.toHaveBeenCalled()
    expect(writeTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('writes a new row completed when its checkbox is clicked', async () => {
    getOpenTasks.mockResolvedValue([])
    const view = await renderScreen()

    await view.findByText('No tasks to show.')
    await userEvent.keyboard('{Enter}')
    await userEvent.click(await view.findByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'Complete: Empty task' }))

    await waitFor(() => {
      expect(insertTask).toHaveBeenCalledWith('daily/2026-06-14.md', {
        markdown: 'edited content',
        checked: true,
      })
    })
    await view.findByRole('button', { name: 'Reopen: edited content' })
    expect(writeTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('Overdue tasks show no "+ Add" button (V1 can’t add to an aggregate bucket)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [2],
        markdown: 'late [[2026-06-01]]',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await view.findByText(/late/)
    expect(view.queryByRole('button', { name: /Add a task/ })).toBeNull()
    await view.unmount()
  })

  it('Return shows a new row for today’s daily and opens its inline editor', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Enter}')
    // Nothing was selected, so the new row belongs to today's daily note.
    await view.findByTestId('task-editor')
    await expect.element(view.getByRole('heading', { name: 'Current' })).toBeInTheDocument()
    expect(insertTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('Return shows the new row while the Current filter is off', async () => {
    storage.session.set('reflect.tasks.filter.current', 'false')
    getOpenTasks.mockResolvedValue([])
    const view = await renderScreen()

    await view.findByText('No tasks to show.')
    await userEvent.keyboard('{Enter}')

    await view.findByTestId('task-editor')
    await expect.element(view.getByRole('heading', { name: 'Current' })).toBeInTheDocument()
    await view.unmount()
  })

  it('Enter in the editor of a row found by search clears the search', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', astPath: [2], markdown: 'first', text: 'first' }),
      task({ notePath: 'notes/a.md', astPath: [3], markdown: 'second', text: 'second' }),
    ])
    const view = await renderScreen()

    await userEvent.fill(view.getByRole('textbox', { name: 'Search tasks' }), 'first')
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))

    await view.findByText('editing:')
    await expect.element(view.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('')
    await expect.element(view.getByRole('button', { name: 'second' })).toBeInTheDocument()
    await view.unmount()
  })

  it.each(['cancel-edit', 'delete-edit', 'delete-empty-edit', 'complete-edit'])(
    'drops a new row left empty with %s and writes nothing',
    async (exit) => {
      getOpenTasks.mockResolvedValue([])
      const view = await renderScreen()

      await view.findByText('No tasks to show.')
      await userEvent.keyboard('{Enter}')
      await userEvent.click(await view.findByText(exit))

      await view.findByText('No tasks to show.')
      expect(insertTask).not.toHaveBeenCalled()
      expect(writeTask).not.toHaveBeenCalled()
      await view.unmount()
    },
  )

  it('drops a new row left empty when the selection moves', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', astPath: [2], markdown: 'first', noteTitle: 'A' }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Add a task to A' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'first' }))

    await waitFor(() => expect(view.container.querySelectorAll('[data-task-key]')).toHaveLength(1))
    expect(insertTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('Backspace deletes a row and lands the editor on the previous one (V1)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'second',
        text: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    // Select the second row (its editor opens), then ⌫-delete it.
    await userEvent.click(await view.findByRole('button', { name: 'second' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'delete-empty-edit' }))

    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/b.md' }), [
        { kind: 'remove' },
      ])
    })
    // Lands on the previous row, whose editor now opens.
    await view.findByText('editing: first')
    await view.unmount()
  })

  it('plain ⌫ leaves a multi-selection untouched (ambiguous, V1)', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', astPath: [2], markdown: '', text: '', noteTitle: 'A' }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'keep',
        text: 'keep',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('keep')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both
    await act(() => {
      fireEvent.keyDown(view.getByLabelText('Tasks', { exact: true }), { key: 'Backspace' })
    })
    // V1 refuses a multi-row ⌫ (which row would survive is unclear).
    expect(writesOf('remove')).toHaveLength(0)
    await view.unmount()
  })

  it('Enter in the editor saves the row and opens the next task (continuous entry)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))

    // The row's text is saved, and the next row opens with nothing written for it.
    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/a.md', astPath: [2] }),
        [{ kind: 'setMarkdown', markdown: 'edited content' }],
      )
    })
    await view.findByText('editing:')
    await expect.element(view.getByRole('button', { name: 'edited content' })).toBeInTheDocument()
    expect(insertTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('writes each of three rows entered with Enter once, and never an empty one', async () => {
    getOpenTasks.mockResolvedValue([])
    const view = await renderScreen()

    await view.findByText('No tasks to show.')
    await userEvent.keyboard('{Enter}')
    for (let entered = 1; entered <= 3; entered += 1) {
      await userEvent.click(await view.findByText('type-edit'))
      await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))
      await waitFor(() => expect(insertTask).toHaveBeenCalledTimes(entered))
    }
    await userEvent.click(view.getByText('cancel-edit'))

    await waitFor(() => expect(view.container.querySelectorAll('[data-task-key]')).toHaveLength(3))
    expect(insertTask.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [
        'daily/2026-06-14.md',
        { markdown: 'edited content', checked: false },
      ]),
    )
    expect(writeTask).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('Enter in a grouped task keeps the new row in that breadcrumb context', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'A',
        breadcrumbs: ['StartupToolbox', 'Reflections'],
      }),
      task({
        notePath: 'notes/a.md',
        astPath: [40],
        markdown: 'later',
        text: 'later',
        noteTitle: 'A',
        breadcrumbs: ['StartupToolbox', 'Later'],
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))

    await view.findByText('editing:')
    await expect.element(view.getByText('later')).toBeInTheDocument()
    // The new row sits under the breadcrumb of the row it continues.
    expect(view.getAllByRole('button', { name: 'StartupToolbox → Reflections' })).toHaveLength(1)
    const editor = view.getByTestId('task-editor').element()
    const nextContext = view.getByRole('button', { name: 'StartupToolbox → Later' }).element()
    expect(editor.compareDocumentPosition(nextContext)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    await view.unmount()
  })

  it('keeps the row and the text of a new task whose write fails', async () => {
    insertTask.mockRejectedValue(new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', astPath: [2], markdown: 'first', noteTitle: 'A' }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Add a task to A' }))
    await userEvent.click(await view.findByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'first' }))

    await waitFor(() => {
      expect(operations.snapshot()).toContainEqual(
        expect.objectContaining({ status: 'failed', message: 'The task could not be saved.' }),
      )
    })
    await expect.element(view.getByRole('button', { name: 'edited content' })).toBeInTheDocument()
    await view.unmount()
  })

  it('Enter continues a scheduled grouped task despite its aggregate date bucket', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'scheduled',
        text: 'scheduled',
        noteTitle: 'A',
        breadcrumbs: ['Project'],
        dueDate: '2026-07-01',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'scheduled' }))
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))
    await userEvent.click(await view.findByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'scheduled' }))

    await waitFor(() => {
      expect(insertTask).toHaveBeenCalledWith('notes/a.md', {
        markdown: 'edited content',
        checked: false,
      })
    })
    await view.unmount()
  })

  it('Enter on a cleared row deletes it instead of leaving a bare task (no ghost)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('clear-edit'))
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))

    await waitFor(() => expect(writesOf('remove')).toHaveLength(1))
    expect(writesOf('setMarkdown')).toHaveLength(0)
    await view.findByText('editing:')
    await view.unmount()
  })

  it('↑/↓ in the editor move the selection between rows (V1)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'second',
        text: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByText('editing: first')
    await userEvent.click(view.getByRole('button', { name: 'nav-down' }))
    // The editor follows the selection to the next row.
    await view.findByText('editing: second')
    await view.unmount()
  })

  it('does not reopen an already-completed task when ⌘↵ hits the selection', async () => {
    storage.session.set('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'open',
        text: 'open',
        noteTitle: 'A',
      }),
    ])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'done',
        text: 'done',
        checked: true,
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'open' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // selects the open and the completed row
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    // Only the open row toggles; the completed one is left untouched.
    await waitFor(() => expect(writesOf('toggle')).toHaveLength(1))
    expect(writeTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), [
      { kind: 'toggle' },
    ])
    await view.unmount()
  })

  it('scheduling the selection writes a due-date link to each task (V1)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'plan',
        text: 'plan',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'ship',
        text: 'ship',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor)
    await userEvent.click(view.getByRole('button', { name: /Schedule 2/ }))
    // Pick June 20 in the calendar (today mock = 2026-06-14, so it opens on June).
    await userEvent.click(await view.findByText('20'))

    await waitFor(() => expect(writesOf('setMarkdown')).toHaveLength(2))
    expect(writeTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), [
      { kind: 'setMarkdown', markdown: 'plan [[2026-06-20]]' },
    ])
    await view.unmount()
  })

  it('converts a multi-selection to bullets via the toolbar button (no editor, bulk)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'plan',
        text: 'plan',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'ship',
        text: 'ship',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor mounts)
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet 2/ }))

    await waitFor(() => expect(writesOf('toBullet')).toHaveLength(2))
    expect(writeTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), [
      { kind: 'toBullet' },
    ])
    expect(writeTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/b.md' }), [
      { kind: 'toBullet' },
    ])
    // The converted rows are no longer checkboxes, so they leave the view.
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    expect(view.queryByText('ship')).toBeNull()
    await view.unmount()
  })

  it('converts a multi-selection to bullets with ⌘⇧K', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'plan',
        text: 'plan',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'ship',
        text: 'ship',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor mounts)
    await userEvent.keyboard('{ControlOrMeta>}{Shift>}k{/Shift}{/ControlOrMeta}')
    await waitFor(() => expect(writesOf('toBullet')).toHaveLength(2))
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    await view.unmount()
  })

  it('converts a sole-edited row from the toolbar, with its typed text, in one write', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'plan',
        text: 'plan',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'plan' })) // sole → editor mounts
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet 1/ }))

    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/a.md', astPath: [2] }),
        [{ kind: 'setMarkdown', markdown: 'edited content' }, { kind: 'toBullet' }],
      )
    })
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    expect(writeTask).toHaveBeenCalledTimes(1)
    await view.unmount()
  })

  it('converts an edited row from the editor’s own ⌘⇧K (save then convert)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'plan',
        text: 'plan',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'plan' }))
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'convert-edit' }))
    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(expect.anything(), [
        { kind: 'setMarkdown', markdown: 'edited content' },
        { kind: 'toBullet' },
      ])
    })
    expect(writesOf('setMarkdown')).toHaveLength(0)
    expect(writesOf('toBullet')).toHaveLength(0)
    await view.unmount()
  })

  it('⌘↵ reopens a selection that is already all checked (toggle both ways, V1)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'one',
        text: 'one',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'two',
        text: 'two',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByText('one')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor)
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}') // complete both
    await waitFor(() => expect(writesOf('toggle')).toHaveLength(2))

    // The struck rows stay selected; ⌘↵ again reopens them (two more toggles).
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    await waitFor(() => expect(writesOf('toggle')).toHaveLength(4))
    await view.unmount()
  })

  it('ignores task shortcuts coming from a portaled overlay (the filters menu)', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', astPath: [2], text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', astPath: [2], text: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()
    await view.findByRole('button', { name: 'first' })

    // The filters menu portals a role="menu" outside the list and owns its own
    // arrow navigation — a keydown from there must not drive the task selection.
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.appendChild(item)
    document.body.appendChild(menu)
    fireEvent.keyDown(item, { key: 'ArrowDown' })

    expect(view.queryByTestId('task-editor')).toBeNull()
    expect(view.getByRole('button', { name: 'first' }).element().getAttribute('aria-pressed')).toBe(
      'false',
    )
    menu.remove()
    await view.unmount()
  })

  it('completes a task when its checkbox is clicked', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          markdown: 'project task',
        }),
        [{ kind: 'toggle' }],
      )
    })
    // V1's middle state: the row stays visible, struck, until archived.
    await view.findByRole('button', { name: 'Reopen: project task' })
    await expect.element(view.getByText('project task')).toBeInTheDocument()
    await view.unmount()
  })

  it('yields the struck row to the index when the task is reopened at its source note', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
        updatedAt: 100,
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })

    // The checkbox is flipped back to [ ] in the note itself; the reindex
    // reports the task open again with the note's newer updatedAt. The session's
    // struck copy must yield — keeping it would shadow the live row and its
    // Reopen would fail (the [x] line is no longer in the note).
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
        updatedAt: 200,
      }),
    ])
    core.ipc.emit('index:committed', { seq: 1, paths: null })

    await view.findByRole('button', { name: 'Complete: project task' })
    expect(view.queryByRole('button', { name: 'Reopen: project task' })).toBeNull()
    await view.unmount()
  })

  it('completes a selected task when its checkbox is clicked', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          markdown: 'project task',
        }),
        [{ kind: 'toggle' }],
      )
    })
    await view.unmount()
  })

  it('completes every selected open task when a selected checkbox is clicked', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [5],
        markdown: 'first task',
        text: 'first task',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [9],
        markdown: 'second task',
        text: 'second task',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first task' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.click(view.getByRole('button', { name: 'Complete: first task' }))

    await waitFor(() => expect(writesOf('toggle')).toHaveLength(2))
    expect(writeTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ notePath: 'notes/a.md', astPath: [5], markdown: 'first task' }),
      [{ kind: 'toggle' }],
    )
    expect(writeTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ notePath: 'notes/b.md', astPath: [9], markdown: 'second task' }),
      [{ kind: 'toggle' }],
    )
    await view.findByRole('button', { name: 'Reopen: first task' })
    await view.findByRole('button', { name: 'Reopen: second task' })
    await view.unmount()
  })

  it('reopens selected checked tasks when a checked selected checkbox is clicked', async () => {
    storage.session.set('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [5],
        markdown: 'open task',
        text: 'open task',
        noteTitle: 'A',
      }),
    ])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/b.md',
        astPath: [9],
        markdown: 'done task',
        text: 'done task',
        checked: true,
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'open task' })
    await view.findByRole('button', { name: 'done task' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.click(view.getByRole('button', { name: 'Reopen: done task' }))

    await waitFor(() => expect(writesOf('toggle')).toHaveLength(1))
    expect(writeTask).toHaveBeenCalledWith(
      expect.objectContaining({ notePath: 'notes/b.md', astPath: [9], markdown: 'done task' }),
      [{ kind: 'toggle' }],
    )
    await view.findByRole('button', { name: 'Complete: open task' })
    await view.findByRole('button', { name: 'Complete: done task' })
    await view.unmount()
  })

  it('saves an edited selected task before completing it from the checkbox', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          markdown: 'project task',
        }),
        [{ kind: 'setMarkdown', markdown: 'edited content' }, { kind: 'toggle' }],
      )
    })
    await view.unmount()
  })

  it('takes a second checkbox click while the write of the first is pending', async () => {
    const pending = Promise.withResolvers<void>()
    writeTask.mockReturnValueOnce(pending.promise)
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))
    await view.findByRole('button', { name: 'Complete: project task' })
    expect(writesOf('toggle')).toHaveLength(1)

    pending.resolve()
    await waitFor(() => expect(writesOf('toggle')).toHaveLength(2))
    await view.findByRole('button', { name: 'Complete: project task' })
    await view.unmount()
  })

  it('reopens a completed task when its checkbox is clicked', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => {
      expect(writeTask).toHaveBeenLastCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          markdown: 'project task',
        }),
        [{ kind: 'toggle' }],
      )
    })
    await view.findByRole('button', { name: 'Complete: project task' })
    await view.unmount()
  })

  it('reopens an archived completed task when its checkbox is clicked', async () => {
    storage.session.set('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          markdown: 'project task',
        }),
        [{ kind: 'toggle' }],
      )
    })
    await view.findByRole('button', { name: 'Complete: project task' })
    await view.unmount()
  })

  it('shows an open checkbox while a reopen write is pending', async () => {
    storage.session.set('reflect.tasks.filter.archived', 'true')
    const pending = Promise.withResolvers<void>()
    writeTask.mockReturnValueOnce(pending.promise)
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))
    const complete = await view.findByRole('button', { name: 'Complete: project task' })
    expect(complete.querySelector('.lucide-circle-check')).toBeNull()
    expect(complete.querySelector('.lucide-circle')).not.toBeNull()

    pending.resolve()
    await waitFor(() => expect(writesOf('toggle')).toHaveLength(1))
    await view.unmount()
  })

  it('restores a struck task when an unchanged editor checkbox reopen fails', async () => {
    writeTask.mockResolvedValueOnce().mockRejectedValueOnce(new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    getOpenTasks.mockResolvedValue([])

    await userEvent.click(view.getByRole('button', { name: 'project task' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => {
      expect(operations.snapshot()).toContainEqual(
        expect.objectContaining({
          label: 'Saving task',
          status: 'failed',
          message: 'The task could not be saved.',
        }),
      )
    })
    await view.findByRole('button', { name: 'Reopen: project task' })
    await view.unmount()
  })

  it('reopens a selected completed task when its checkbox is clicked', async () => {
    storage.session.set('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          markdown: 'project task',
        }),
        [{ kind: 'toggle' }],
      )
    })
    await view.unmount()
  })

  it('saves an edited selected completed task before reopening it from the checkbox', async () => {
    storage.session.set('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => {
      expect(writeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          notePath: 'notes/p.md',
          astPath: [5],
          markdown: 'project task',
        }),
        [{ kind: 'setMarkdown', markdown: 'edited content' }, { kind: 'toggle' }],
      )
    })
    await view.unmount()
  })

  it('keeps the row struck, with its typed text, when an edit-and-reopen write fails', async () => {
    failWrites(['setMarkdown', 'toggle'], new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    getOpenTasks.mockResolvedValue([])

    await userEvent.click(view.getByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByText('type-edit'))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => {
      expect(operations.snapshot()).toContainEqual(
        expect.objectContaining({
          label: 'Saving task',
          status: 'failed',
          message: 'The task could not be saved.',
        }),
      )
    })
    await view.findByRole('button', { name: 'Reopen: edited content' })
    await view.unmount()
  })

  it('keeps a completed task visible (struck) when archived tasks are shown', async () => {
    // With "show archived" on, completing must move the row into the completed
    // list (struck), not drop it until the refetch (Bugbot regression).
    storage.session.set('reflect.tasks.filter.archived', 'true')
    getCompletedTasks.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    // Flipped to completed in place — still on screen, now marked done.
    await view.findByRole('button', { name: 'Reopen: project task' })
    await expect.element(view.getByText('project task')).toBeInTheDocument()
    await view.unmount()
  })

  it('shows the Archive button after completing, and Archive hides the row', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    // The row lingers struck and an Archive 1 action appears.
    const archive = await view.findByRole('button', { name: /Archive 1/ })
    await expect.element(view.getByText('project task')).toBeInTheDocument()

    await userEvent.click(archive)
    // Archiving hides this session's completed rows (still `[x]` on disk).
    await waitFor(() => expect(view.queryByText('project task')).toBeNull())
    expect(view.queryByRole('button', { name: /Archive/ })).toBeNull()
    await view.unmount()
  })

  it('archives the session’s completed tasks with ⌘⇧↵', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        astPath: [5],
        markdown: 'project task',
        text: 'project task',
        noteTitle: 'P',
      }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await userEvent.keyboard('{ControlOrMeta>}{Shift>}{Enter}{/Shift}{/ControlOrMeta}')
    await waitFor(() => expect(view.queryByText('project task')).toBeNull())
    await view.unmount()
  })

  it('a failed delete restores a struck task instead of dropping it (V1 middle state)', async () => {
    failWrites(['remove'], new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'one',
        text: 'one',
        noteTitle: 'A',
      }),
    ])
    const view = await renderScreen()

    // Complete it → struck (kept showing via the session set), then try to delete.
    await userEvent.click(await view.findByRole('button', { name: 'Complete: one' }))
    await view.findByRole('button', { name: 'Reopen: one' })
    await userEvent.click(view.getByRole('button', { name: 'one' })) // select the struck row → editor opens
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'delete-edit' }))

    await waitFor(() => expect(writesOf('remove')).not.toHaveLength(0))
    // The write failed, so the struck row is restored, not lost.
    await view.findByRole('button', { name: 'Reopen: one' })
    await view.unmount()
  })

  it('rolls the row back and surfaces a failed completion via the operations toast', async () => {
    failWrites(['toggle'], new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', text: 'project task', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await waitFor(() => {
      expect(operations.snapshot()).toContainEqual(
        expect.objectContaining({
          label: 'Saving task',
          status: 'failed',
          message: 'The task could not be saved.',
        }),
      )
    })
    // Rolled back: the row returns after the failed write.
    await view.findByText('project task')
    await view.unmount()
  })

  it('shows the rows as open again when a bulk complete fails', async () => {
    failWrites(['toggle'], new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        astPath: [2],
        markdown: 'first',
        text: 'first',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        astPath: [2],
        markdown: 'second',
        text: 'second',
        noteTitle: 'B',
      }),
    ])
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    await waitFor(() => {
      expect(operations.snapshot()).toContainEqual(
        expect.objectContaining({ status: 'failed', message: 'The task could not be saved.' }),
      )
    })
    await waitFor(() => {
      expect(view.container.querySelector('[aria-label="Complete: first"]')).not.toBeNull()
      expect(view.container.querySelector('[aria-label="Complete: second"]')).not.toBeNull()
    })
    expect(getOpenTasks).toHaveBeenCalledTimes(1)
    await view.unmount()
  })
})
