import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent, type Locator } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task, TaskStore } from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { swipe, translateX } from '@/test-utils/swipe.ts'
import {
  createTaskStoreHarness,
  type NoteMeta,
  type TaskStoreHarness,
} from '@/test-utils/task-store-harness.ts'
import { MobileTasks } from './tasks.tsx'

/**
 * The mobile Tasks tab (V1 mobile's third tab over Plan 18 data): desktop's
 * groups and write-backs with a touch surface: checkbox toggles, the
 * quick-edit sheet (edit / schedule / complete / convert / open note /
 * delete), the filter sheet, and "+" add. The screen drives the real
 * `TaskStore` over an in-memory graph (`task-store-harness.ts`): the core
 * task getters resolve from the harness's notes, and every action is asserted
 * on the Markdown it leaves behind. The sheet's markdown editor is a textarea
 * stand-in; grouping/merge rules are unit-tested in task-visibility.test.ts.
 */

const getOpenTasks = vi.hoisted(() => vi.fn())
const getCompletedTasks = vi.hoisted(() => vi.fn())
const resolveOrCreateNoteWithTitle = vi.hoisted(() => vi.fn())
const hapticImpactLight = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getOpenTasks,
  getCompletedTasks,
  resolveOrCreateNoteWithTitle,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/lib/use-today.ts', () => ({ useToday: () => '2026-06-14' }))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      dateFormat: 'mdy',
      weekStartDay: 'monday',
      editorMarkdownSyntax: 'hide',
      editorSpellCheck: false,
    },
  }),
}))
// TaskText rendering is covered separately, so this suite keeps a small preview stub.
vi.mock('@/editor/markdown-preview.tsx', () => ({
  MarkdownPreview: ({ content, className }: { content: string; className?: string }) => (
    <span data-testid="markdown-preview" className={className}>
      {content}
    </span>
  ),
}))
// The autocomplete hook reads the contacts authorization over IPC; the menus
// themselves live inside meowdown, which is stubbed out below anyway.
vi.mock('@/editor/use-editor-autocomplete.ts', () => ({
  useEditorAutocomplete: () => ({
    onWikilinkSearch: async () => [],
    onTagSearch: async () => [],
  }),
}))
vi.mock('@/mobile/haptics.ts', () => ({
  hapticImpactLight,
}))
// Instant settle, so row transforms can be asserted synchronously.
vi.mock('@/mobile/use-reduced-motion.ts', () => ({ usePrefersReducedMotion: () => true }))

const editorProbe = vi.hoisted(() => ({ focusCalls: 0 }))

// The sheet hosts the real markdown editor (desktop's inline task-editor
// surface), which is covered separately. This stand-in is a
// textarea over the same NoteEditor contract: uncontrolled seed from
// `initialContent`, `onChange` with the markdown, a **silent** `setMarkdown`
// (no onChange echo, matching meowdown), plus probes for focus and wiki-link
// clicks. Children (the Enter keymap) need the ProseKit context, so they are
// not rendered.
vi.mock('@/editor/note-editor.tsx', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    NoteEditor: ({
      initialContent,
      onChange,
      onWikiLinkClick,
      handleRef,
    }: {
      initialContent: string
      onChange?: (markdown: string) => void
      onWikiLinkClick?: (options: { target: string; openInNewWindow: boolean }) => void
      handleRef?: (handle: import('@/editor/note-editor.tsx').NoteEditorHandle | null) => void
    }) => {
      const areaRef = useRef<HTMLTextAreaElement | null>(null)
      useEffect(() => {
        handleRef?.({
          getMarkdown: () => areaRef.current?.value ?? '',
          setMarkdown: (markdown) => {
            if (areaRef.current !== null) {
              areaRef.current.value = markdown
            }
          },
          insertMarkdown: () => {},
          focus: () => {
            editorProbe.focusCalls += 1
          },
          setSelection: () => {},
          isAtTextblockBoundary: () => true,
          getSelectedText: () => '',
          openSelectionMenu: () => {},
          startPendingReplacement: () => false,
          appendPendingReplacementText: () => {},
          acceptPendingReplacement: () => {},
          discardPendingReplacement: () => {},
          findNext: () => {},
          findPrevious: () => {},
        })
        return () => handleRef?.(null)
      }, [handleRef])
      return (
        <>
          <textarea
            ref={areaRef}
            aria-label="Task text"
            defaultValue={initialContent}
            onChange={(event) => onChange?.(event.target.value)}
          />
          {onWikiLinkClick !== undefined ? (
            <button
              type="button"
              onClick={() => onWikiLinkClick({ target: 'Other Note', openInNewWindow: false })}
            >
              fake-wikilink
            </button>
          ) : null}
        </>
      )
    },
  }
})

// The screen reads the graph's store through this module; the test swaps in
// the harness's store, which writes into the in-memory notes.
const harnessRef = vi.hoisted(() => ({
  value: null as import('@/test-utils/task-store-harness.ts').TaskStoreHarness | null,
}))
vi.mock('@/lib/tasks/task-store.ts', async () => {
  const { useSyncExternalStore } = await import('react')
  const store = () => {
    if (harnessRef.value === null) throw new Error('no task store harness')
    return harnessRef.value.store
  }
  return {
    useTaskStore: store,
    useTaskStoreVersion: (current: TaskStore) =>
      useSyncExternalStore(current.subscribe, current.snapshot),
    taskStore: store,
    retireTaskStores: async () => {},
  }
})

// Vaul's drag/animation is verified on-device. This passthrough honours `open` and
// exposes the dismissal path as a button, so commit-on-dismiss is testable.
vi.mock('@/components/ui/drawer.tsx', () => ({
  Drawer: ({
    open,
    onOpenChange,
    children,
  }: {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    children?: ReactNode
  }) =>
    open ? (
      <div data-testid="drawer">
        {children}
        <button type="button" onClick={() => onOpenChange?.(false)}>
          dismiss-drawer
        </button>
      </div>
    ) : null,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

/** Narrow a queried element to the editor stub's textarea so `.value` typechecks. */
function asTextArea(element: Element): HTMLTextAreaElement {
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new TypeError('expected a textarea')
  }
  return element
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

let harness: TaskStoreHarness
let queryClient: QueryClient

const NOTE = 'notes/n.md'
const TODAY_DAILY = 'daily/2026-06-14.md'

/** Put a note into the in-memory graph, titled `N` like the desktop fixtures unless told otherwise. */
function seed(path: string, source: string, meta: Partial<NoteMeta> = {}): void {
  harness.notes.set(path, source)
  harness.meta.set(path, {
    noteTitle: 'N',
    dailyDate: null,
    isPinned: false,
    pinnedOrder: null,
    ...meta,
  })
}

function seedDaily(date: string, source: string): void {
  seed(`daily/${date}.md`, source, { noteTitle: date, dailyDate: date })
}

function renderScreen() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider>
        <MobileTasks />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  ).then((view) => {
    const find = async (locator: Locator): Promise<Element> => {
      await expect.element(locator).toBeInTheDocument()
      return locator.element()
    }
    return Object.assign(view, {
      findAllByText: async (...args: Parameters<typeof view.getByText>) => {
        const locator = view.getByText(...args)
        await expect.poll(() => locator.elements().length).toBeGreaterThan(0)
        return locator.elements()
      },
      findByRole: (...args: Parameters<typeof view.getByRole>) => find(view.getByRole(...args)),
      findByText: (...args: Parameters<typeof view.getByText>) => find(view.getByText(...args)),
      getAllByText: (...args: Parameters<typeof view.getByText>) =>
        view.getByText(...args).elements(),
      queryByLabelText: (...args: Parameters<typeof view.getByLabelText>) =>
        view.getByLabelText(...args).query(),
      queryByRole: (...args: Parameters<typeof view.getByRole>) => view.getByRole(...args).query(),
      queryByText: (...args: Parameters<typeof view.getByText>) => view.getByText(...args).query(),
    })
  })
}

const waitFor = vi.waitFor

/** Swipe a row far enough left that its release settles open, and return its moving surface. */
async function revealSwipeActions(
  view: Awaited<ReturnType<typeof renderScreen>>,
  label: string,
): Promise<HTMLElement> {
  const body = await view.findByRole('button', { name: `Edit: ${label}` })
  const surface = body.parentElement!
  const rect = surface.getBoundingClientRect()
  swipe(
    surface,
    { x: rect.right - 20, y: rect.top + 16 },
    { x: rect.right - 160, y: rect.top + 16 },
  )
  return surface
}

beforeEach(async () => {
  harness = createTaskStoreHarness({
    onWritten: () => queryClient.invalidateQueries({ queryKey: queryKeys.index.all }),
  })
  harnessRef.value = harness
  await page.viewport(375, 700)
  window.sessionStorage.clear()
  getOpenTasks.mockReset().mockImplementation(async () => harness.indexed(false))
  getCompletedTasks.mockReset().mockImplementation(async () => harness.indexed(true))
  resolveOrCreateNoteWithTitle.mockReset()
  resolveOrCreateNoteWithTitle.mockResolvedValue({
    kind: 'resolved',
    path: 'notes/other.md',
  })
  hapticImpactLight.mockClear()
  editorProbe.focusCalls = 0
})

afterEach(async () => {
  await cleanup()
  await harness.store.flush()
  harnessRef.value = null
})

describe('MobileTasks', () => {
  it('renders desktop’s groups with counts and source dates', async () => {
    seedDaily('2026-06-14', '+ [ ] jotted today\n')
    seedDaily('2026-06-01', '+ [ ] late [[2026-06-01]]\n')
    seed(NOTE, '+ [ ] undated\n')
    const view = await renderScreen()

    await view.findByText('Current')
    view.getByText('Overdue')
    // The undated task groups under its source note's title.
    view.getByRole('button', { name: 'N' })
    // Date buckets show the source note's compact date on the row.
    view.getByText('6/1/2026')
    await view.unmount()
  })

  it('renders one read-only breadcrumb per consecutive task context', async () => {
    seed(
      NOTE,
      [
        '- Project',
        '  - Release',
        '    + [ ] first',
        '    + [ ] second',
        '  - Later',
        '    + [ ] third',
        '  - Release',
        '    + [ ] fourth',
        '',
      ].join('\n'),
    )
    const view = await renderScreen()

    expect(await view.findAllByText('Project → Release')).toHaveLength(2)
    expect(view.getAllByText('Project → Later')).toHaveLength(1)
    expect(view.queryByRole('button', { name: 'Project → Release' })).toBeNull()
    await view.unmount()
  })

  it('hides a lone generic task breadcrumb', async () => {
    seed(NOTE, '- Tasks:\n  + [ ] project task\n')
    const view = await renderScreen()

    await view.findByText('project task')
    expect(view.queryByText('Tasks:')).toBeNull()
    await view.unmount()
  })

  it('toggles a task from its checkbox and keeps it struck until archived', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Complete: buy milk' }))

    expect(hapticImpactLight).toHaveBeenCalledTimes(1)
    // V1's middle state: the completed row stays visible, struck, reopenable.
    await view.findByRole('button', { name: 'Reopen: buy milk' })
    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [x] buy milk\n'))
    expect(harness.writes).toHaveLength(1)
    view.getByRole('button', { name: 'Reopen: buy milk' })

    // Archive hides this session's completed rows.
    await user.click(view.getByRole('button', { name: 'Archive 1 completed' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(view.queryByText('buy milk')).toBeNull())
    await view.unmount()
  })

  it('reopens a struck task from its checkbox', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Complete: buy milk' }))
    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [x] buy milk\n'))
    await user.click(view.getByRole('button', { name: 'Reopen: buy milk' }))

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] buy milk\n'))
    await view.findByRole('button', { name: 'Complete: buy milk' })
    // Reopening takes the task out of this session's completed set.
    expect(view.queryByRole('button', { name: 'Archive 1 completed' })).toBeNull()
    await view.unmount()
  })

  it('fires light haptics for task list controls', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(1)

    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))
    await user.click(view.getByRole('button', { name: 'Task filters' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(2)

    await user.click(view.getByRole('checkbox', { name: 'Current' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(3)

    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))
    await user.click(view.getByRole('button', { name: 'New task' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(4)
    await view.unmount()
  })

  it('commits an edited draft when the quick-edit sheet is dismissed', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    const input = asTextArea(view.getByRole('textbox', { name: 'Task text' }).element())
    expect(input.value).toBe('buy milk')

    await user.clear(input)
    await user.type(input, 'buy oat milk')
    // Typing is buffered: nothing reaches the note until the edit ends.
    expect(harness.writes).toHaveLength(0)
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] buy oat milk\n'))
    expect(harness.writes).toHaveLength(1)
    await view.findByRole('button', { name: 'Edit: buy oat milk' })
    await view.unmount()
  })

  it('does not write when the sheet closes with an untouched draft', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    await harness.store.flush()
    expect(harness.writes).toHaveLength(0)
    expect(harness.notes.get(NOTE)).toBe('+ [ ] buy milk\n')
    await view.unmount()
  })

  it('deletes the task when the sheet is dismissed with an emptied draft', async () => {
    seed(NOTE, '+ [ ] keep\n+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.clear(view.getByRole('textbox', { name: 'Task text' }))
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] keep\n'))
    expect(harness.writes).toHaveLength(1)
    await waitFor(() => expect(view.queryByRole('button', { name: /^Edit: buy milk/ })).toBeNull())
    await view.unmount()
  })

  it('schedules a typed draft: saves the text, then the date link, then shows it', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    const input = view.getByRole('textbox', { name: 'Task text' })
    await user.clear(input)
    await user.type(input, 'buy oat milk')
    await user.click(view.getByRole('button', { name: 'Tomorrow' }))

    // The pending draft lands first, then the date link is added to the saved
    // text, and the editor remounts with the rescheduled text.
    await expect
      .poll(() => asTextArea(view.getByRole('textbox', { name: 'Task text' }).element()).value)
      .toBe('buy oat milk [[2026-06-15]]')
    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] buy oat milk [[2026-06-15]]\n'))
    await harness.store.flush()
    const writes = harness.writes.length
    expect(writes).toBeGreaterThanOrEqual(1)
    await view.findByRole('button', { name: /^Edit: buy oat milk/ })

    // Dismissal finds nothing left to save.
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))
    await harness.store.flush()
    expect(harness.writes).toHaveLength(writes)
    expect(harness.notes.get(NOTE)).toBe('+ [ ] buy oat milk [[2026-06-15]]\n')
    await view.unmount()
  })

  it('fires light haptics for task sheet scheduling and actions', async () => {
    // A dated task, so the Clear chip is on the sheet from the start.
    seed(NOTE, '+ [ ] late [[2026-06-01]]\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: /^Edit: late/ }))
    hapticImpactLight.mockClear()

    await user.click(view.getByRole('button', { name: 'Mon, June 1st, 2026' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(1)

    await user.click(view.getByRole('button', { name: 'Tomorrow' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(2)

    await user.click(view.getByRole('button', { name: 'Clear' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(3)

    await user.click(view.getByRole('button', { name: 'Convert to bullet' }))
    expect(hapticImpactLight).toHaveBeenCalledTimes(4)
    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ late\n'))
    await view.unmount()
  })

  it('clears the due date from the schedule row', async () => {
    seed(NOTE, '+ [ ] late [[2026-06-01]]\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: /^Edit: late/ }))
    await user.click(view.getByRole('button', { name: 'Clear' }))

    // The `[[date]]` link leaves the text, and with it the Clear chip.
    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] late\n'))
    expect(harness.writes).toHaveLength(1)
    await waitFor(() => expect(view.queryByRole('button', { name: 'Clear' })).toBeNull())
    await expect
      .poll(() => asTextArea(view.getByRole('textbox', { name: 'Task text' }).element()).value)
      .toBe('late')
    await view.unmount()
  })

  it('completes from the sheet, saving a changed draft first', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    const input = view.getByRole('textbox', { name: 'Task text' })
    await user.clear(input)
    await user.type(input, 'buy oat milk')
    await user.click(view.getByRole('button', { name: 'Complete', exact: true }))

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [x] buy oat milk\n'))
    await view.findByRole('button', { name: 'Reopen: buy oat milk' })
    // One write path: the action closed the sheet, so no dismissal commit follows.
    await harness.store.flush()
    expect(harness.writes).toHaveLength(1)
    expect(view.queryByText('dismiss-drawer')).toBeNull()
    await view.unmount()
  })

  it('commits edits from a sheet re-opened after an action closed it', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    // First visit ends through an action button (Complete), which skips the
    // dismissal commit. The sheet stays mounted for the same task afterwards.
    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'Complete', exact: true }))
    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [x] buy milk\n'))

    // Second visit (the struck row): its edits must still commit on dismiss.
    await user.click(view.getByRole('button', { name: 'Edit: buy milk' }))
    const input = asTextArea(view.getByRole('textbox', { name: 'Task text' }).element())
    expect(input.value).toBe('buy milk')
    await user.clear(input)
    await user.type(input, 'buy oat milk')
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [x] buy oat milk\n'))
    expect(harness.writes).toHaveLength(2)
    await view.unmount()
  })

  it('converts to a bullet from the sheet', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'Convert to bullet' }))

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ buy milk\n'))
    await waitFor(() => expect(view.queryByRole('button', { name: 'Edit: buy milk' })).toBeNull())
    await view.unmount()
  })

  it('deletes an emptied draft on Complete instead of resurrecting the text', async () => {
    seed(NOTE, '+ [ ] keep\n+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.clear(view.getByRole('textbox', { name: 'Task text' }))
    await user.click(view.getByRole('button', { name: 'Complete', exact: true }))

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] keep\n'))
    expect(harness.writes).toHaveLength(1)
    await waitFor(() => expect(view.queryByRole('button', { name: /buy milk/ })).toBeNull())
    expect(view.queryByRole('button', { name: /^Archive/ })).toBeNull()
    await view.unmount()
  })

  it('deletes an emptied draft on Convert instead of resurrecting the text', async () => {
    seed(NOTE, '+ [ ] keep\n+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.clear(view.getByRole('textbox', { name: 'Task text' }))
    await user.click(view.getByRole('button', { name: 'Convert to bullet' }))

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] keep\n'))
    expect(harness.writes).toHaveLength(1)
    await view.unmount()
  })

  it('keeps open tasks visible while the archived history is still loading', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    seed(NOTE, '+ [ ] still open\n')
    getCompletedTasks.mockReturnValue(new Promise<Task[]>(() => {}))
    const view = await renderScreen()

    // The open groups render; the pending completed query must not blank them.
    await view.findByText('still open')
    expect(view.queryByLabelText('Loading tasks')).toBeNull()
    await view.unmount()
  })

  it('opens the source note from the sheet', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'Open note' }))

    expect(view.getByTestId('route').element().textContent).toContain('notes/n.md')
    await view.unmount()
  })

  it('drops an untouched new task when Open note ends its edit', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await view.findByText('buy milk')
    await user.click(view.getByRole('button', { name: 'New task' }))
    await view.findByRole('button', { name: 'Edit: Empty task' })
    await user.click(view.getByRole('button', { name: 'Open note' }))

    // One rule everywhere: ending an edit on an empty new task removes it
    // without touching the note, and the note still opens.
    expect(view.getByTestId('route').element().textContent).toBe(
      '{"kind":"daily","date":"2026-06-14"}',
    )
    await waitFor(() => expect(view.queryByRole('button', { name: 'Edit: Empty task' })).toBeNull())
    await harness.store.flush()
    expect(harness.writes).toHaveLength(0)
    expect(harness.notes.has(TODAY_DAILY)).toBe(false)
    await view.unmount()
  })

  it('deletes from the sheet', async () => {
    seed(NOTE, '+ [ ] keep\n+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] keep\n'))
    await waitFor(() => expect(view.queryByRole('button', { name: 'Edit: buy milk' })).toBeNull())
    expect(view.queryByText('dismiss-drawer')).toBeNull()
    await view.unmount()
  })

  it('adds a task to today’s daily from the Current group and opens its sheet', async () => {
    seedDaily('2026-06-14', '+ [ ] jotted today\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Add a task to today' }))

    // The new (empty) task's quick-edit sheet opens to type into, and its row
    // is already in the Current group.
    const input = asTextArea(await view.findByRole('textbox', { name: 'Task text' }))
    expect(input.value).toBe('')
    view.getByRole('button', { name: 'Edit: Empty task' })
    expect(harness.writes).toHaveLength(0)

    await user.type(input, 'new thing')
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))
    await waitFor(() =>
      expect(harness.notes.get(TODAY_DAILY)).toBe('+ [ ] jotted today\n+ [ ] new thing\n'),
    )
    expect(harness.writes).toHaveLength(1)
    await view.findByRole('button', { name: 'Edit: new thing' })
    await view.unmount()
  })

  it('adds a task to today’s daily from the floating plus button', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await view.findByText('buy milk')
    await user.click(view.getByRole('button', { name: 'New task' }))

    const input = asTextArea(await view.findByRole('textbox', { name: 'Task text' }))
    expect(input.value).toBe('')
    await view.findByText('Current')
    view.getByRole('button', { name: 'Edit: Empty task' })

    await user.type(input, 'new thing')
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))
    await waitFor(() => expect(harness.notes.get(TODAY_DAILY)).toBe('+ [ ] new thing\n'))
    await view.unmount()
  })

  it('focuses the editor when "+" adds a new task', async () => {
    seedDaily('2026-06-14', '+ [ ] jotted today\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Add a task to today' }))
    await view.findByRole('textbox', { name: 'Task text' })

    // The new task is empty: typing is the next step, so the keyboard rises.
    await waitFor(() => expect(editorProbe.focusCalls).toBeGreaterThan(0))
    await view.unmount()
  })

  it('leaves focus alone when a row tap opens the sheet', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    view.getByRole('textbox', { name: 'Task text' })

    // A row tap is usually after an action button; the keyboard would bury them.
    expect(editorProbe.focusCalls).toBe(0)
    await view.unmount()
  })

  it('commits the draft before a wiki link inside it navigates', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    const input = view.getByRole('textbox', { name: 'Task text' })
    await user.clear(input)
    await user.type(input, 'buy oat milk')
    await user.click(view.getByRole('button', { name: 'fake-wikilink' }))

    // Commit-then-navigate, like "Open note": the edit lands exactly once, and
    // the resolved target opens.
    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] buy oat milk\n'))
    await waitFor(() =>
      expect(view.getByTestId('route').element().textContent).toContain('notes/other.md'),
    )
    await harness.store.flush()
    expect(harness.writes).toHaveLength(1)
    await view.unmount()
  })

  it('abandoning a "+"-added task drops it instead of ghosting an empty row', async () => {
    seedDaily('2026-06-14', '+ [ ] jotted today\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Add a task to today' }))
    await view.findByRole('textbox', { name: 'Task text' })
    view.getByRole('button', { name: 'Edit: Empty task' })
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    await waitFor(() => expect(view.queryByRole('button', { name: 'Edit: Empty task' })).toBeNull())
    await harness.store.flush()
    expect(harness.writes).toHaveLength(0)
    expect(harness.notes.get(TODAY_DAILY)).toBe('+ [ ] jotted today\n')
    await view.unmount()
  })

  it('flushes an edited draft when the screen unmounts under an open sheet', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    const input = view.getByRole('textbox', { name: 'Task text' })
    await user.clear(input)
    await user.type(input, 'buy oat milk')

    // A tab switch unmounts the whole screen: no dismissal callback fires.
    await view.unmount()

    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] buy oat milk\n'))
    expect(harness.writes).toHaveLength(1)
  })

  it('drops an abandoned "+"-added task when the screen unmounts', async () => {
    seedDaily('2026-06-14', '+ [ ] jotted today\n')
    const user = userEvent
    const view = await renderScreen()

    await user.click(await view.findByRole('button', { name: 'Add a task to today' }))
    await view.findByRole('textbox', { name: 'Task text' })
    await view.unmount()

    await harness.store.flush()
    expect(harness.writes).toHaveLength(0)
    expect(harness.notes.get(TODAY_DAILY)).toBe('+ [ ] jotted today\n')
    expect(harness.store.list(harness.indexed(false)).map((task) => task.text)).toEqual([
      'jotted today',
    ])
  })

  it('hides buckets through the filter sheet', async () => {
    seedDaily('2026-06-14', '+ [ ] jotted today\n')
    seed(NOTE, '+ [ ] undated\n')
    const user = userEvent
    const view = await renderScreen()

    await view.findByText('Current')
    await user.click(view.getByRole('button', { name: 'Task filters' }))
    await user.click(view.getByRole('checkbox', { name: 'Current' }))

    await waitFor(() => expect(view.queryByText('jotted today')).toBeNull())
    view.getByText('undated')
    await view.unmount()
  })

  it('reveals the completed history behind “Show archived”', async () => {
    seed(NOTE, '+ [ ] still open\n+ [x] long done\n')
    const user = userEvent
    const view = await renderScreen()

    await view.findByText('still open')
    expect(view.queryByText('long done')).toBeNull()

    await user.click(view.getByRole('button', { name: 'Task filters' }))
    await user.click(view.getByRole('checkbox', { name: 'Show archived' }))

    await view.findByText('long done')
    await view.unmount()
  })

  it('filters rows by the search text', async () => {
    seed(NOTE, '+ [ ] buy milk\n+ [ ] call mum\n')
    const user = userEvent
    const view = await renderScreen()

    await view.findByText('buy milk')
    const search = view.getByRole('searchbox', { name: 'Search tasks' })
    await user.type(search, 'milk')

    await waitFor(() => expect(view.queryByText('call mum')).toBeNull())
    view.getByText('buy milk')

    await user.click(view.getByRole('button', { name: 'Clear search' }))

    expect((search.element() as HTMLInputElement).value).toBe('')
    expect(document.activeElement).toBe(search.element())
    await view.findByText('call mum')
    await view.unmount()
  })

  it('shows an empty state whose button adds to today’s daily', async () => {
    const user = userEvent
    const view = await renderScreen()

    await view.findByText('No tasks to show')
    await user.click(view.getByRole('button', { name: 'Add a task' }))

    // The new task's row replaces the empty state and its sheet opens.
    await view.findByRole('button', { name: 'Edit: Empty task' })
    const input = asTextArea(await view.findByRole('textbox', { name: 'Task text' }))
    await user.type(input, 'first ever')
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))
    await waitFor(() => expect(harness.notes.get(TODAY_DAILY)).toBe('+ [ ] first ever\n'))
    await view.unmount()
  })

  it('surfaces a failed open-tasks read', async () => {
    getOpenTasks.mockRejectedValue(new Error('no index'))
    const view = await renderScreen()

    await view.findByRole('alert')
    await view.unmount()
  })

  it('reveals note and delete actions with a leftward swipe', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const view = await renderScreen()

    const surface = await revealSwipeActions(view, 'buy milk')

    await expect
      .element(view.getByRole('button', { name: 'Open note: buy milk' }))
      .toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Delete: buy milk' })).toBeInTheDocument()
    expect(translateX(surface)).toBe(-136)
    // The drag's synthetic click was swallowed; the sheet did not open.
    expect(view.queryByText('dismiss-drawer')).toBeNull()
    await view.unmount()
  })

  it('deletes a task from its swipe action without a dialog', async () => {
    seed(NOTE, '+ [ ] keep\n+ [ ] buy milk\n')
    const view = await renderScreen()

    await revealSwipeActions(view, 'buy milk')
    await view.getByRole('button', { name: 'Delete: buy milk' }).click()

    // The row leaves the list at once; the note follows.
    await waitFor(() => expect(view.queryByRole('button', { name: 'Edit: buy milk' })).toBeNull())
    await waitFor(() => expect(harness.notes.get(NOTE)).toBe('+ [ ] keep\n'))
    expect(view.queryByText('dismiss-drawer')).toBeNull()
    await view.unmount()
  })

  it('opens the source note from its swipe action', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const view = await renderScreen()

    await revealSwipeActions(view, 'buy milk')
    await view.getByRole('button', { name: 'Open note: buy milk' }).click()

    await waitFor(() =>
      expect(view.getByTestId('route').element().textContent).toContain('notes/n.md'),
    )
    expect(view.queryByText('dismiss-drawer')).toBeNull()
    await view.unmount()
  })

  it('closes a revealed row on tap instead of opening the sheet', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    const view = await renderScreen()

    await revealSwipeActions(view, 'buy milk')
    await view.getByRole('button', { name: 'Edit: buy milk' }).click()

    await waitFor(() => expect(view.queryByRole('button', { name: 'Delete: buy milk' })).toBeNull())
    expect(view.queryByText('dismiss-drawer')).toBeNull()
    await view.unmount()
  })

  it('reveals one row at a time across groups', async () => {
    seed(NOTE, '+ [ ] buy milk\n')
    seed('notes/dog.md', '+ [ ] walk dog\n', { noteTitle: 'Dog' })
    const view = await renderScreen()

    await revealSwipeActions(view, 'buy milk')
    await revealSwipeActions(view, 'walk dog')

    await expect.element(view.getByRole('button', { name: 'Delete: walk dog' })).toBeInTheDocument()
    await waitFor(() => expect(view.queryByRole('button', { name: 'Delete: buy milk' })).toBeNull())
    await view.unmount()
  })
})
