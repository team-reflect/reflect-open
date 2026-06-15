import { render, waitFor } from '@testing-library/react'
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
vi.mock('@/lib/note-task', () => ({ toggleTask }))

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

  it('surfaces a failed query as an alert', async () => {
    getOpenTasks.mockRejectedValue(new Error('index unavailable'))
    const view = renderScreen()
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load tasks.')
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

  it('opens a task’s source note on row click', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/p.md', dailyDate: null, text: 'project task', noteTitle: 'Project' }),
    ])
    const view = renderScreen()

    await userEvent.click(await view.findByText('project task'))
    expect(view.getByTestId('route').textContent).toContain('notes/p.md')
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

  it('moves focus between task checkboxes with the arrow keys', async () => {
    getOpenTasks.mockResolvedValue([
      task({ notePath: 'notes/a.md', markerOffset: 2, text: 'first', noteTitle: 'A' }),
      task({ notePath: 'notes/b.md', markerOffset: 2, text: 'second', noteTitle: 'B' }),
    ])
    const view = renderScreen()

    const first = await view.findByRole('button', { name: 'Complete: first' })
    first.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Complete: second')
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Complete: first')
    view.unmount()
  })
})
