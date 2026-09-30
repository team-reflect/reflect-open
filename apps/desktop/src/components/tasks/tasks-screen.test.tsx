import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { userEvent, type Locator } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { indexedTaskKey, type Task, type TaskStore } from '@reflect/core'
import { act, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { queryKeys } from '@/lib/query-client.ts'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { deferred } from '@/test-utils/deferred.ts'
import { fireEvent } from '@/test-utils/fire-event.ts'
import { MOD_KEY } from '@/test-utils/mod-key.ts'
import {
  createTaskStoreHarness,
  type NoteMeta,
  type TaskStoreHarness,
} from '@/test-utils/task-store-harness.ts'
import '@/test-utils/locator.ts'
import type { TaskCommands } from '@/lib/tasks/use-task-commands.ts'
import { TasksScreen } from './tasks-screen.tsx'

const getOpenTasks = vi.hoisted(() => vi.fn())
const getCompletedTasks = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getOpenTasks,
  getCompletedTasks,
}))
vi.mock('@/lib/windows/open-in-new-window.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window.ts')>()),
  openRouteInNewWindow,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/lib/use-today.ts', () => ({ useToday: () => '2026-06-14' }))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy' } }),
}))

// The screen talks to the real `TaskStore`, served over in-memory notes by the
// harness; only the desktop adapter (file IO, toasts) is replaced.
let harness: TaskStoreHarness
let client: QueryClient
vi.mock('@/lib/tasks/task-store.ts', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    taskStore: () => harness.store,
    useTaskStore: () => harness.store,
    useTaskStoreVersion: (store: TaskStore) =>
      useSyncExternalStore(store.subscribe, store.snapshot),
    retireTaskStores: async () => {},
  }
})

// Stub the real inline editor with the callback surface the row wires up, so
// selection + edit/delete/cancel routing is testable here. Typing is simulated
// by drafting into the task store, exactly as the real editor does, so the
// store's draft folding is exercised, not bypassed.
vi.mock('./task-editor', async () => {
  const { useTaskStore } = await import('@/lib/tasks/task-store.ts')
  return {
    TaskEditor: ({ task, commands }: { task: Task; commands: TaskCommands }) => {
      const store = useTaskStore()!
      const latest = useRef({ task, store })
      useLayoutEffect(() => {
        latest.current = { task, store }
      })
      // Like the real editor, save the draft when the row leaves edit mode.
      useEffect(
        () => () => {
          latest.current.store.commitDraft(latest.current.task)
        },
        [],
      )
      const draft = (text: string) => store.draft(task, text)
      return (
        <div data-task-editor data-testid="task-editor">
          <span>editing: {task.displayText}</span>
          <button type="button" onClick={() => draft('edited content')}>
            stage-edit
          </button>
          <button type="button" onClick={() => draft('')}>
            stage-empty
          </button>
          <button
            type="button"
            onClick={() => {
              draft('edited content')
              commands.continue(task)
            }}
          >
            continue-edit
          </button>
          <button type="button" onClick={() => commands.continue(task)}>
            continue-unchanged
          </button>
          <button
            type="button"
            onClick={() => {
              draft('')
              commands.continue(task)
            }}
          >
            continue-empty
          </button>
          <button
            type="button"
            onClick={() => {
              store.discardDraft(task)
              commands.cancel()
            }}
          >
            cancel-edit
          </button>
          <button
            type="button"
            onClick={() => {
              draft('edited content')
              commands.complete()
            }}
          >
            complete-edited
          </button>
          <button type="button" onClick={() => commands.complete()}>
            complete-unchanged
          </button>
          <button
            type="button"
            onClick={() => {
              draft('edited content')
              commands.convert()
            }}
          >
            convert-edited
          </button>
          <button type="button" onClick={() => commands.convert()}>
            convert-unchanged
          </button>
          <button type="button" onClick={() => commands.remove()}>
            delete-edit
          </button>
          <button type="button" onClick={() => commands.removeEmpty()}>
            delete-empty-edit
          </button>
          <button type="button" onClick={() => commands.navigate(1, false)}>
            nav-down
          </button>
          <button type="button" onClick={() => commands.navigate(-1, false)}>
            nav-up
          </button>
        </div>
      )
    },
  }
})

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderScreen(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  client = queryClient
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider>
        <TasksScreen />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
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
      findByTestId: (...args: Parameters<typeof view.getByTestId>) =>
        find(view.getByTestId(...args)),
      findByText: (...args: Parameters<typeof view.getByText>) => find(getByText(...args)),
      getAllByRole: (...args: Parameters<typeof view.getByRole>) => getByRole(...args).elements(),
      getAllByText: (...args: Parameters<typeof view.getByText>) => getByText(...args).elements(),
      queryByRole: (...args: Parameters<typeof view.getByRole>) => getByRole(...args).query(),
      queryByTestId: (...args: Parameters<typeof view.getByTestId>) =>
        view.getByTestId(...args).query(),
      queryByText: (...args: Parameters<typeof view.getByText>) => getByText(...args).query(),
      /** The `<li>` of the task with `key`. */
      row: (key: string): HTMLElement =>
        [...view.container.querySelectorAll<HTMLElement>('[data-task-key]')].find(
          (element) => element.getAttribute('data-task-key') === key,
        )!,
    })
  })
}

const waitFor = vi.waitFor

/** Seed a note and the metadata its index rows carry. */
function seed(path: string, source: string, meta: Partial<NoteMeta> = {}): void {
  harness.notes.set(path, source)
  const daily = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/u.exec(path)?.[1] ?? null
  harness.meta.set(path, {
    noteTitle: daily ?? path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/u, ''),
    dailyDate: daily,
    isPinned: false,
    pinnedOrder: null,
    ...meta,
  })
}

/** Hold the next write until `release`; the store keeps the local row meanwhile. */
function gateNextWrite(): { release: () => void } {
  const gate = deferred<void>()
  const write = harness.io.write
  vi.spyOn(harness.io, 'write').mockImplementationOnce(async (...args) => {
    await gate.promise
    await write(...args)
  })
  return { release: () => gate.resolve() }
}

beforeEach(() => {
  harness = createTaskStoreHarness({
    onWritten: () => client.invalidateQueries({ queryKey: queryKeys.index.all }),
  })
  window.sessionStorage.clear()
  getOpenTasks.mockReset().mockImplementation(async () => harness.indexed(false))
  getCompletedTasks.mockReset().mockImplementation(async () => harness.indexed(true))
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
})

afterEach(async () => {
  await harness.store.flush()
  await cleanup()
})

// Keep native browser navigation out of keyboard-handler tests in this suite.
describe('TasksScreen', () => {
  it('shows an empty state when there are no open tasks', async () => {
    const view = await renderScreen()
    await view.findByText('No tasks to show.')
    await view.unmount()
  })

  it('does not flash an empty state while archived tasks are still loading', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/p.md', '+ [x] archived task\n', { noteTitle: 'P' })
    const completed = deferred<Task[]>()
    getCompletedTasks.mockReturnValue(completed.promise)
    const view = await renderScreen()

    // Open resolved to []; completed still loading → no false "empty" yet.
    await waitFor(() => expect(getOpenTasks).toHaveBeenCalled())
    expect(view.queryByText('No tasks to show.')).toBeNull()

    // Completed resolves with a task → it appears (was never reported empty).
    completed.resolve(harness.indexed(true))
    await view.findByText('archived task')
    expect(view.queryByText('No tasks to show.')).toBeNull()
    await view.unmount()
  })

  it('surfaces a failed query as an alert', async () => {
    getOpenTasks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderScreen()
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load tasks.')
    await view.unmount()
  })

  it('surfaces a failed archived query as an alert, not a blank list', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getCompletedTasks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderScreen()
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Couldn’t load tasks.')
    await view.unmount()
  })

  it('clears the archived error when "show archived" is turned off', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/p.md', '+ [ ] open task\n', { noteTitle: 'P' })
    getCompletedTasks.mockRejectedValue(new Error('index unavailable'))
    const view = await renderScreen()
    await view.findByRole('alert') // archived read failed → alert

    await userEvent.click(view.getByRole('button', { name: 'Task filters' }))
    await userEvent.click(await view.findByText('Show archived tasks'))

    // The retained archived error no longer counts → open tasks render, no alert.
    await view.findByText('open task')
    expect(view.queryByRole('alert')).toBeNull()
    await view.unmount()
  })

  it('groups tasks by date bucket then note, in display order', async () => {
    seed('daily/2026-06-14.md', '+ [ ] today task\n')
    // Overdue needs an explicit past due date (V1 asymmetry): a bare past
    // daily-note task would be Current.
    seed('notes/d.md', '+ [ ] overdue task [[2026-06-10]]\n', { noteTitle: 'D' })
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await view.findByText('today task')
    const headers = view.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)
    expect(headers).toEqual(['Current', 'Overdue', 'Project'])
    expect(view.getByRole('button', { name: 'overdue task 2026-06-10' })).toBeDefined()
    expect(view.getByText('project task')).toBeDefined()
    await view.unmount()
  })

  it('renders one breadcrumb per consecutive task context and selects that context', async () => {
    seed(
      'notes/p.md',
      '+ StartupToolbox\n  + Reflections\n    + [ ] first\n    + [ ] second\n  + Later\n    + [ ] third\n',
      { noteTitle: 'Project' },
    )
    const view = await renderScreen()

    const context = await view.findByRole('button', {
      name: 'StartupToolbox → Reflections',
    })
    expect(view.getAllByText('StartupToolbox → Reflections')).toHaveLength(1)
    view.getByText('StartupToolbox → Later')

    await userEvent.click(context)
    expect(view.getByRole('button', { name: 'Convert to bullet 2' })).toBeDefined()
    await view.unmount()
  })

  it('hides a lone generic task breadcrumb', async () => {
    seed('notes/p.md', '+ Tasks:\n  + [ ] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await view.findByText('project task')
    expect(view.queryByText('Tasks:')).toBeNull()
    await view.unmount()
  })

  it('opens a task’s source note from its title without an arrow', async () => {
    seed('notes/p.md', '+ [ ] project task [[2026-06-10]]\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    const sourceLink = await view.findByRole('button', { name: 'Project' })
    expect(sourceLink.querySelector('svg')).toBeNull()
    await userEvent.click(sourceLink)
    expect(view.getByTestId('route').element().textContent).toContain('notes/p.md')
    await view.unmount()
  })

  it('opens a modifier-clicked task source in a new window without selecting the row', async () => {
    seed('notes/p.md', '+ [ ] project task [[2026-06-10]]\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    fireEvent.click(await view.findByRole('button', { name: 'Project' }), {
      metaKey: true,
      ctrlKey: true,
    })

    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/p.md',
      }),
    )
    expect(view.getByTestId('route').element().textContent).toBe('{"kind":"today"}')
    expect(view.queryByTestId('task-editor')).toBeNull()
    await view.unmount()
  })

  it('opens a modifier-clicked note-group title in a new window', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    fireEvent.click(await view.findByRole('button', { name: 'Project' }), {
      metaKey: true,
      ctrlKey: true,
    })

    await waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/p.md',
      }),
    )
    expect(view.getByTestId('route').element().textContent).toBe('{"kind":"today"}')
    await view.unmount()
  })

  it('opens a task’s source note from its date without editing the task', async () => {
    seed('daily/2026-06-09.md', '+ [ ] daily task\n')
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Tue, June 9th, 2026' }))

    expect(view.getByTestId('route').element().textContent).toBe(
      '{"kind":"daily","date":"2026-06-09"}',
    )
    expect(view.queryByTestId('task-editor')).toBeNull()
    await view.unmount()
  })

  it('renders unfocused task content as inline markdown', async () => {
    seed('notes/p.md', '+ [ ] ship **bold** text\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    const row = await view.findByRole('button', { name: 'ship bold text' })
    expect(row.querySelector('strong')?.textContent).toContain('bold')
    expect(row.getAttribute('aria-label')).toBe('ship bold text')
    await view.unmount()
  })

  it('selects a task when clicking the row outside the text control', async () => {
    seed('notes/p.md', '+ [ ] full row\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await view.findByRole('button', { name: 'full row' })
    const row = view.row(indexedTaskKey('notes/p.md', [0]))
    expect(row).toBeInstanceOf(HTMLElement)
    await userEvent.click(row)

    expect(view.getByTestId('task-editor').element().textContent).toContain('full row')
    await view.unmount()
  })

  it('opens the inline editor on a sole selection, and Escape exits it', async () => {
    seed('notes/p.md', '+ [ ] first\n+ [ ] second\n', { noteTitle: 'Project' })
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

  it('scrolls the focused task row into view after selection renders', async () => {
    seed('notes/p.md', '+ [ ] first\n+ [ ] second\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'second' }))
    const row = view.row(indexedTaskKey('notes/p.md', [1]))

    await waitFor(() => {
      const rect = row.getBoundingClientRect()
      expect(rect.top).toBeGreaterThanOrEqual(0)
      expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight)
    })
    await view.unmount()
  })

  it('saves, discards, or deletes an inline edit through the editor', async () => {
    seed('notes/p.md', '+ [ ] first\n+ [ ] second\n', { noteTitle: 'P' })
    const view = await renderScreen()

    // Type, then select another row → the draft is saved as the editor unmounts.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('stage-edit'))
    await userEvent.click(view.getByRole('button', { name: 'second' }))
    await waitFor(() =>
      expect(harness.notes.get('notes/p.md')).toBe('+ [ ] edited content\n+ [ ] second\n'),
    )
    expect(view.getByTestId('task-editor').element().textContent).toContain('second')

    // Re-select, clear the text, and cancel → the draft is dropped: no write, no
    // delete, edit mode exits, and the row keeps its saved text.
    await userEvent.click(view.getByRole('button', { name: 'edited content' }))
    await userEvent.click(view.getByText('stage-empty'))
    await userEvent.click(view.getByText('cancel-edit'))
    expect(view.queryByTestId('task-editor')).toBeNull()
    await harness.store.flush()
    expect(harness.writes).toHaveLength(1)
    expect(view.getByRole('button', { name: 'edited content' })).toBeDefined()

    // Re-select and delete → the line leaves the note, row gone.
    await userEvent.click(view.getByRole('button', { name: 'edited content' }))
    await userEvent.click(view.getByText('delete-edit'))
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [ ] second\n'))
    await waitFor(() => expect(view.queryByText('edited content')).toBeNull())
    await view.unmount()
  })

  it('saves the draft when ↓ moves the editor to the next row', async () => {
    seed('notes/p.md', '+ [ ] first\n+ [ ] second\n', { noteTitle: 'P' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('stage-edit'))
    // Typing alone writes nothing; the row is saved when its editor unmounts.
    expect(harness.writes).toHaveLength(0)
    await userEvent.click(view.getByText('nav-down'))
    await waitFor(() =>
      expect(harness.notes.get('notes/p.md')).toBe('+ [ ] edited content\n+ [ ] second\n'),
    )
    await view.findByText('editing: second')
    expect(view.getByRole('button', { name: 'edited content' })).toBeDefined()
    await view.unmount()
  })

  it('completes from the editor: edit+complete lands as one write', async () => {
    seed('notes/p.md', '+ [ ] first\n', { noteTitle: 'P' })
    const view = await renderScreen()

    // ⌘↵ with an edit → the typed text and the checkbox flip together.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('complete-edited'))
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] edited content\n'))
    await harness.store.flush()
    expect(harness.writes).toHaveLength(1)
    await view.findByRole('button', { name: 'Reopen: edited content' })
    await view.unmount()
  })

  it('editing an already-completed task with ⌘↵ saves the text and reopens it', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/p.md', '+ [x] done task\n', { noteTitle: 'P' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'done task' }))
    await userEvent.click(view.getByText('complete-edited'))
    // The marker stays `[x]`, no toggle back to open.
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [ ] edited content\n'))
    await view.unmount()
  })

  it('completes from the editor: an unchanged task just flips its marker', async () => {
    seed('notes/p.md', '+ [ ] first\n', { noteTitle: 'P' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByText('complete-unchanged'))
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] first\n'))
    await harness.store.flush()
    expect(harness.writes).toHaveLength(1)
    await view.unmount()
  })

  it('toggles rows with ⌘-click and selects a range with shift-click', async () => {
    seed('notes/p.md', '+ [ ] first\n+ [ ] second\n+ [ ] third\n', { noteTitle: 'Project' })
    const view = await renderScreen()
    const pressed = (name: string) =>
      view.getByRole('button', { name }).element().getAttribute('aria-pressed') === 'true'

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    // ⌘-click adds the row without clearing the rest (modifier set explicitly,
    // userEvent's held modifiers don't reach its synthetic click).
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'third' }), MOD_KEY)
    })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, false, true])
    expect(openRouteInNewWindow).not.toHaveBeenCalled()

    // Shift-click from the anchor (third) back to first selects the whole range.
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'first' }), { shiftKey: true })
    })
    expect([pressed('first'), pressed('second'), pressed('third')]).toEqual([true, true, true])
    await view.unmount()
  })

  it('selects all with ⌘A and moves a single selection with the arrow keys', async () => {
    seed('notes/a.md', '+ [ ] first\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] second\n', { noteTitle: 'B' })
    const view = await renderScreen()
    const pressed = (name: string) =>
      view.getByRole('button', { name }).element().getAttribute('aria-pressed') === 'true'

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
    seed('notes/a.md', '+ [ ] first\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] second\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select all
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [x] first\n'))
    await waitFor(() => expect(harness.notes.get('notes/b.md')).toBe('+ [x] second\n'))
    // Completing keeps both showing struck (the middle state), not dropped.
    await waitFor(() => expect(view.getAllByRole('button', { name: /^Reopen:/ })).toHaveLength(2))
    expect(view.getByText('first')).toBeDefined()
    await view.unmount()
  })

  it('deletes a multi-selection with ⌘⌫', async () => {
    seed('notes/a.md', '+ [ ] first\n+ [ ] keep\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] second\n', { noteTitle: 'B' })
    const view = await renderScreen()

    // ⌘⌫ deletes only outside the inline editor (a multi-selection mounts none);
    // while editing a sole task it's a text edit, so it can't race the commit.
    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    fireEvent.click(view.getByRole('button', { name: 'second' }), MOD_KEY)
    await userEvent.keyboard('{ControlOrMeta>}{Backspace}{/ControlOrMeta}')
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [ ] keep\n'))
    await waitFor(() => expect(harness.notes.get('notes/b.md')).not.toContain('second'))
    await waitFor(() => expect(view.queryByText('first')).toBeNull())
    expect(view.getByText('keep')).toBeDefined()
    await view.unmount()
  })

  it('a note group’s "+ Add" button adds a row to that note, written once it has text', async () => {
    seed('notes/proj.md', '+ [ ] a\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await view.findByText('a')
    await userEvent.click(await view.findByRole('button', { name: 'Add a task to Project' }))
    // The new row's editor opens, ready to type; nothing is written yet.
    await view.findByText('editing: ')
    await harness.store.flush()
    expect(harness.writes).toHaveLength(0)

    await userEvent.click(view.getByText('stage-edit'))
    await userEvent.click(view.getByRole('button', { name: 'a' })) // leave the new row
    await waitFor(() =>
      expect(harness.notes.get('notes/proj.md')).toBe('+ [ ] a\n+ [ ] edited content\n'),
    )
    await view.findByRole('button', { name: 'edited content' })
    await view.unmount()
  })

  it('Overdue tasks show no "+ Add" button (V1 can’t add to an aggregate bucket)', async () => {
    seed('notes/p.md', '+ [ ] late [[2026-06-01]]\n', { noteTitle: 'P' })
    const view = await renderScreen()

    await view.findByRole('button', { name: 'late 2026-06-01' })
    expect(view.queryByRole('button', { name: /Add a task/ })).toBeNull()
    await view.unmount()
  })

  it('Return adds a task to today’s daily and opens its inline editor', async () => {
    seed('notes/a.md', '+ [ ] first\n', { noteTitle: 'A' })
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Enter}')
    // The empty row mounts its inline editor, ready to type into.
    await view.findByText('editing: ')
    expect(harness.writes).toHaveLength(0)

    // Nothing was selected, so the typed task lands in today's daily note.
    await userEvent.click(view.getByText('stage-edit'))
    await userEvent.click(view.getByRole('button', { name: 'first' })) // leave the new row
    await waitFor(() =>
      expect(harness.notes.get('daily/2026-06-14.md')).toBe('+ [ ] edited content\n'),
    )
    expect(harness.notes.get('notes/a.md')).toBe('+ [ ] first\n')
    await view.findByRole('heading', { level: 2, name: 'Current' })
    await view.unmount()
  })

  it('dismissing the inserted row removes it without a write (V1 empty cleanup)', async () => {
    seed('notes/a.md', '+ [ ] first\n', { noteTitle: 'A' })
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{Enter}')
    await view.findByTestId('task-editor')
    // An empty Return-to-add row, left untouched, is removed rather than left as
    // a blank `+ [ ] ` line: the daily note is never created.
    await userEvent.click(view.getByRole('button', { name: 'delete-edit' }))
    await waitFor(() => expect(view.queryByTestId('task-editor')).toBeNull())
    await harness.store.flush()
    expect(harness.writes).toHaveLength(0)
    expect(harness.notes.has('daily/2026-06-14.md')).toBe(false)
    expect(view.getAllByRole('button', { name: /^Complete:/ })).toHaveLength(1)
    await view.unmount()
  })

  it('Backspace deletes a row and lands the editor on the previous one (V1)', async () => {
    seed('notes/a.md', '+ [ ] first\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] second\n', { noteTitle: 'B' })
    const view = await renderScreen()

    // Select the second row (its editor opens), then ⌫-delete it.
    await userEvent.click(await view.findByRole('button', { name: 'second' }))
    await view.findByTestId('task-editor')
    // The editor only asks to remove an emptied row.
    await userEvent.click(view.getByRole('button', { name: 'stage-empty' }))
    await userEvent.click(view.getByRole('button', { name: 'delete-empty-edit' }))

    await waitFor(() => expect(harness.notes.get('notes/b.md')).not.toContain('second'))
    expect(harness.notes.get('notes/a.md')).toBe('+ [ ] first\n')
    // Lands on the previous row, whose editor now opens.
    await view.findByText('editing: first')
    await view.unmount()
  })

  it('plain ⌫ leaves a multi-selection untouched (ambiguous, V1)', async () => {
    seed('notes/a.md', '+ [ ] \n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] keep\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await view.findByText('keep')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both
    act(() => {
      fireEvent.keyDown(view.getByLabelText('Tasks', { exact: true }), { key: 'Backspace' })
    })
    // V1 refuses a multi-row ⌫ (which row would survive is unclear).
    await harness.store.flush()
    expect(harness.writes).toHaveLength(0)
    expect(view.getAllByRole('button', { name: /^Complete:/ })).toHaveLength(2)
    await view.unmount()
  })

  it('Enter in the editor saves the row and opens the next task (continuous entry)', async () => {
    seed('notes/a.md', '+ [ ] first\n', { noteTitle: 'A' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))

    // Persists this row's edit, then opens the next placeholder in the same note.
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [ ] edited content\n'))
    await view.findByText('editing: ')
    await userEvent.click(view.getByText('stage-edit'))
    await userEvent.click(view.getByRole('button', { name: 'edited content' })) // leave the new row
    await waitFor(() =>
      expect(harness.notes.get('notes/a.md')).toBe('+ [ ] edited content\n+ [ ] edited content\n'),
    )
    await view.unmount()
  })

  it('keeps the edited grouped row and opens the next placeholder when saving fails', async () => {
    harness.failNextWrite(new Error('This note is open.'))
    const failure = vi.spyOn(harness.io, 'failure')
    seed('notes/a.md', '+ Project\n  + [ ] first\n', { noteTitle: 'A' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await userEvent.click(view.getByRole('button', { name: 'continue-edit' }))

    await waitFor(() => expect(failure).toHaveBeenCalledOnce())
    expect(failure.mock.calls[0]?.[1]).toEqual(new Error('This note is open.'))
    // The failed intent stays visible on the row, and the next placeholder's editor opens.
    await view.findByRole('button', { name: 'edited content' })
    await view.findByText('editing: ')
    expect(harness.notes.get('notes/a.md')).toBe('+ Project\n  + [ ] first\n')
    await view.unmount()
  })

  it('Enter continues a scheduled grouped task despite its aggregate date bucket', async () => {
    seed('notes/a.md', '+ Project\n  + [ ] scheduled [[2026-07-01]]\n', { noteTitle: 'A' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'scheduled 2026-07-01' }))
    await userEvent.click(view.getByRole('button', { name: 'continue-unchanged' }))

    await view.findByText('editing: ')
    expect(
      harness.store
        .list(harness.indexed(false))
        .some((row) => row.text === '' && row.breadcrumbs.includes('Project')),
    ).toBe(true)
    await view.unmount()
  })

  it('Enter on a cleared row deletes it instead of leaving a bare task (no ghost)', async () => {
    seed('notes/a.md', '+ [ ] first\n+ [ ] keep\n', { noteTitle: 'A' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'continue-empty' }))
    // The cleared row is deleted (not edited to `+ [ ]`).
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [ ] keep\n'))
    await harness.store.flush()
    expect(harness.writes).toHaveLength(1)
    await view.unmount()
  })

  it('↑/↓ in the editor move the selection between rows (V1)', async () => {
    seed('notes/a.md', '+ [ ] first\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] second\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'first' }))
    await view.findByText('editing: first')
    await userEvent.click(view.getByRole('button', { name: 'nav-down' }))
    // The editor follows the selection to the next row.
    await view.findByText('editing: second')
    await view.unmount()
  })

  it('does not reopen an already-completed task when ⌘↵ hits the selection', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/a.md', '+ [ ] open\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [x] done\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await view.findByRole('button', { name: 'open' })
    await view.findByRole('button', { name: 'done' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // selects the open and the completed row
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    // Only the open row flips; the completed one is left untouched.
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [x] open\n'))
    await harness.store.flush()
    expect(harness.notes.get('notes/b.md')).toBe('+ [x] done\n')
    expect(harness.writes).toHaveLength(1)
    await view.unmount()
  })

  it('scheduling the selection writes a due-date link to each task (V1)', async () => {
    seed('notes/a.md', '+ [ ] plan\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] ship\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor)
    await userEvent.click(view.getByRole('button', { name: /Schedule 2/ }))
    // Pick June 20 in the calendar (today mock = 2026-06-14, so it opens on June).
    await userEvent.click(await view.findByText('20'))

    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [ ] plan [[2026-06-20]]\n'))
    await waitFor(() => expect(harness.notes.get('notes/b.md')).toBe('+ [ ] ship [[2026-06-20]]\n'))
    // The scheduled rows move into the Upcoming bucket.
    await view.findByRole('heading', { level: 2, name: 'Upcoming' })
    await view.unmount()
  })

  it('converts a multi-selection to bullets via the toolbar button (no editor, bulk)', async () => {
    seed('notes/a.md', '+ [ ] plan\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] ship\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor mounts)
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet 2/ }))

    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ plan\n'))
    await waitFor(() => expect(harness.notes.get('notes/b.md')).toBe('+ ship\n'))
    // The converted rows are no longer checkboxes, so they leave the view.
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    expect(view.queryByText('ship')).toBeNull()
    await view.unmount()
  })

  it('converts a multi-selection to bullets with ⌘⇧K', async () => {
    seed('notes/a.md', '+ [ ] plan\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] ship\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await view.findByText('plan')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor mounts)
    await userEvent.keyboard('{ControlOrMeta>}{Shift>}k{/Shift}{/ControlOrMeta}')
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ plan\n'))
    await waitFor(() => expect(harness.notes.get('notes/b.md')).toBe('+ ship\n'))
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    await view.unmount()
  })

  it('converts a sole-edited row from the toolbar, saving the draft before converting', async () => {
    // The store folds the row's open draft into the convert, so the typed text
    // and the dropped marker land in one write: the data-loss race Bugbot
    // flagged (convert landing before the editor's commit) can't happen.
    seed('notes/a.md', '+ [ ] plan\n', { noteTitle: 'A' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'plan' })) // sole → editor mounts
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: /Convert to bullet 1/ }))

    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ edited content\n'))
    await harness.store.flush()
    expect(harness.writes).toHaveLength(1)
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    expect(view.queryByTestId('task-editor')).toBeNull()
    await view.unmount()
  })

  it('converts an edited row from the editor’s own ⌘⇧K (save then convert)', async () => {
    seed('notes/a.md', '+ [ ] plan\n', { noteTitle: 'A' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'plan' }))
    await userEvent.click(view.getByRole('button', { name: 'convert-edited' }))
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ edited content\n'))
    await waitFor(() => expect(view.queryByText('plan')).toBeNull())
    await view.unmount()
  })

  it('⌘↵ reopens a selection that is already all checked (toggle both ways, V1)', async () => {
    seed('notes/a.md', '+ [ ] one\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] two\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await view.findByText('one')
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}') // select both (no editor)
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}') // complete both
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [x] one\n'))
    await waitFor(() => expect(harness.notes.get('notes/b.md')).toBe('+ [x] two\n'))
    await waitFor(() => expect(view.getAllByRole('button', { name: /^Reopen:/ })).toHaveLength(2))

    // The struck rows stay selected; ⌘↵ again reopens them.
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [ ] one\n'))
    await waitFor(() => expect(harness.notes.get('notes/b.md')).toBe('+ [ ] two\n'))
    await waitFor(() => expect(view.getAllByRole('button', { name: /^Complete:/ })).toHaveLength(2))
    await view.unmount()
  })

  it('ignores task shortcuts coming from a portaled overlay (the filters menu)', async () => {
    seed('notes/a.md', '+ [ ] first\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] second\n', { noteTitle: 'B' })
    const view = await renderScreen()
    await view.findByRole('button', { name: 'first' })

    // The filters menu portals a role="menu" outside the list and owns its own
    // arrow navigation, so a keydown from there must not drive the task selection.
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
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n'))
    // V1's middle state: the row stays visible, struck, until archived.
    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.getByText('project task')).toBeDefined()
    await view.unmount()
  })

  it('yields the struck row to the index when the task is reopened at its source note', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n'))

    // The checkbox is flipped back to [ ] in the note itself; the reindex
    // reports the task open again. The session's struck copy must yield:
    // keeping it would shadow the live row and its Reopen would fail (the [x]
    // line is no longer in the note).
    harness.notes.set('notes/p.md', '+ [ ] project task\n')
    await client.invalidateQueries({ queryKey: queryKeys.index.all })

    await view.findByRole('button', { name: 'Complete: project task' })
    expect(view.queryByRole('button', { name: 'Reopen: project task' })).toBeNull()
    await view.unmount()
  })

  it('keeps the struck row when a refetch races the completion’s write', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const gate = gateNextWrite()
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })

    // An unrelated invalidation refetches before the completion lands: the
    // index still returns the pre-completion row. The row must stay struck
    // rather than flicker back to open.
    await client.invalidateQueries({ queryKey: queryKeys.index.all })
    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.queryByRole('button', { name: 'Complete: project task' })).toBeNull()

    gate.release()
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n'))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await view.unmount()
  })

  it('completes a selected task when its checkbox is clicked', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    expect(view.getByTestId('task-editor')).toBeDefined()
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n'))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await view.unmount()
  })

  it('completes every selected open task when a selected checkbox is clicked', async () => {
    seed('notes/a.md', '+ [ ] first task\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] second task\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first task' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.click(view.getByRole('button', { name: 'Complete: first task' }))

    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [x] first task\n'))
    await waitFor(() => expect(harness.notes.get('notes/b.md')).toBe('+ [x] second task\n'))
    await view.findByRole('button', { name: 'Reopen: first task' })
    await view.findByRole('button', { name: 'Reopen: second task' })
    await view.unmount()
  })

  it('reopens selected checked tasks when a checked selected checkbox is clicked', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/a.md', '+ [ ] open task\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [x] done task\n', { noteTitle: 'B' })
    const view = await renderScreen()

    await view.findByRole('button', { name: 'open task' })
    await view.findByRole('button', { name: 'done task' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.click(view.getByRole('button', { name: 'Reopen: done task' }))

    await waitFor(() => expect(harness.notes.get('notes/b.md')).toBe('+ [ ] done task\n'))
    await harness.store.flush()
    expect(harness.notes.get('notes/a.md')).toBe('+ [ ] open task\n')
    expect(harness.writes).toHaveLength(1)
    await view.findByRole('button', { name: 'Complete: open task' })
    await view.findByRole('button', { name: 'Complete: done task' })
    await view.unmount()
  })

  it('saves an edited selected task before completing it from the checkbox', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] edited content\n'))
    await harness.store.flush()
    expect(harness.writes).toHaveLength(1)
    // The checkbox flipped, the row shows the typed text, and the editor stays open.
    await view.findByRole('button', { name: 'Reopen: edited content' })
    expect(view.getByTestId('task-editor')).toBeDefined()
    await view.unmount()
  })

  it('accepts another checkbox intent while an edit write is pending', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const gate = gateNextWrite()
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Complete: project task' }))

    // The edit is still in flight; a second checkbox click is not blocked by it.
    const reopen = await view.findByRole('button', { name: 'Reopen: edited content' })
    expect(harness.writes).toHaveLength(0)
    fireEvent.click(reopen)
    await view.findByRole('button', { name: 'Complete: edited content' })

    gate.release()
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [ ] edited content\n'))
    await harness.store.flush()
    expect(harness.writes.map((write) => write.source)).toEqual([
      '+ [x] edited content\n',
      '+ [ ] edited content\n',
    ])
    await view.findByRole('button', { name: 'Complete: edited content' })
    await view.unmount()
  })

  it('reopens a completed task when its checkbox is clicked', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [ ] project task\n'))
    await view.findByRole('button', { name: 'Complete: project task' })
    await view.unmount()
  })

  it('reopens an archived completed task when its checkbox is clicked', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/p.md', '+ [x] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [ ] project task\n'))
    await view.findByRole('button', { name: 'Complete: project task' })
    await view.unmount()
  })

  it('shows an open checkbox while a reopen write is pending', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/p.md', '+ [x] project task\n', { noteTitle: 'Project' })
    const gate = gateNextWrite()
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Reopen: project task' }))
    const complete = await view.findByRole('button', { name: 'Complete: project task' })
    expect(complete.querySelector('.lucide-circle-check')).toBeNull()
    expect(complete.querySelector('.lucide-circle')).not.toBeNull()
    expect(harness.writes).toHaveLength(0)

    gate.release()
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [ ] project task\n'))
    await view.unmount()
  })

  it('keeps the reopen intent when saving fails', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const failure = vi.spyOn(harness.io, 'failure')
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n'))

    harness.failNextWrite(new Error('stale index'))
    await userEvent.click(view.getByRole('button', { name: 'project task' }))
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(failure).toHaveBeenCalledOnce())
    expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n')
    // The reopen stays as a pending intent on the row itself.
    await view.findByRole('button', { name: 'Complete: project task' })
    await view.unmount()
  })

  it('reopens a selected completed task when its checkbox is clicked', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/p.md', '+ [x] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    expect(view.getByTestId('task-editor')).toBeDefined()
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [ ] project task\n'))
    await view.unmount()
  })

  it('saves an edited selected completed task before reopening it from the checkbox', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/p.md', '+ [x] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [ ] edited content\n'))
    await harness.store.flush()
    expect(harness.writes).toHaveLength(1)
    await view.unmount()
  })

  it('keeps edited text in the ordinary task row when reopening fails', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const failure = vi.spyOn(harness.io, 'failure')
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n'))

    harness.failNextWrite(new Error('disk full'))
    await userEvent.click(view.getByRole('button', { name: 'project task' }))
    await userEvent.click(view.getByRole('button', { name: 'stage-edit' }))
    await userEvent.click(view.getByRole('button', { name: 'Reopen: project task' }))

    await waitFor(() => expect(failure).toHaveBeenCalledOnce())
    expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n')
    // The failed edit stays as a pending intent on the row itself.
    await view.findByRole('button', { name: 'Complete: edited content' })
    await view.unmount()
  })

  it('keeps a completed task visible (struck) when archived tasks are shown', async () => {
    // With "show archived" on, completing must move the row into the completed
    // list (struck), not drop it until the refetch (Bugbot regression).
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    // Flipped to completed in place, still on screen, now marked done.
    await view.findByRole('button', { name: 'Reopen: project task' })
    expect(view.getByText('project task')).toBeDefined()
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n'))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await view.unmount()
  })

  it('shows the Archive button after completing, and Archive hides the row', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'P' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    // The row lingers struck and an Archive 1 action appears.
    const archive = await view.findByRole('button', { name: /Archive 1/ })
    expect(view.getByText('project task')).toBeDefined()

    await userEvent.click(archive)
    // Archiving hides this session's completed rows (still `[x]` on disk).
    await waitFor(() => expect(view.queryByText('project task')).toBeNull())
    expect(view.queryByRole('button', { name: /Archive/ })).toBeNull()
    await harness.store.flush()
    expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n')
    await view.unmount()
  })

  it('archives the session’s completed tasks with ⌘⇧↵', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'P' })
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await userEvent.keyboard('{ControlOrMeta>}{Shift>}{Enter}{/Shift}{/ControlOrMeta}')
    await waitFor(() => expect(view.queryByText('project task')).toBeNull())
    await view.unmount()
  })

  it('retains a failed delete intent and reports the error without restoring a row', async () => {
    seed('notes/a.md', '+ [ ] one\n', { noteTitle: 'A' })
    const failure = vi.spyOn(harness.io, 'failure')
    const view = await renderScreen()

    // Complete it → struck (kept showing via the session set), then try to delete.
    await userEvent.click(await view.findByRole('button', { name: 'Complete: one' }))
    await view.findByRole('button', { name: 'Reopen: one' })
    await waitFor(() => expect(harness.notes.get('notes/a.md')).toBe('+ [x] one\n'))
    harness.failNextWrite(new Error('disk full'))
    await userEvent.click(view.getByRole('button', { name: 'one' })) // select the struck row → editor opens
    await view.findByTestId('task-editor')
    await userEvent.click(view.getByRole('button', { name: 'delete-edit' }))

    await waitFor(() => expect(failure).toHaveBeenCalledOnce())
    expect(harness.notes.get('notes/a.md')).toBe('+ [x] one\n')
    expect(view.queryByRole('button', { name: 'Reopen: one' })).toBeNull()
    await view.unmount()
  })

  it('keeps an optimistic completion and surfaces a failed save', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    harness.failNextWrite(new Error('stale index'))
    const failure = vi.spyOn(harness.io, 'failure')
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await waitFor(() => expect(failure).toHaveBeenCalledOnce())
    expect(failure.mock.calls[0]?.[1]).toEqual(new Error('stale index'))
    expect(harness.notes.get('notes/p.md')).toBe('+ [ ] project task\n')
    // The optimistic intent remains on the row, ready for a retry.
    await view.findByRole('button', { name: 'Reopen: project task' })
    await view.unmount()
  })

  it('retries a failed save from the failure callback', async () => {
    seed('notes/p.md', '+ [ ] project task\n', { noteTitle: 'Project' })
    harness.failNextWrite(new Error('stale index'))
    const failure = vi.spyOn(harness.io, 'failure')
    const view = await renderScreen()

    await userEvent.click(await view.findByRole('button', { name: 'Complete: project task' }))
    await waitFor(() => expect(failure).toHaveBeenCalledOnce())
    const retry = failure.mock.calls[0]?.[2]
    retry?.()
    await waitFor(() => expect(harness.notes.get('notes/p.md')).toBe('+ [x] project task\n'))
    await view.findByRole('button', { name: 'Reopen: project task' })
    await view.unmount()
  })

  it('keeps both optimistic rows when a bulk completion fails', async () => {
    seed('notes/a.md', '+ [ ] first\n', { noteTitle: 'A' })
    seed('notes/b.md', '+ [ ] second\n', { noteTitle: 'B' })
    harness.failNextWrite(new Error('stale index'))
    harness.failNextWrite(new Error('stale index'))
    const failure = vi.spyOn(harness.io, 'failure')
    const view = await renderScreen()

    await view.findByRole('button', { name: 'first' })
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')
    await waitFor(() => expect(failure).toHaveBeenCalledTimes(2))
    expect(harness.notes.get('notes/a.md')).toBe('+ [ ] first\n')
    expect(harness.notes.get('notes/b.md')).toBe('+ [ ] second\n')
    await view.findByRole('button', { name: 'Reopen: first' })
    await view.findByRole('button', { name: 'Reopen: second' })
    await view.unmount()
  })
})
