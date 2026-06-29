import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent, type Locator } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import type { OpenTask } from '@reflect/core'
import { useEffect, useState, type MutableRefObject, type ReactNode } from 'react'
import { resetRecentlyCompleted } from '@/lib/tasks/recently-completed'
import { act } from '@/test-utils/act'
import { RouterProvider, useRouter } from '@/routing/router'
import { TasksScreen } from './tasks-screen'

// Spy on scrollIntoView (the Tasks view scrolls the focused row into view).
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
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 1 } }),
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

// The real inline editor mounts ProseKit; stub it with the callback surface the
// row wires up, so selection + edit/delete/cancel routing is testable here in
// isolation; the editor's own commit/cancel decision is unit-tested via
// resolveTaskEdit.
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

// Dispatch a native click on a locator's element. Used where a click must carry
// a keyboard modifier (userEvent doesn't model it) or target a disabled control
// (Playwright would refuse to click one).
// Modifier clicks: userEvent.click can't carry meta/shift, so dispatch a native
// MouseEvent. Wrap it in act so the resulting selection re-render (a sole
// selection swaps its row for the inline editor and back) flushes before the
// next synchronous assertion reads the row.
function dispatchClick(locator: Locator, init: MouseEventInit = {}): Promise<void> {
  return act(async () => {
    locator
      .element()
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
  })
}

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

async function renderScreen() {
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
  insertTask.mockReset()
  insertTask.mockResolvedValue(0)
  convertTaskToBullet.mockReset()
  convertTaskToBullet.mockResolvedValue(undefined)
  startOperation.mockClear()
  fail.mockReset()
  resetRecentlyCompleted()
  scrollIntoView.mockClear()
})

describe('TasksScreen', () => {
  it('shows an empty state when there are no open tasks', async () => {
    getOpenTasks.mockResolvedValue([])
    const view = await renderScreen()
    await expect.element(view.getByText('No tasks to show.', { exact: true })).toBeInTheDocument()
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
    const view = await renderScreen()

    // Open resolved to []; completed still loading, so no false "empty" yet.
    await vi.waitFor(() => expect(getOpenTasks).toHaveBeenCalled())
    await expect.element(view.getByText('No tasks to show.', { exact: true })).not.toBeInTheDocument()

    // Completed resolves with a task, so it appears (was never reported empty).
    resolveCompleted([
      task({ notePath: 'notes/p.md', text: 'archived task', noteTitle: 'P', checked: true }),
    ])
    await expect.element(view.getByText('archived task', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('No tasks to show.', { exact: true })).not.toBeInTheDocument()
  })

  it('surfaces a failed query as an alert', async () => {
    getOpenTasks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderScreen()
    await expect.element(view.getByRole('alert')).toHaveTextContent('Couldn’t load tasks.')
  })

  it('surfaces a failed archived query as an alert, not a blank list', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([])
    getCompletedTasks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderScreen()
    await expect.element(view.getByRole('alert')).toHaveTextContent('Couldn’t load tasks.')
  })

  it('clears the archived error when "show archived" is turned off', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', text: 'open task', noteTitle: 'P' }),
    ])
    getCompletedTasks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderScreen()
    await expect.element(view.getByRole('alert')).toBeInTheDocument() // archived read failed, alert

    await userEvent.click(view.getByRole('button', { name: 'Task filters', exact: true }))
    await userEvent.click(view.getByText('Show archived tasks', { exact: true }))

    // The retained archived error no longer counts, so open tasks render, no alert.
    await expect.element(view.getByText('open task', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByRole('alert')).not.toBeInTheDocument()
  })

  it('groups tasks by date bucket then note, in display order', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'daily/2026-06-14.md', dailyDate: '2026-06-14', text: 'today task', noteTitle: '2026-06-14' }),
      // Overdue needs an explicit past due date (V1 asymmetry); a bare past
      // daily-note task would be Current.
      task({ notePath: 'notes/d.md', dueDate: '2026-06-10', text: 'overdue task', noteTitle: 'D' }),
      task({ notePath: 'notes/p.md', text: 'project task', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByText('today task', { exact: true })).toBeInTheDocument()
    const headers = view
      .getByRole('heading', { level: 2 })
      .all()
      .map((node) => node.element().textContent)
    expect(headers).toEqual(['Current', 'Overdue', 'Project'])
    await expect.element(view.getByText('overdue task', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('project task', { exact: true })).toBeInTheDocument()
  })

  it('opens a task’s source note via the open arrow', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', dailyDate: null, text: 'project task', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByText('project task', { exact: true })).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Open Project', exact: true }))
    await expect.element(view.getByTestId('route')).toHaveTextContent('notes/p.md')
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
    const view = await renderScreen()

    const row = view.getByRole('button', { name: 'ship bold text', exact: true })
    await expect.element(row).toBeInTheDocument()
    expect(row.element().querySelector('strong')?.textContent).toBe('bold')
    expect(row.element().textContent).not.toContain('**bold**')
  })

  it('selects a task when clicking the row outside the text control', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, text: 'full row', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByRole('button', { name: 'full row', exact: true })).toBeInTheDocument()
    const row = view.container.querySelector('[data-task-key="notes/p.md:2"]')
    expect(row).toBeInstanceOf(HTMLElement)
    await userEvent.click(row as HTMLElement)

    await expect.element(view.getByTestId('task-editor')).toHaveTextContent('full row')
  })

  it('opens the inline editor on a sole selection, and Escape exits it', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, text: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', markerOffset: 3, text: 'second', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    // A single click selects exclusively, so that row swaps to the inline editor.
    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    await expect.element(view.getByTestId('task-editor')).toHaveTextContent('first')
    expect(
      view.getByRole('button', { name: 'second', exact: true }).element().getAttribute('aria-pressed'),
    ).toBe('false')

    // Clicking another row moves the sole selection (and the editor) to it.
    await userEvent.click(view.getByRole('button', { name: 'second', exact: true }))
    await expect.element(view.getByTestId('task-editor')).toHaveTextContent('second')

    await userEvent.keyboard('{Escape}')
    await expect.element(view.getByTestId('task-editor')).not.toBeInTheDocument()
    expect(
      view.getByRole('button', { name: 'first', exact: true }).element().getAttribute('aria-pressed'),
    ).toBe('false')
  })

  it('scrolls the focused task row into view after selection renders', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, text: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', markerOffset: 3, text: 'second', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'second', exact: true }))
    const row = view.container.querySelector('[data-task-key="notes/p.md:3"]')

    await vi.waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
      expect(scrollIntoView.mock.contexts).toContain(row)
    })
  })

  it('commits, deletes, or cancels an inline edit through the editor', async () => {
    toggleTask.mockResolvedValue(undefined)
    editTask.mockResolvedValue(undefined)
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'P' }),
    ])
    const view = await renderScreen()

    // Commit, so editTask with the new content, and edit mode exits.
    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    await userEvent.click(view.getByText('commit-edit', { exact: true }))
    await vi.waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 2 }),
        'edited content',
        1,
      ),
    )
    await expect.element(view.getByTestId('task-editor')).not.toBeInTheDocument()

    // Re-select and cancel, so no further write, edit mode exits.
    await userEvent.click(view.getByRole('button', { name: 'edited content', exact: true }))
    await userEvent.click(view.getByText('cancel-edit', { exact: true }))
    await expect.element(view.getByTestId('task-editor')).not.toBeInTheDocument()

    // Re-select and delete, so deleteTask, row gone.
    await userEvent.click(view.getByRole('button', { name: 'edited content', exact: true }))
    await userEvent.click(view.getByText('delete-edit', { exact: true }))
    await vi.waitFor(() => expect(deleteTask).toHaveBeenCalled())
  })

  it('flush persists an edit without exiting edit mode (selection unchanged)', async () => {
    editTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'P' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    await userEvent.click(view.getByText('flush-edit', { exact: true }))
    await vi.waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 2 }),
        'edited content',
        1,
      ),
    )
    // The selection (and so the inline editor) is left intact; flush never clears.
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
  })

  it('completes from the editor: edit+complete sequences the two writes', async () => {
    editTask.mockResolvedValue(undefined)
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'P' }),
    ])
    const view = await renderScreen()

    // ⌘↵ with an edit, so save the content, then toggle the rewritten line.
    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    await userEvent.click(view.getByText('complete-edited', { exact: true }))
    await vi.waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 2 }),
        'edited content',
        1,
      ),
    )
    await vi.waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ markerOffset: 2, raw: '[ ] edited content' }),
        1,
      ),
    )
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'done task', exact: true }))
    await userEvent.click(view.getByText('complete-edited', { exact: true }))
    await vi.waitFor(() => expect(editTask).toHaveBeenCalled())
    // The marker stays `[x]`, no toggle back to open.
    expect(toggleTask).not.toHaveBeenCalled()
  })

  it('completes from the editor: an unchanged task just toggles, no edit', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'P' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    await userEvent.click(view.getByText('complete-unchanged', { exact: true }))
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(editTask).not.toHaveBeenCalled()
  })

  it('toggles rows with ⌘-click and selects a range with shift-click', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 2, text: 'first', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', markerOffset: 3, text: 'second', noteTitle: 'Project' }),
      task({ notePath: 'notes/p.md', markerOffset: 4, text: 'third', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()
    const pressed = (name: string) =>
      view.getByRole('button', { name, exact: true }).element().getAttribute('aria-pressed') === 'true'

    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    // ⌘-click adds the row without clearing the rest (the modifier is set
    // explicitly: userEvent's click doesn't carry it, so dispatch natively).
    await dispatchClick(view.getByRole('button', { name: 'third', exact: true }), { metaKey: true })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, false, true])

    // Shift-click from the anchor (third) back to first selects the whole range.
    await dispatchClick(view.getByRole('button', { name: 'first', exact: true }), { shiftKey: true })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, true, true])
  })

  it('selects all with ⌘A and moves a single selection with the arrow keys', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, text: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()
    const pressed = (name: string) =>
      view.getByRole('button', { name, exact: true }).element().getAttribute('aria-pressed') === 'true'

    await expect.element(view.getByRole('button', { name: 'first', exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}')
    // Two selected, so both stay buttons (the editor only opens for a sole row).
    expect([pressed('first'), pressed('second')]).toEqual([true, true])

    // ↓ collapses to a single moving selection, so that row opens the editor.
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(view.getByTestId('task-editor')).toHaveTextContent('second')
    await userEvent.keyboard('{ArrowUp}')
    await expect.element(view.getByTestId('task-editor')).toHaveTextContent('first')
  })

  it('completes the selection with ⌘↵', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByRole('button', { name: 'first', exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}') // select all
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))
    // Completing keeps both showing struck (the middle state), not dropped.
    await expect.element(view.getByRole('button', { name: /^Reopen:/ })).toHaveLength(2)
    await expect.element(view.getByText('first', { exact: true })).toBeInTheDocument()
  })

  it('deletes a multi-selection with ⌘⌫', async () => {
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    // ⌘⌫ deletes only outside the inline editor (a multi-selection mounts none);
    // while editing a sole task it's a text edit, so it can't race the commit.
    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    await dispatchClick(view.getByRole('button', { name: 'second', exact: true }), { metaKey: true })
    await userEvent.keyboard('{Meta>}{Backspace}{/Meta}')
    await vi.waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(2))
    await expect.element(view.getByText('first', { exact: true })).not.toBeInTheDocument()
  })

  it('a note group’s "+ Add" button inserts into that note and opens the editor', async () => {
    insertTask.mockResolvedValue(0)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/proj.md', markerOffset: 2, raw: '[ ] a', text: 'a', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByText('a', { exact: true })).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Add a task to Project', exact: true }))
    await vi.waitFor(() => expect(insertTask).toHaveBeenCalledWith('notes/proj.md', 1))
    // The new row's editor opens, ready to type.
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
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
    const view = await renderScreen()

    await expect.element(view.getByText('late', { exact: true })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /Add a task/ })).not.toBeInTheDocument()
  })

  it('Return adds a task to today’s daily and opens its inline editor', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByRole('button', { name: 'first', exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    // Nothing was selected, so the new task lands in today's daily note.
    await vi.waitFor(() => expect(insertTask).toHaveBeenCalledWith('daily/2026-06-14.md', 1))
    // The optimistic empty row mounts its inline editor, ready to type into.
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
  })

  it('dismissing the inserted row deletes the right note line (V1 empty cleanup)', async () => {
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByRole('button', { name: 'first', exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    // An empty Return-to-add row, left untouched, is removed rather than left as a
    // blank `+ [ ] ` line: the real editor routes that empty exit to delete (see
    // the finalizer unit test); here we check the optimistic row's identity flows
    // through, deleting the freshly written daily-note line, not some other row.
    await userEvent.click(view.getByRole('button', { name: 'delete-edit', exact: true }))
    await vi.waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'daily/2026-06-14.md' }),
        1,
      ),
    )
  })

  it('Backspace deletes a row and lands the editor on the previous one (V1)', async () => {
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    // Select the second row (its editor opens), then ⌫-delete it.
    await userEvent.click(view.getByRole('button', { name: 'second', exact: true }))
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'delete-empty-edit', exact: true }))

    await vi.waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/b.md' }), 1),
    )
    // Lands on the previous row, whose editor now opens.
    await expect.element(view.getByText('editing: first', { exact: true })).toBeInTheDocument()
  })

  it('plain ⌫ leaves a multi-selection untouched (ambiguous, V1)', async () => {
    deleteTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ]', text: '', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] keep', text: 'keep', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByText('keep', { exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both
    await userEvent.keyboard('{Backspace}')
    await Promise.resolve()
    // V1 refuses a multi-row ⌫ (which row would survive is unclear).
    expect(deleteTask).not.toHaveBeenCalled()
  })

  it('Enter in the editor saves the row and opens the next task (continuous entry)', async () => {
    editTask.mockResolvedValue(undefined)
    insertTask.mockResolvedValue(7)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'continue-edit', exact: true }))

    // Persists this row's edit, then appends the next task in the same note.
    await vi.waitFor(() => expect(editTask).toHaveBeenCalled())
    await vi.waitFor(() => expect(insertTask).toHaveBeenCalledWith('notes/a.md', 1))
  })

  it('Enter on a cleared row deletes it instead of leaving a bare task (no ghost)', async () => {
    deleteTask.mockResolvedValue(undefined)
    insertTask.mockResolvedValue(0)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'continue-empty', exact: true }))
    // The cleared row is deleted (not edited to `+ [ ]`); editTask is never called.
    await vi.waitFor(() =>
      expect(deleteTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), 1),
    )
    expect(editTask).not.toHaveBeenCalled()
  })

  it('↑/↓ in the editor move the selection between rows (V1)', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'first', exact: true }))
    await expect.element(view.getByText('editing: first', { exact: true })).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'nav-down', exact: true }))
    // The editor follows the selection to the next row.
    await expect.element(view.getByText('editing: second', { exact: true })).toBeInTheDocument()
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
    const view = await renderScreen()

    await expect.element(view.getByRole('button', { name: 'open', exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}') // selects the open and the completed row
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    // Only the open row toggles; the completed one is left untouched.
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), 1)
  })

  it('scheduling the selection writes a due-date link to each task (V1)', async () => {
    editTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] ship', text: 'ship', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByText('plan', { exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both (no editor)
    await userEvent.click(view.getByRole('button', { name: /Schedule \(2\)/ }))
    // Pick June 20 in the calendar (today mock = 2026-06-14, so it opens on June).
    await userEvent.click(view.getByText('20', { exact: true }))

    await vi.waitFor(() => expect(editTask).toHaveBeenCalledTimes(2))
    expect(editTask).toHaveBeenCalledWith(
      expect.objectContaining({ notePath: 'notes/a.md' }),
      'plan [[2026-06-20]]',
      1,
    )
  })

  it('converts a multi-selection to bullets via the toolbar button (no editor, bulk)', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] ship', text: 'ship', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByText('plan', { exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both (no editor mounts)
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet \(2\)/ }))

    await vi.waitFor(() => expect(convertTaskToBullet).toHaveBeenCalledTimes(2))
    expect(convertTaskToBullet).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/a.md' }), 1)
    expect(convertTaskToBullet).toHaveBeenCalledWith(expect.objectContaining({ notePath: 'notes/b.md' }), 1)
    // The converted rows are no longer checkboxes, so they leave the view.
    await expect.element(view.getByText('plan', { exact: true })).not.toBeInTheDocument()
    await expect.element(view.getByText('ship', { exact: true })).not.toBeInTheDocument()
  })

  it('converts a multi-selection to bullets with ⌘⇧K', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] ship', text: 'ship', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByText('plan', { exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both (no editor mounts)
    await userEvent.keyboard('{Meta>}{Shift>}k{/Shift}{/Meta}')
    await vi.waitFor(() => expect(convertTaskToBullet).toHaveBeenCalledTimes(2))
    await expect.element(view.getByText('plan', { exact: true })).not.toBeInTheDocument()
  })

  it('converts a sole-edited row through its editor, saving the draft before converting', async () => {
    // The toolbar button on the sole (edited) row routes through the editor so the
    // unsaved draft is saved first, then the marker is stripped: the data-loss race
    // Bugbot flagged (convert landing before the editor's commit) can't happen.
    editTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'plan', exact: true })) // sole, editor mounts
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet \(1\)/ }))

    // Edit first (persist the draft), then convert the rewritten line.
    await vi.waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/a.md', markerOffset: 2 }),
        'edited content',
        1,
      ),
    )
    await vi.waitFor(() =>
      expect(convertTaskToBullet).toHaveBeenCalledWith(
        expect.objectContaining({ markerOffset: 2, raw: '[ ] edited content' }),
        1,
      ),
    )
    await expect.element(view.getByText('plan', { exact: true })).not.toBeInTheDocument()
  })

  it('converts an edited row from the editor’s own ⌘⇧K (save then convert)', async () => {
    editTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] plan', text: 'plan', noteTitle: 'A' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'plan', exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'convert-edited', exact: true }))
    await vi.waitFor(() => expect(editTask).toHaveBeenCalledWith(expect.anything(), 'edited content', 1))
    await vi.waitFor(() => expect(convertTaskToBullet).toHaveBeenCalled())
  })

  it('⌘↵ reopens a selection that is already all checked (toggle both ways, V1)', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] one', text: 'one', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] two', text: 'two', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByText('one', { exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}') // select both (no editor)
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}') // complete both
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))

    // The struck rows stay selected; ⌘↵ again reopens them (two more toggles).
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(4))
  })

  it('ignores task shortcuts coming from a portaled overlay (the filters menu)', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, text: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()
    await expect.element(view.getByRole('button', { name: 'first', exact: true })).toBeInTheDocument()

    // The filters menu portals a role="menu" outside the list and owns its own
    // arrow navigation: a keydown from there must not drive the task selection.
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.appendChild(item)
    document.body.appendChild(menu)
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))

    await expect.element(view.getByTestId('task-editor')).not.toBeInTheDocument()
    expect(
      view.getByRole('button', { name: 'first', exact: true }).element().getAttribute('aria-pressed'),
    ).toBe('false')
    menu.remove()
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))
    await vi.waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task' }),
        1,
      ),
    )
    // V1's middle state: the row stays visible, struck, until archived.
    await expect.element(view.getByRole('button', { name: 'Reopen: project task', exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('project task', { exact: true })).toBeInTheDocument()
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'project task', exact: true }))
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))

    await vi.waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task' }),
        1,
      ),
    )
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
    const view = await renderScreen()

    await expect.element(view.getByRole('button', { name: 'first task', exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}')
    await userEvent.click(view.getByRole('button', { name: 'Complete: first task', exact: true }))

    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(2))
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
    await expect.element(view.getByRole('button', { name: 'Reopen: first task', exact: true })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Reopen: second task', exact: true })).toBeInTheDocument()
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
    const view = await renderScreen()

    await expect.element(view.getByRole('button', { name: 'open task', exact: true })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'done task', exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}')
    await userEvent.click(view.getByRole('button', { name: 'Reopen: done task', exact: true }))

    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).toHaveBeenCalledWith(
      expect.objectContaining({ notePath: 'notes/b.md', markerOffset: 9, raw: '[x] done task' }),
      1,
    )
    await expect.element(view.getByRole('button', { name: 'Complete: open task', exact: true })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Complete: done task', exact: true })).toBeInTheDocument()
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'project task', exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'stage-checkbox-edit', exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))

    await vi.waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task' }),
        'edited content',
        1,
      ),
    )
    await vi.waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] edited content' }),
        1,
      ),
    )
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'project task', exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'stage-checkbox-edit', exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))

    await vi.waitFor(() => expect(editTask).toHaveBeenCalledTimes(1))
    const reopen = view.getByRole('button', { name: 'Reopen: edited content', exact: true })
    await expect.element(reopen).toBeInTheDocument()
    await vi.waitFor(() => expect((reopen.element() as HTMLButtonElement).disabled).toBe(true))
    // Disabled, so the click can't reach the toggle (dispatch natively since
    // Playwright refuses to click a disabled control).
    await dispatchClick(reopen)
    expect(toggleTask).not.toHaveBeenCalled()

    resolveEdit()
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task', exact: true }))

    await vi.waitFor(() =>
      expect(toggleTask).toHaveBeenLastCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] project task' }),
        1,
      ),
    )
    await expect.element(view.getByRole('button', { name: 'Complete: project task', exact: true })).toBeInTheDocument()
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task', exact: true }))

    await vi.waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] project task' }),
        1,
      ),
    )
    await expect.element(view.getByRole('button', { name: 'Complete: project task', exact: true })).toBeInTheDocument()
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task', exact: true }))
    const complete = view.getByRole('button', { name: 'Complete: project task', exact: true })
    await expect.element(complete).toBeInTheDocument()
    await vi.waitFor(() => expect((complete.element() as HTMLButtonElement).disabled).toBe(true))
    expect(complete.element().querySelector('.lucide-circle-check')).toBeNull()
    expect(complete.element().querySelector('.lucide-circle')).not.toBeNull()

    resolveToggle()
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))
    await expect.element(view.getByRole('button', { name: 'Reopen: project task', exact: true })).toBeInTheDocument()
    getOpenTasks.mockResolvedValue([])

    await userEvent.click(view.getByText('project task', { exact: true }))
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task', exact: true }))

    await vi.waitFor(() => expect(fail).toHaveBeenCalledWith('stale index'))
    expect(startOperation).toHaveBeenCalledWith('Reopening task')
    await expect.element(view.getByRole('button', { name: 'Reopen: project task', exact: true })).toBeInTheDocument()
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'project task', exact: true }))
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task', exact: true }))

    await vi.waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] project task' }),
        1,
      ),
    )
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'project task', exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'stage-checkbox-edit', exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task', exact: true }))

    await vi.waitFor(() =>
      expect(editTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] project task' }),
        'edited content',
        1,
      ),
    )
    await vi.waitFor(() =>
      expect(toggleTask).toHaveBeenCalledWith(
        expect.objectContaining({ notePath: 'notes/p.md', markerOffset: 5, raw: '[x] edited content' }),
        1,
      ),
    )
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))
    await expect.element(view.getByRole('button', { name: 'Reopen: project task', exact: true })).toBeInTheDocument()
    getOpenTasks.mockResolvedValue([])

    await userEvent.click(view.getByText('project task', { exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'stage-checkbox-edit', exact: true }))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task', exact: true }))

    await vi.waitFor(() => expect(fail).toHaveBeenCalledWith('disk full'))
    expect(startOperation).toHaveBeenCalledWith('Reopening task')
    await expect.element(view.getByRole('button', { name: 'Reopen: project task', exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('edited content', { exact: true })).not.toBeInTheDocument()
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
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))
    // Flipped to completed in place, still on screen, now marked done.
    await expect.element(view.getByRole('button', { name: 'Reopen: project task', exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('project task', { exact: true })).toBeInTheDocument()
  })

  it('shows the Archive button after completing, and Archive hides the row', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task', text: 'project task', noteTitle: 'P' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))
    // The row lingers struck and an Archive (1) action appears.
    const archive = view.getByRole('button', { name: /Archive \(1\)/ })
    await expect.element(archive).toBeInTheDocument()
    await expect.element(view.getByText('project task', { exact: true })).toBeInTheDocument()

    await userEvent.click(archive)
    // Archiving hides this session's completed rows (still `[x]` on disk).
    await expect.element(view.getByText('project task', { exact: true })).not.toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /Archive/ })).not.toBeInTheDocument()
  })

  it('archives the session’s completed tasks with ⌘⇧↵', async () => {
    toggleTask.mockResolvedValue(undefined)
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', markerOffset: 5, raw: '[ ] project task', text: 'project task', noteTitle: 'P' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))
    await expect.element(view.getByRole('button', { name: 'Reopen: project task', exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}{Shift>}{Enter}{/Shift}{/Meta}')
    await expect.element(view.getByText('project task', { exact: true })).not.toBeInTheDocument()
  })

  it('a failed delete restores a struck task instead of dropping it (V1 middle state)', async () => {
    toggleTask.mockResolvedValue(undefined)
    deleteTask.mockRejectedValue(new Error('disk full'))
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] one', text: 'one', noteTitle: 'A' }),
    ])
    const view = await renderScreen()

    // Complete it (struck, kept showing via the session set), then try to delete.
    await userEvent.click(view.getByRole('button', { name: 'Complete: one', exact: true }))
    await expect.element(view.getByRole('button', { name: 'Reopen: one', exact: true })).toBeInTheDocument()
    await userEvent.click(view.getByText('one', { exact: true })) // select the struck row, editor opens
    await expect.element(view.getByTestId('task-editor')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'delete-edit', exact: true }))

    await vi.waitFor(() => expect(deleteTask).toHaveBeenCalled())
    // The write failed, so the struck row is restored, not lost.
    await expect.element(view.getByRole('button', { name: 'Reopen: one', exact: true })).toBeInTheDocument()
  })

  it('rolls the row back and surfaces a failed completion via the operations toast', async () => {
    toggleTask.mockRejectedValue(new Error('stale index'))
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', text: 'project task', noteTitle: 'Project' }),
    ])
    const view = await renderScreen()

    await userEvent.click(view.getByRole('button', { name: 'Complete: project task', exact: true }))
    await vi.waitFor(() => expect(fail).toHaveBeenCalledWith('stale index'))
    expect(startOperation).toHaveBeenCalledWith('Completing task')
    // Rolled back: the row returns after the failed write.
    await expect.element(view.getByText('project task', { exact: true })).toBeInTheDocument()
  })

  it('refetches (does not restore a stale snapshot) when a bulk complete fails', async () => {
    toggleTask.mockRejectedValue(new Error('stale index'))
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, raw: '[ ] first', text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, raw: '[ ] second', text: 'second', noteTitle: 'B' }),
    ])
    const view = await renderScreen()

    await expect.element(view.getByRole('button', { name: 'first', exact: true })).toBeInTheDocument()
    await userEvent.keyboard('{Meta>}a{/Meta}')
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}')
    await vi.waitFor(() => expect(fail).toHaveBeenCalledWith('stale index'))
    // A batch failure reconciles by refetching the index, not by restoring the
    // pre-batch snapshot (which would un-do any write that already landed).
    await vi.waitFor(() => expect(getOpenTasks.mock.calls.length).toBeGreaterThan(1))
  })
})
