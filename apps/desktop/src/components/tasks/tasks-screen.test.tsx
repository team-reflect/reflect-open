import { fireEvent, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenTask } from '@reflect/core'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { TasksScreen } from './tasks-screen'

const getOpenTasks = vi.hoisted(() => vi.fn())
const getCompletedTasks = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getOpenTasks,
  getCompletedTasks,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 1 } }),
}))
vi.mock('@/lib/use-today', () => ({ useToday: () => '2026-06-14' }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy' } }),
}))

const toggleTask = vi.hoisted(() => vi.fn())
const deleteTask = vi.hoisted(() => vi.fn())
const editTask = vi.hoisted(() => vi.fn())
vi.mock('@/lib/note-task', () => ({ toggleTask, deleteTask, editTask }))

// The real inline editor mounts ProseKit, which jsdom can't render (no
// getClientRects/getAnimations). Stub it with the callback surface the row
// wires up, so selection + edit/delete/cancel routing is testable here; the
// editor's own commit/cancel decision is unit-tested via resolveTaskEdit.
vi.mock('./task-editor', () => ({
  TaskEditor: ({
    task,
    onCommit,
    onDelete,
    onCancel,
    onComplete,
    onFlush,
  }: {
    task: { text: string }
    onCommit: (content: string) => void
    onDelete: () => void
    onCancel: () => void
    onComplete: (content: string | null) => void
    onFlush: (content: string) => void
  }) => (
    <div data-task-editor data-testid="task-editor">
      <span>editing: {task.text}</span>
      <button type="button" onClick={() => onCommit('edited content')}>
        commit-edit
      </button>
      <button type="button" onClick={() => onDelete()}>
        delete-edit
      </button>
      <button type="button" onClick={() => onCancel()}>
        cancel-edit
      </button>
      <button type="button" onClick={() => onComplete('edited content')}>
        complete-edited
      </button>
      <button type="button" onClick={() => onComplete(null)}>
        complete-unchanged
      </button>
      <button type="button" onClick={() => onFlush('edited content')}>
        flush-edit
      </button>
    </div>
  ),
}))

const fail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail })))
vi.mock('@/lib/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operations')>()),
  startOperation,
}))

function task(overrides: Partial<OpenTask> = {}): OpenTask {
  const text = overrides.text ?? 'do it'
  return {
    notePath: 'notes/n.md',
    markerOffset: 2,
    // The row renders `raw`; default it to the marker line for `text` so display
    // assertions match unless a case overrides `raw` explicitly.
    raw: `[ ] ${text}`,
    checked: false,
    text,
    noteTitle: 'N',
    dueDate: null,
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    updatedAt: 0,
    ...overrides,
  }
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <TasksScreen />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  getOpenTasks.mockReset()
  getCompletedTasks.mockReset()
  getCompletedTasks.mockResolvedValue([])
  toggleTask.mockReset()
  deleteTask.mockReset()
  editTask.mockReset()
  startOperation.mockClear()
  fail.mockReset()
})

describe('TasksScreen', () => {
  it('shows an empty state when there are no open tasks', async () => {
    getOpenTasks.mockResolvedValue([])
    const view = renderScreen()
    await view.findByText('No tasks to show.')
    view.unmount()
  })

  it('does not flash an empty state while archived tasks are still loading', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    let resolveCompleted: (rows: OpenTask[]) => void = () => {}
    getCompletedTasks.mockReturnValue(
      new Promise<OpenTask[]>((resolve) => {
        resolveCompleted = resolve
      }),
    )
    const view = renderScreen()

    // Open resolved to []; completed still loading → no false "empty" yet.
    await waitFor(() => expect(getOpenTasks).toHaveBeenCalled())
    expect(view.queryByText('No tasks to show.')).toBeNull()

    // Completed resolves with a task → it appears (was never reported empty).
    resolveCompleted([
      task({ notePath: 'notes/p.md', text: 'archived task', noteTitle: 'P', checked: true }),
    ])
    await view.findByText('archived task')
    expect(view.queryByText('No tasks to show.')).toBeNull()
    view.unmount()
  })

  it('surfaces a failed query as an alert', async () => {
    getOpenTasks.mockRejectedValue(new Error('index unavailable'))
    const view = renderScreen()
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load tasks.')
    view.unmount()
  })

  it('surfaces a failed archived query as an alert, not a blank list', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockRejectedValue(new Error('index unavailable'))
    const view = renderScreen()
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load tasks.')
    view.unmount()
  })

  it('clears the archived error when "show archived" is turned off', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', text: 'open task', noteTitle: 'P' }),
    ])
    getCompletedTasks.mockRejectedValue(new Error('index unavailable'))
    const view = renderScreen()
    await view.findByRole('alert') // archived read failed → alert

    await userEvent.click(view.getByRole('button', { name: 'Task filters' }))
    await userEvent.click(await view.findByText('Show archived tasks'))

    // The retained archived error no longer counts → open tasks render, no alert.
    await view.findByText('open task')
    expect(view.queryByRole('alert')).toBeNull()
    view.unmount()
  })

  it('groups tasks by date bucket then note, in display order', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'daily/2026-06-14.md', dailyDate: '2026-06-14', text: 'today task', noteTitle: '2026-06-14' }),
      // Overdue needs an explicit past due date (V1 asymmetry) — a bare past
      // daily-note task would be Current.
      task({ notePath: 'notes/d.md', dueDate: '2026-06-10', text: 'overdue task', noteTitle: 'D' }),
      task({ notePath: 'notes/p.md', text: 'project task', noteTitle: 'Project' }),
    ])
    const view = renderScreen()

    await view.findByText('today task')
    const headers = view.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)
    expect(headers).toEqual(['Current', 'Overdue', 'Project'])
    expect(view.getByText('overdue task')).toBeDefined()
    expect(view.getByText('project task')).toBeDefined()
    view.unmount()
  })

  it('opens a task’s source note via the open arrow', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', dailyDate: null, text: 'project task', noteTitle: 'Project' }),
    ])
    const view = renderScreen()

    await view.findByText('project task')
    await userEvent.click(view.getByRole('button', { name: 'Open Project' }))
    expect(view.getByTestId('route').textContent).toContain('notes/p.md')
    view.unmount()
  })

  it('opens the inline editor on a sole selection, and Escape exits it', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, text: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', markerOffset: 3, text: 'second', noteTitle: 'Project' }),
    ])
    const view = renderScreen()

    // A single click selects exclusively → that row swaps to the inline editor.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    expect(view.getByTestId('task-editor').textContent).toContain('first')
    expect(view.getByRole('button', { name: 'second' }).getAttribute('aria-pressed')).toBe('false')

    // Clicking another row moves the sole selection (and the editor) to it.
    await userEvent.click(view.getByRole('button', { name: 'second' }))
    expect(view.getByTestId('task-editor').textContent).toContain('second')

    await userEvent.keyboard('{Escape}')
    expect(view.queryByTestId('task-editor')).toBeNull()
    expect(view.getByRole('button', { name: 'first' }).getAttribute('aria-pressed')).toBe('false')
    view.unmount()
  })

  it('commits, deletes, or cancels an inline edit through the editor', async () => {
    toggleTask.mockResolvedValue(undefined)
    editTask.mockResolvedValue(undefined)
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'P' }),
    ])
    const view = renderScreen()

    // Commit → editTask with the new content, and edit mode exits.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('commit-edit'))
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 2 }),
        'edited content',
        1,
      ),
    )
    await waitFor(() => expect(view.queryByTestId('task-editor')).toBeNull())

    // Re-select and cancel → no further write, edit mode exits.
    await userEvent.click(view.getByRole('button', { name: 'edited content' }))
    await userEvent.click(view.getByText('cancel-edit'))
    expect(view.queryByTestId('task-editor')).toBeNull()

    // Re-select and delete → deleteTask, row gone.
    await userEvent.click(view.getByRole('button', { name: 'edited content' }))
    await userEvent.click(view.getByText('delete-edit'))
    await waitFor(() => expect(deleteTask).toHaveBeenCalled())
    view.unmount()
  })

  it('flush persists an edit without exiting edit mode (selection unchanged)', async () => {
    editTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'P' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('flush-edit'))
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 2 }),
        'edited content',
        1,
      ),
    )
    // The selection (and so the inline editor) is left intact — flush never clears.
    expect(view.getByTestId('task-editor')).toBeDefined()
    view.unmount()
  })

  it('completes from the editor: edit+complete sequences the two writes', async () => {
    editTask.mockResolvedValue(undefined)
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'P' }),
    ])
    const view = renderScreen()

    // ⌘↵ with an edit → save the content, then toggle the rewritten line.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('complete-edited'))
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 2 }),
        'edited content',
        1,
      ),
    )
    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ markerOffset: 2, raw: '[ ] edited content' }),
        1,
      ),
    )
    view.unmount()
  })

  it('completes from the editor: an unchanged task just toggles, no edit', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'P' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('complete-unchanged'))
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(editTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it('toggles rows with ⌘-click and selects a range with shift-click', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, text: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', markerOffset: 3, text: 'second', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', markerOffset: 4, text: 'third', noteTitle: 'Project' }),
    ])
    const view = renderScreen()
    const pressed = (name: string) =>
      view.getByRole('button', { name }).getAttribute('aria-pressed') === 'true'

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    // ⌘-click adds the row without clearing the rest (modifier set explicitly —
    // userEvent's held modifiers don't reach its synthetic click).
    fireEvent.click(view.getByRole('button', { name: 'third' }), { metaKey: true })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, false, true])

    // Shift-click from the anchor (third) back to first selects the whole range.
    fireEvent.click(view.getByRole('button', { name: 'first' }), { shiftKey: true })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, true, true])
    view.unmount()
  })

  it('selects all with ⌘A and moves a single selection with the arrow keys', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, text: 'second', noteTitle: 'B' }),
    ])
    const view = renderScreen()
    const pressed = (name: string) =>
      view.getByRole('button', { name }).getAttribute('aria-pressed') === 'true'

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Meta>}a{/Meta}')
    // Two selected → both stay buttons (the editor only opens for a sole row).
    expect([pressed('first'), pressed('second')]).toEqual([true, true])

    // ↓ collapses to a single moving selection → that row opens the editor.
    await userEvent.keyboard('{ArrowDown}')
    expect(view.getByTestId('task-editor').textContent).toContain('second')
    await userEvent.keyboard('{ArrowUp}')
    expect(view.getByTestId('task-editor').textContent).toContain('first')
    view.unmount()
  })

  it('completes the selection with ⌘↵', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Meta>}a{/Meta}') // select all
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))
    // Optimistically dropped from the open list.
    await waitFor(() => expect(view.queryByText('first')).toBeNull())
    view.unmount()
  })

  it('deletes a multi-selection with ⌘⌫', async () => {
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    // ⌘⌫ deletes only outside the inline editor (a multi-selection mounts none);
    // while editing a sole task it's a text edit, so it can't race the commit.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    fireEvent.click(view.getByRole('button', { name: 'second' }), { metaKey: true })
    await userEvent.keyboard('{Meta>}{Backspace}{/Meta}')
    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(view.queryByText('first')).toBeNull())
    view.unmount()
  })

  it('deletes only empty rows on plain ⌫, leaving content rows', async () => {
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ]', text: '', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] keep', text: 'keep', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    await view.findByText('keep')
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both
    await userEvent.keyboard('{Backspace}')
    // Only the empty row is removed; the content row is untouched.
    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(1))
    expect(deleteTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), 1)
    view.unmount()
  })

  it('does not reopen an already-completed task when ⌘↵ hits the selection', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] open', text: 'open', noteTitle: 'A' }),
    ])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/b.md',
        markerOffset: 2,
        raw: '[x] done',
        text: 'done',
        checked: true,
        noteTitle: 'B',
      }),
    ])
    const view = renderScreen()

    await view.findByRole('button', { name: 'open' })
    await userEvent.keyboard('{Meta>}a{/Meta}') // selects the open and the completed row
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    // Only the open row toggles; the completed one is left untouched.
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), 1)
    view.unmount()
  })

  it('ignores task shortcuts when focus is outside the Tasks surface', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, text: 'second', noteTitle: 'B' }),
    ])
    const view = renderScreen()
    await view.findByRole('button', { name: 'first' })

    // A portaled overlay (the filters menu, a future dialog) renders outside the
    // Tasks root. A keydown from there must not drive the task selection.
    const overlay = document.createElement('button')
    document.body.appendChild(overlay)
    overlay.focus()
    fireEvent.keyDown(overlay, { key: 'ArrowDown' })

    expect(view.queryByTestId('task-editor')).toBeNull()
    expect(view.getByRole('button', { name: 'first' }).getAttribute('aria-pressed')).toBe('false')
    overlay.remove()
    view.unmount()
  })

  it('completes a task when its checkbox is clicked', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 5,
        raw: '[ ] project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task' }),
        1,
      ),
    )
    // Optimistically removed from the list on completion.
    await waitFor(() => expect(view.queryByText('project task')).toBeNull())
    view.unmount()
  })

  it('keeps a completed task visible (struck) when archived tasks are shown', async () => {
    // With "show archived" on, completing must move the row into the completed
    // list (struck), not drop it until the refetch (Bugbot regression).
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue(undefined)
    getCompletedTasks.mockResolvedValue([])
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 5,
        raw: '[ ] project task',
        text: 'project task',
        noteTitle: 'Project',
      }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    // Flipped to completed in place — still on screen, now marked done.
    await view.findByRole('button', { name: 'Completed task' })
    expect(view.getByText('project task')).toBeDefined()
    view.unmount()
  })

  it('rolls the row back and surfaces a failed completion via the operations toast', async () => {
    toggleTask.mockRejectedValue(new Error('stale index'))
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', text: 'project task', noteTitle: 'Project' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await waitFor(() => expect(fail).toHaveBeenCalledWith('stale index'))
    expect(startOperation).toHaveBeenCalledWith('Completing task')
    // Rolled back: the row returns after the failed write.
    await view.findByText('project task')
    view.unmount()
  })
})
