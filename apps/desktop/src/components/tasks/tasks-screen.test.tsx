import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenTask } from '@reflect/core'
import { useEffect, useState, type MutableRefObject, type ReactNode } from 'react'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { resetRecentlyCompleted } from '@/lib/tasks/recently-completed'
import { RouterProvider, useRouter } from '@/routing/router'
import { TasksScreen } from './tasks-screen'

// jsdom doesn't implement scrollIntoView; the Tasks view scrolls the focused row.
const scrollIntoView = vi.fn()
Element.prototype.scrollIntoView = scrollIntoView

const getOpenTasks = vi.hoisted(() => vi.fn())
const getCompletedTasks = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getOpenTasks,
  getCompletedTasks,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/lib/use-today', () => ({ useToday: () => '2026-06-14' }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy' } }),
}))
vi.mock('@/editor/markdown-preview', () => ({
  MarkdownPreview: ({ content, className }: { content: string; className?: string }) => {
    const strong = /^(.*)\*\*([^*]+)\*\*(.*)$/u.exec(content)
    const before = strong?.[1] ?? ''
    const label = strong?.[2] ?? ''
    const after = strong?.[3] ?? ''
    return (
      <span data-testid="markdown-preview" className={className}>
        {strong === null ? (
          content
        ) : (
          <>
            {before}
            <strong>{label}</strong>
            {after}
          </>
        )}
      </span>
    )
  },
}))

const toggleTask = vi.hoisted(() => vi.fn())
const deleteTask = vi.hoisted(() => vi.fn())
const editTask = vi.hoisted(() => vi.fn())
const insertTask = vi.hoisted(() => vi.fn())
const convertTaskToBullet = vi.hoisted(() => vi.fn())
vi.mock('@/lib/note-task', () => ({
  toggleTask,
  deleteTask,
  editTask,
  insertTask,
  convertTaskToBullet,
}))

// The real inline editor mounts ProseKit, which jsdom can't render (no
// getClientRects/getAnimations). Stub it with the callback surface the row
// wires up, so selection + edit/delete/cancel routing is testable here; the
// editor's own commit/cancel decision is unit-tested via resolveTaskEdit.
vi.mock('./task-editor', () => ({
  TaskEditor: ({
    task,
    onCommit,
    onContinue,
    onDelete,
    onDeleteEmpty,
    onCancel,
    onComplete,
    onCheckboxToggle,
    onConvertToBullet,
    onFlush,
    onNavigate,
    checkboxToggleControllerRef,
    convertControllerRef,
  }: {
    task: { text: string }
    onCommit: (content: string) => void
    onContinue: (content: string | null) => void
    onDelete: () => void
    onDeleteEmpty: () => void
    onCancel: () => void
    onComplete: (content: string | null) => void
    onCheckboxToggle: (content: string | null) => void
    onConvertToBullet: (content: string | null) => void
    onFlush: (content: string) => void
    onNavigate: (direction: -1 | 1, options: { span: boolean }) => void
    checkboxToggleControllerRef?: MutableRefObject<(() => void) | null>
    convertControllerRef?: MutableRefObject<(() => void) | null>
  }) => {
    const [checkboxDraft, setCheckboxDraft] = useState<string | null>(null)
    useEffect(() => {
      if (checkboxToggleControllerRef === undefined) {
        return
      }
      checkboxToggleControllerRef.current = () => onCheckboxToggle(checkboxDraft)
      return () => {
        checkboxToggleControllerRef.current = null
      }
    }, [checkboxDraft, checkboxToggleControllerRef, onCheckboxToggle])
    // Mirror the real editor: expose a flush-then-convert trigger (simulating a
    // changed draft) so the toolbar button routes the sole row through it.
    useEffect(() => {
      if (convertControllerRef === undefined) {
        return
      }
      convertControllerRef.current = () => onConvertToBullet('edited content')
      return () => {
        convertControllerRef.current = null
      }
    })
    return (
    <div data-task-editor data-testid="task-editor">
      <span>editing: {task.text}</span>
      <button type="button" onClick={() => onCommit('edited content')}>
        commit-edit
      </button>
      <button type="button" onClick={() => onContinue('edited content')}>
        continue-edit
      </button>
      <button type="button" onClick={() => onContinue(null)}>
        continue-unchanged
      </button>
      <button type="button" onClick={() => onContinue('')}>
        continue-empty
      </button>
      <button type="button" onClick={() => onDelete()}>
        delete-edit
      </button>
      <button type="button" onClick={() => onDeleteEmpty()}>
        delete-empty-edit
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
      <button type="button" onClick={() => setCheckboxDraft('edited content')}>
        stage-checkbox-edit
      </button>
      <button type="button" onClick={() => onConvertToBullet('edited content')}>
        convert-edited
      </button>
      <button type="button" onClick={() => onConvertToBullet(null)}>
        convert-unchanged
      </button>
      <button type="button" onClick={() => onFlush('edited content')}>
        flush-edit
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

function renderScreen(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
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
  insertTask.mockReset()
  insertTask.mockResolvedValue(0)
  convertTaskToBullet.mockReset()
  convertTaskToBullet.mockResolvedValue(undefined)
  startOperation.mockClear()
  fail.mockReset()
  resetRecentlyCompleted()
  scrollIntoView.mockClear()
})

afterEach(() => {
  cleanup()
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

  it('renders unfocused task content through the markdown preview', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        raw: '[ ] ship **bold** text',
        text: 'ship bold text',
        noteTitle: 'Project',
      }),
    ])
    const view = renderScreen()

    const row = await view.findByRole('button', { name: 'ship bold text' })
    expect(row.querySelector('strong')?.textContent).toBe('bold')
    expect(row.textContent).not.toContain('**bold**')
    view.unmount()
  })

  it('selects a task when clicking the row outside the text control', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, text: 'full row', noteTitle: 'Project' }),
    ])
    const view = renderScreen()

    await view.findByRole('button', { name: 'full row' })
    const row = view.container.querySelector('[data-task-key="notes/p.md:2"]')
    expect(row).toBeInstanceOf(HTMLElement)
    await userEvent.click(row as HTMLElement)

    expect(view.getByTestId('task-editor').textContent).toContain('full row')
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

  it('scrolls the focused task row into view after selection renders', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, text: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', markerOffset: 3, text: 'second', noteTitle: 'Project' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'second' }))
    const row = view.container.querySelector('[data-task-key="notes/p.md:3"]')

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
      expect(scrollIntoView.mock.contexts).toContain(row)
    })
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

  it('editing an already-completed task with ⌘↵ saves the text, never reopens it', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    editTask.mockResolvedValue(undefined)
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 2,
        raw: '[x] done task',
        text: 'done task',
        checked: true,
        noteTitle: 'P',
      }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'done task' }))
    await userEvent.click(view.getByText('complete-edited'))
    await waitFor(() => expect(editTask).toHaveBeenCalled())
    // The marker stays `[x]` — no toggle back to open.
    expect(toggleTask).not.toHaveBeenCalled()
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
    // Completing keeps both showing struck (the middle state), not dropped.
    await waitFor(() => expect(view.getAllByRole('button', { name: /^Reopen:/ })).toHaveLength(2))
    expect(view.getByText('first')).toBeDefined()
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

  it('a note group’s "+ Add" button inserts into that note and opens the editor', async () => {
    insertTask.mockResolvedValue(0)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/proj.md', markerOffset: 2, raw: '[ ] a', text: 'a', noteTitle: 'Project' }),
    ])
    const view = renderScreen()

    await view.findByText('a')
    await userEvent.click(await view.findByRole('button', { name: 'Add a task to Project' }))
    await waitFor(() => expect(insertTask).toHaveBeenCalledWith('notes/proj.md', 1))
    // The new row's editor opens, ready to type.
    await view.findByTestId('task-editor')
    view.unmount()
  })

  it('Overdue tasks show no "+ Add" button (V1 can’t add to an aggregate bucket)', async () => {
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 2,
        raw: '[ ] late',
        text: 'late',
        noteTitle: 'P',
        dueDate: '2026-06-01',
      }),
    ])
    const view = renderScreen()

    await view.findByText('late')
    expect(view.queryByRole('button', { name: /Add a task/ })).toBeNull()
    view.unmount()
  })

  it('Return adds a task to today’s daily and opens its inline editor', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
    ])
    const view = renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Enter}')
    // Nothing was selected, so the new task lands in today's daily note.
    await waitFor(() => expect(insertTask).toHaveBeenCalledWith('daily/2026-06-14.md', 1))
    // The optimistic empty row mounts its inline editor, ready to type into.
    await view.findByTestId('task-editor')
    view.unmount()
  })

  it('dismissing the inserted row deletes the right note line (V1 empty cleanup)', async () => {
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
    ])
    const view = renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Enter}')
    await view.findByTestId('task-editor')
    // An empty Return-to-add row, left untouched, is removed rather than left as a
    // blank `+ [ ] ` line — the real editor routes that empty exit to delete (see
    // the finalizer unit test); here we check the optimistic row's identity flows
    // through, deleting the freshly written daily-note line, not some other row.
    await userEvent.click(view.getByRole('button', { name: 'delete-edit' }))
    await waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'daily/2026-06-14.md' }),
        1,
      ),
    )
    view.unmount()
  })

  it('Backspace deletes a row and lands the editor on the previous one (V1)', async () => {
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    // Select the second row (its editor opens), then ⌫-delete it.
    await userEvent.click(await view.findByRole('button', { name: 'second' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'delete-empty-edit' }))

    await waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/b.md' }), 1),
    )
    // Lands on the previous row, whose editor now opens.
    await view.findByText('editing: first')
    view.unmount()
  })

  it('plain ⌫ leaves a multi-selection untouched (ambiguous, V1)', async () => {
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ]', text: '', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] keep', text: 'keep', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    await view.findByText('keep')
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both
    await userEvent.keyboard('{Backspace}')
    await Promise.resolve()
    // V1 refuses a multi-row ⌫ (which row would survive is unclear).
    expect(deleteTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it('Enter in the editor saves the row and opens the next task (continuous entry)', async () => {
    editTask.mockResolvedValue(undefined)
    insertTask.mockResolvedValue(7)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))

    // Persists this row's edit, then appends the next task in the same note.
    await waitFor(() => expect(editTask).toHaveBeenCalled())
    await waitFor(() => expect(insertTask).toHaveBeenCalledWith('notes/a.md', 1))
    view.unmount()
  })

  it('Enter on a cleared row deletes it instead of leaving a bare task (no ghost)', async () => {
    deleteTask.mockResolvedValue(undefined)
    insertTask.mockResolvedValue(0)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'continue-empty' }))
    // The cleared row is deleted (not edited to `+ [ ]`); editTask is never called.
    await waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), 1),
    )
    expect(editTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it('↑/↓ in the editor move the selection between rows (V1)', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByText('editing: first')
    await userEvent.click(view.getByRole('button', { name: 'nav-down' }))
    // The editor follows the selection to the next row.
    await view.findByText('editing: second')
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

  it('scheduling the selection writes a due-date link to each task (V1)', async () => {
    editTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] ship', text: 'ship', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both (no editor)
    await userEvent.click(view.getByRole('button', { name: /Schedule 2/ }))
    // Pick June 20 in the calendar (today mock = 2026-06-14, so it opens on June).
    await userEvent.click(await view.findByText('20'))

    await waitFor(() => expect(editTask).toHaveBeenCalledTimes(2))
    expect(editTask).toHaveBeenCalledWith(
      expect.objectContaining({ notePath: 'notes/a.md' }),
      'plan [[2026-06-20]]',
      1,
    )
    view.unmount()
  })

  it('converts a multi-selection to bullets via the toolbar button (no editor, bulk)', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] ship', text: 'ship', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both (no editor mounts)
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet 2/ }))

    await waitFor(() => expect(convertTaskToBullet).toHaveBeenCalledTimes(2))
    expect(convertTaskToBullet).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), 1)
    expect(convertTaskToBullet).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/b.md' }), 1)
    // The converted rows are no longer checkboxes, so they leave the view.
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    expect(view.queryByText('ship')).toBeNull()
    view.unmount()
  })

  it('converts a multi-selection to bullets with ⌘⇧K', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] ship', text: 'ship', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both (no editor mounts)
    await userEvent.keyboard('{Meta>}{Shift>}k{/Shift}{/Meta}')
    await waitFor(() => expect(convertTaskToBullet).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    view.unmount()
  })

  it('converts a sole-edited row through its editor — saving the draft before converting', async () => {
    // The toolbar button on the sole (edited) row routes through the editor so the
    // unsaved draft is saved first, then the marker is stripped — the data-loss race
    // Bugbot flagged (convert landing before the editor's commit) can't happen.
    editTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'plan' })) // sole → editor mounts
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet 1/ }))

    // Edit first (persist the draft), then convert the rewritten line.
    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/a.md', markerOffset: 2 }),
        'edited content',
        1,
      ),
    )
    await waitFor(() =>
      expect(convertTaskToBullet).toHaveBeenCalledWith(
        expect.objectContaining({ markerOffset: 2, raw: '[ ] edited content' }),
        1,
      ),
    )
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    view.unmount()
  })

  it('converts an edited row from the editor’s own ⌘⇧K (save then convert)', async () => {
    editTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'plan' }))
    await userEvent.click(view.getByRole('button', { name: 'convert-edited' }))
    await waitFor(() => expect(editTask).toHaveBeenCalledWith(expect.anything(), 'edited content', 1))
    await waitFor(() => expect(convertTaskToBullet).toHaveBeenCalled())
    view.unmount()
  })

  it('⌘↵ reopens a selection that is already all checked (toggle both ways, V1)', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] one', text: 'one', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] two', text: 'two', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    await view.findByText('one')
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both (no editor)
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}') // complete both
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))

    // The struck rows stay selected; ⌘↵ again reopens them (two more toggles).
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(4))
    view.unmount()
  })

  it('ignores task shortcuts coming from a portaled overlay (the filters menu)', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, text: 'second', noteTitle: 'B' }),
    ])
    const view = renderScreen()
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
    expect(view.getByRole('button', { name: 'first' }).getAttribute('aria-pressed')).toBe('false')
    menu.remove()
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
    // V1's middle state: the row stays visible, struck, until archived.
    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.getByText('project task')).toBeDefined()
    view.unmount()
  })

  it('yields the struck row to the index when the task is reopened at its source note', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 5,
        raw: '[ ] project task',
        text: 'project task',
        noteTitle: 'Project',
        updatedAt: 100,
      }),
    ])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = renderScreen(client)

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })

    // The checkbox is flipped back to [ ] in the note itself; the reindex
    // reports the task open again with the note's newer updatedAt. The session's
    // struck copy must yield — keeping it would shadow the live row and its
    // Reopen would fail (the [x] line is no longer in the note).
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 5,
        raw: '[ ] project task',
        text: 'project task',
        noteTitle: 'Project',
        updatedAt: 200,
      }),
    ])
    await client.invalidateQueries({ queryKey: [INDEX_QUERY_SCOPE] })

    await view.findByRole('button', { name: 'Complete: project task' })
    expect(view.queryByRole('button', { name: 'Reopen: project task' })).toBeNull()
    view.unmount()
  })

  it('keeps the struck row when a refetch races the completion’s reindex', async () => {
    toggleTask.mockResolvedValue(undefined)
    const staleRow = task({
      notePath: 'notes/p.md',
      markerOffset: 5,
      raw: '[ ] project task',
      text: 'project task',
      noteTitle: 'Project',
      updatedAt: 100,
    })
    getOpenTasks.mockResolvedValue([staleRow])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = renderScreen(client)

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })

    // An unrelated invalidation refetches before the completion's reindex lands:
    // the index still returns the pre-completion row (same updatedAt). The row
    // must stay struck rather than flicker back to open.
    await client.invalidateQueries({ queryKey: [INDEX_QUERY_SCOPE] })

    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.queryByRole('button', { name: 'Complete: project task' })).toBeNull()
    view.unmount()
  })

  it('completes a selected task when its checkbox is clicked', async () => {
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

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    expect(view.getByTestId('task-editor')).toBeDefined()
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task' }),
        1,
      ),
    )
    view.unmount()
  })

  it('completes every selected open task when a selected checkbox is clicked', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        markerOffset: 5,
        raw: '[ ] first task',
        text: 'first task',
        noteTitle: 'A',
      }),
      task({
        notePath: 'notes/b.md',
        markerOffset: 9,
        raw: '[ ] second task',
        text: 'second task',
        noteTitle: 'B',
      }),
    ])
    const view = renderScreen()

    await view.findByRole('button', { name: 'first task' })
    await userEvent.keyboard('{Meta>}a{/Meta}')
    await userEvent.click(view.getByRole('button', { name: 'Complete: first task' }))

    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))
    expect(toggleTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ notePath: 'notes/a.md', markerOffset: 5, raw: '[ ] first task' }),
      1,
    )
    expect(toggleTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ notePath: 'notes/b.md', markerOffset: 9, raw: '[ ] second task' }),
      1,
    )
    await view.findByRole('button', { name: 'Reopen: first task' })
    await view.findByRole('button', { name: 'Reopen: second task' })
    view.unmount()
  })

  it('reopens selected checked tasks when a checked selected checkbox is clicked', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({
        notePath: 'notes/a.md',
        markerOffset: 5,
        raw: '[ ] open task',
        text: 'open task',
        noteTitle: 'A',
      }),
    ])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/b.md',
        markerOffset: 9,
        raw: '[x] done task',
        text: 'done task',
        checked: true,
        noteTitle: 'B',
      }),
    ])
    const view = renderScreen()

    await view.findByRole('button', { name: 'open task' })
    await view.findByRole('button', { name: 'done task' })
    await userEvent.keyboard('{Meta>}a{/Meta}')
    await userEvent.click(view.getByRole('button', { name: 'Reopen: done task' }))

    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(
      expect.objectContaining({ notePath: 'notes/b.md', markerOffset: 9, raw: '[x] done task' }),
      1,
    )
    await view.findByRole('button', { name: 'Complete: open task' })
    await view.findByRole('button', { name: 'Complete: done task' })
    view.unmount()
  })

  it('saves an edited selected task before completing it from the checkbox', async () => {
    editTask.mockResolvedValue(undefined)
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

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-checkbox-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task' }),
        'edited content',
        1,
      ),
    )
    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] edited content' }),
        1,
      ),
    )
    view.unmount()
  })

  it('disables row checkboxes while an edit-and-toggle write is pending', async () => {
    let resolveEdit = (): void => {
      throw new Error('edit promise was not created')
    }
    editTask.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveEdit = resolve
        }),
    )
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

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-checkbox-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() => expect(editTask).toHaveBeenCalledTimes(1))
    const reopen = await view.findByRole('button', { name: 'Reopen: edited content' })
    await waitFor(() => expect((reopen as HTMLButtonElement).disabled).toBe(true))
    await userEvent.click(reopen)
    expect(toggleTask).not.toHaveBeenCalled()

    resolveEdit()
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    view.unmount()
  })

  it('reopens a completed task when its checkbox is clicked', async () => {
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
    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() =>
      expect(toggleTask).toHaveBeenLastCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] project task' }),
        1,
      ),
    )
    await view.findByRole('button', { name: 'Complete: project task' })
    view.unmount()
  })

  it('reopens an archived completed task when its checkbox is clicked', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 5,
        raw: '[x] project task',
        text: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] project task' }),
        1,
      ),
    )
    await view.findByRole('button', { name: 'Complete: project task' })
    view.unmount()
  })

  it('shows an open checkbox while a reopen write is pending', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    let resolveToggle = (): void => {
      throw new Error('toggle promise was not created')
    }
    toggleTask.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveToggle = resolve
        }),
    )
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 5,
        raw: '[x] project task',
        text: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))
    const complete = await view.findByRole('button', { name: 'Complete: project task' })
    await waitFor(() => expect((complete as HTMLButtonElement).disabled).toBe(true))
    expect(complete.querySelector('.lucide-circle-check')).toBeNull()
    expect(complete.querySelector('.lucide-circle')).not.toBeNull()

    resolveToggle()
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    view.unmount()
  })

  it('restores a struck task when an unchanged editor checkbox reopen fails', async () => {
    toggleTask.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('stale index'))
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
    await view.findByRole('button', { name: 'Reopen: project task' })
    getOpenTasks.mockResolvedValue([])

    await userEvent.click(view.getByText('project task'))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(fail).toHaveBeenCalledWith('stale index'))
    expect(startOperation).toHaveBeenCalledWith('Reopening task')
    await view.findByRole('button', { name: 'Reopen: project task' })
    view.unmount()
  })

  it('reopens a selected completed task when its checkbox is clicked', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 5,
        raw: '[x] project task',
        text: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    expect(view.getByTestId('task-editor')).toBeDefined()
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] project task' }),
        1,
      ),
    )
    view.unmount()
  })

  it('saves an edited selected completed task before reopening it from the checkbox', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    editTask.mockResolvedValue(undefined)
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockResolvedValue([
      task({
        notePath: 'notes/p.md',
        markerOffset: 5,
        raw: '[x] project task',
        text: 'project task',
        checked: true,
        noteTitle: 'Project',
      }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-checkbox-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] project task' }),
        'edited content',
        1,
      ),
    )
    await waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] edited content' }),
        1,
      ),
    )
    view.unmount()
  })

  it('restores persisted text when an edited struck task fails before reopening', async () => {
    toggleTask.mockResolvedValue(undefined)
    editTask.mockRejectedValue(new Error('disk full'))
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
    await view.findByRole('button', { name: 'Reopen: project task' })
    getOpenTasks.mockResolvedValue([])

    await userEvent.click(view.getByText('project task'))
    await userEvent.click(view.getByRole('button', { name: 'stage-checkbox-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(fail).toHaveBeenCalledWith('disk full'))
    expect(startOperation).toHaveBeenCalledWith('Reopening task')
    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.queryByText('edited content')).toBeNull()
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
    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.getByText('project task')).toBeDefined()
    view.unmount()
  })

  it('shows the Archive button after completing, and Archive hides the row', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task', text: 'project task', noteTitle: 'P' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    // The row lingers struck and an Archive 1 action appears.
    const archive = await view.findByRole('button', { name: /Archive 1/ })
    expect(view.getByText('project task')).toBeDefined()

    await userEvent.click(archive)
    // Archiving hides this session's completed rows (still `[x]` on disk).
    await waitFor(() => expect(view.queryByText('project task')).toBeNull())
    expect(view.queryByRole('button', { name: /Archive/ })).toBeNull()
    view.unmount()
  })

  it('archives the session’s completed tasks with ⌘⇧↵', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task', text: 'project task', noteTitle: 'P' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await userEvent.keyboard('{Meta>}{Shift>}{Enter}{/Shift}{/Meta}')
    await waitFor(() => expect(view.queryByText('project task')).toBeNull())
    view.unmount()
  })

  it('a failed delete restores a struck task instead of dropping it (V1 middle state)', async () => {
    toggleTask.mockResolvedValue(undefined)
    deleteTask.mockRejectedValue(new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] one', text: 'one', noteTitle: 'A' }),
    ])
    const view = renderScreen()

    // Complete it → struck (kept showing via the session set), then try to delete.
    await userEvent.click(await view.findByRole('button', { name: 'Complete: one' }))
    await view.findByRole('button', { name: 'Reopen: one' })
    await userEvent.click(view.getByText('one')) // select the struck row → editor opens
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'delete-edit' }))

    await waitFor(() => expect(deleteTask).toHaveBeenCalled())
    // The write failed, so the struck row is restored, not lost.
    await view.findByRole('button', { name: 'Reopen: one' })
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

  it('refetches (does not restore a stale snapshot) when a bulk complete fails', async () => {
    toggleTask.mockRejectedValue(new Error('stale index'))
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Meta>}a{/Meta}')
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    await waitFor(() => expect(fail).toHaveBeenCalledWith('stale index'))
    // A batch failure reconciles by refetching the index, not by restoring the
    // pre-batch snapshot (which would un-do any write that already landed).
    await waitFor(() => expect(getOpenTasks.mock.calls.length).toBeGreaterThan(1))
    view.unmount()
  })
})
