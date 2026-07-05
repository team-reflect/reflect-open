import { type ReactNode } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenTask } from '@reflect/core'
import { resetRecentlyCompleted } from '@/lib/tasks/recently-completed'
import { RouterProvider, useRouter } from '@/routing/router'
import { MobileTasks } from './tasks'

/**
 * The mobile Tasks tab (V1 mobile's third tab over Plan 18 data): desktop's
 * groups and guarded write-backs with a touch surface — checkbox toggles,
 * the quick-edit sheet (edit / schedule / complete / convert / open note /
 * delete), the filter sheet, and "+" add. The core getters and the note-task
 * write layer are mocked, like the desktop screen's tests; the sheet's markdown
 * editor is a textarea stand-in (jsdom can't mount ProseKit); grouping/merge
 * rules are unit-tested in task-visibility.test.ts.
 */

const getOpenTasks = vi.hoisted(() => vi.fn())
const getCompletedTasks = vi.hoisted(() => vi.fn())
const resolveWikiTarget = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getOpenTasks,
  getCompletedTasks,
  resolveWikiTarget,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/lib/use-today', () => ({ useToday: () => '2026-06-14' }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      dateFormat: 'mdy',
      weekStartDay: 'monday',
      editorMarkdownSyntax: 'hide',
      editorSpellCheck: false,
    },
  }),
}))
// TaskText renders through meowdown's MarkdownView, which jsdom can't mount.
vi.mock('@/editor/markdown-preview', () => ({
  MarkdownPreview: ({ content, className }: { content: string; className?: string }) => (
    <span data-testid="markdown-preview" className={className}>
      {content}
    </span>
  ),
}))
// The autocomplete hook reads the contacts authorization over IPC; the menus
// themselves live inside meowdown, which is stubbed out below anyway.
vi.mock('@/editor/use-editor-autocomplete', () => ({
  useEditorAutocomplete: () => ({
    onWikilinkSearch: async () => [],
    onTagSearch: async () => [],
  }),
}))

const editorProbe = vi.hoisted(() => ({ focusCalls: 0 }))

// The sheet hosts the real markdown editor (desktop's inline task-editor
// surface), which mounts ProseKit — jsdom can't render it. This stand-in is a
// textarea over the same NoteEditor contract: uncontrolled seed from
// `initialContent`, `onChange` with the markdown, a **silent** `setMarkdown`
// (no onChange echo, matching meowdown), plus probes for focus and wiki-link
// clicks. Children (the Enter keymap) need the ProseKit context, so they are
// not rendered.
vi.mock('@/editor/note-editor', async () => {
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
      onWikiLinkClick?: (target: string) => void
      handleRef?: (handle: import('@/editor/note-editor').NoteEditorHandle | null) => void
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
          getSelectedText: () => '',
          openSelectionMenu: () => {},
          startPendingReplacement: () => false,
          appendPendingReplacementText: () => {},
          acceptPendingReplacement: () => {},
          discardPendingReplacement: () => {},
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
            <button type="button" onClick={() => onWikiLinkClick('Other Note')}>
              fake-wikilink
            </button>
          ) : null}
        </>
      )
    },
  }
})

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

const fail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail })))
vi.mock('@/lib/operations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operations')>()),
  startOperation,
}))

// vaul needs browser APIs jsdom doesn't provide (matchMedia, pointer capture);
// its drag/animation is verified on-device. This passthrough honours `open` and
// exposes the dismissal path as a button, so commit-on-dismiss is testable.
vi.mock('@/components/ui/drawer', () => ({
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
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

function task(overrides: Partial<OpenTask> = {}): OpenTask {
  const text = overrides.text ?? 'do it'
  return {
    notePath: 'notes/n.md',
    markerOffset: 2,
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

/** Narrow a queried element to the editor stub's textarea so `.value` typechecks. */
function asTextArea(element: HTMLElement): HTMLTextAreaElement {
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error('expected a textarea')
  }
  return element
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
        <MobileTasks />
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
  resolveWikiTarget.mockReset()
  resolveWikiTarget.mockResolvedValue({ kind: 'resolved', ref: 'notes/other.md' })
  editorProbe.focusCalls = 0
  resetRecentlyCompleted()
})

afterEach(() => {
  cleanup()
})

describe('MobileTasks', () => {
  it('renders desktop’s groups with counts and source dates', async () => {
    getOpenTasks.mockResolvedValue([
      task({ text: 'jotted today', dailyDate: '2026-06-14', notePath: 'daily/2026-06-14.md', markerOffset: 0 }),
      task({ text: 'late', dueDate: '2026-06-01', dailyDate: '2026-06-01', notePath: 'daily/2026-06-01.md', markerOffset: 0 }),
      task({ text: 'undated', markerOffset: 0 }),
    ])
    const view = renderScreen()

    await view.findByText('Current')
    view.getByText('Overdue')
    // The undated task groups under its source note's title.
    view.getByRole('button', { name: 'N' })
    // Date buckets show the source note's compact date on the row.
    view.getByText('6/1/2026')
    view.unmount()
  })

  it('toggles a task from its checkbox and keeps it struck until archived', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Complete: buy milk' }))

    expect(toggleTask).toHaveBeenCalledTimes(1)
    // V1's middle state: the completed row stays visible, struck, reopenable.
    await view.findByRole('button', { name: 'Reopen: buy milk' })

    // Archive hides this session's completed rows.
    await user.click(view.getByRole('button', { name: 'Archive 1 completed' }))
    await waitFor(() => expect(view.queryByText('buy milk')).toBeNull())
    view.unmount()
  })

  it('commits an edited draft when the quick-edit sheet is dismissed', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    const input = asTextArea(view.getByRole('textbox', { name: 'Task text' }))
    expect(input.value).toBe('buy milk')

    await user.clear(input)
    await user.type(input, 'buy oat milk')
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    expect(editTask).toHaveBeenCalledTimes(1)
    expect(editTask.mock.calls[0]?.[1]).toBe('buy oat milk')
    view.unmount()
  })

  it('does not write when the sheet closes with an untouched draft', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    expect(editTask).not.toHaveBeenCalled()
    expect(deleteTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it('deletes the task when the sheet is dismissed with an emptied draft', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.clear(view.getByRole('textbox', { name: 'Task text' }))
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    expect(deleteTask).toHaveBeenCalledTimes(1)
    expect(editTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it('schedules by editing the draft’s date link, committing one write', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'Tomorrow' }))
    expect(asTextArea(view.getByRole('textbox', { name: 'Task text' })).value).toBe(
      'buy milk [[2026-06-15]]',
    )

    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))
    expect(editTask).toHaveBeenCalledTimes(1)
    expect(editTask.mock.calls[0]?.[1]).toBe('buy milk [[2026-06-15]]')
    view.unmount()
  })

  it('clears the due date from the schedule row', async () => {
    getOpenTasks.mockResolvedValue([
      task({ text: 'late [[2026-06-01]]', raw: '[ ] late [[2026-06-01]]', dueDate: '2026-06-01' }),
    ])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: /^Edit: late/ }))
    await user.click(view.getByRole('button', { name: 'Clear' }))
    expect(asTextArea(view.getByRole('textbox', { name: 'Task text' })).value).toBe('late')
    view.unmount()
  })

  it('completes from the sheet, saving a changed draft first', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    const input = view.getByRole('textbox', { name: 'Task text' })
    await user.clear(input)
    await user.type(input, 'buy oat milk')
    await user.click(view.getByRole('button', { name: 'Complete' }))

    await waitFor(() => expect(editTask).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
    // One write path: dismissal must not commit again after the action closed
    // the sheet.
    expect(editTask).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('commits edits from a sheet re-opened after an action closed it', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    // First visit ends through an action button (Complete), which skips the
    // dismissal commit. The sheet stays mounted for the same task afterwards.
    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'Complete' }))
    await waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))

    // Second visit (the struck row): its edits must still commit on dismiss.
    await user.click(view.getByRole('button', { name: 'Edit: buy milk' }))
    const input = asTextArea(view.getByRole('textbox', { name: 'Task text' }))
    await user.clear(input)
    await user.type(input, 'buy oat milk')
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    expect(editTask).toHaveBeenCalledTimes(1)
    expect(editTask.mock.calls[0]?.[1]).toBe('buy oat milk')
    view.unmount()
  })

  it('converts to a bullet from the sheet', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'Convert to bullet' }))

    await waitFor(() => expect(convertTaskToBullet).toHaveBeenCalledTimes(1))
    view.unmount()
  })

  it('deletes an emptied draft on Complete instead of resurrecting the text', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.clear(view.getByRole('textbox', { name: 'Task text' }))
    await user.click(view.getByRole('button', { name: 'Complete' }))

    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(1))
    expect(toggleTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it('deletes an emptied draft on Convert instead of resurrecting the text', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.clear(view.getByRole('textbox', { name: 'Task text' }))
    await user.click(view.getByRole('button', { name: 'Convert to bullet' }))

    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(1))
    expect(convertTaskToBullet).not.toHaveBeenCalled()
    view.unmount()
  })

  it('keeps open tasks visible while the archived history is still loading', async () => {
    window.sessionStorage.setItem('reflect.tasks.filter.archived', 'true')
    getOpenTasks.mockResolvedValue([task({ text: 'still open' })])
    getCompletedTasks.mockReturnValue(new Promise<OpenTask[]>(() => {}))
    const view = renderScreen()

    // The open groups render; the pending completed query must not blank them.
    await view.findByText('still open')
    expect(view.queryByLabelText('Loading tasks')).toBeNull()
    view.unmount()
  })

  it('opens the source note from the sheet', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'Open note' }))

    expect(view.getByTestId('route').textContent).toContain('notes/n.md')
    view.unmount()
  })

  it('opens the source note of an untouched empty task without deleting it', async () => {
    getOpenTasks.mockResolvedValue([task({ text: '', raw: '[ ] ' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: Empty task' }))
    await user.click(view.getByRole('button', { name: 'Open note' }))

    // Navigates to the line's note — deleting it out from under the visit
    // would be wrong; only dismissal treats an abandoned empty row as delete.
    expect(view.getByTestId('route').textContent).toContain('notes/n.md')
    expect(deleteTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it('deletes from the sheet', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    await user.click(view.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(1))
    view.unmount()
  })

  it('adds a task to today’s daily from the Current group and opens its sheet', async () => {
    getOpenTasks.mockResolvedValue([
      task({ text: 'jotted today', dailyDate: '2026-06-14', notePath: 'daily/2026-06-14.md' }),
    ])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Add a task to today' }))

    await waitFor(() => expect(insertTask).toHaveBeenCalledWith('daily/2026-06-14.md', 1))
    // The new (empty) task's quick-edit sheet opens to type into.
    const input = asTextArea(await view.findByRole('textbox', { name: 'Task text' }))
    expect(input.value).toBe('')

    await user.type(input, 'new thing')
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))
    expect(editTask).toHaveBeenCalledTimes(1)
    expect(editTask.mock.calls[0]?.[1]).toBe('new thing')
    view.unmount()
  })

  it('adds a task to today’s daily from the floating plus button', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await view.findByText('buy milk')
    await user.click(view.getByRole('button', { name: 'New task' }))

    await waitFor(() => expect(insertTask).toHaveBeenCalledWith('daily/2026-06-14.md', 1))
    const input = asTextArea(await view.findByRole('textbox', { name: 'Task text' }))
    expect(input.value).toBe('')
    view.unmount()
  })

  it('focuses the editor when "+" adds a new task', async () => {
    getOpenTasks.mockResolvedValue([
      task({ text: 'jotted today', dailyDate: '2026-06-14', notePath: 'daily/2026-06-14.md' }),
    ])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Add a task to today' }))
    await view.findByRole('textbox', { name: 'Task text' })

    // The new task is empty — typing is the next step, so the keyboard rises.
    await waitFor(() => expect(editorProbe.focusCalls).toBeGreaterThan(0))
    view.unmount()
  })

  it('leaves focus alone when a row tap opens the sheet', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    view.getByRole('textbox', { name: 'Task text' })

    // A row tap is usually after an action button — the keyboard would bury them.
    expect(editorProbe.focusCalls).toBe(0)
    view.unmount()
  })

  it('commits the draft before a wiki link inside it navigates', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    const input = view.getByRole('textbox', { name: 'Task text' })
    await user.clear(input)
    await user.type(input, 'buy oat milk')
    await user.click(view.getByRole('button', { name: 'fake-wikilink' }))

    // Commit-then-navigate, like "Open note": the edit lands exactly once, and
    // the resolved target opens.
    expect(editTask).toHaveBeenCalledTimes(1)
    expect(editTask.mock.calls[0]?.[1]).toBe('buy oat milk')
    await waitFor(() =>
      expect(view.getByTestId('route').textContent).toContain('notes/other.md'),
    )
    view.unmount()
  })

  it('abandoning a "+"-added task deletes it instead of ghosting an empty row', async () => {
    getOpenTasks.mockResolvedValue([
      task({ text: 'jotted today', dailyDate: '2026-06-14', notePath: 'daily/2026-06-14.md' }),
    ])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Add a task to today' }))
    await view.findByRole('textbox', { name: 'Task text' })
    await user.click(view.getByRole('button', { name: 'dismiss-drawer' }))

    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(1))
    expect(editTask).not.toHaveBeenCalled()
    view.unmount()
  })

  it('flushes an edited draft when the screen unmounts under an open sheet', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'buy milk' })])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Edit: buy milk' }))
    const input = view.getByRole('textbox', { name: 'Task text' })
    await user.clear(input)
    await user.type(input, 'buy oat milk')

    // A tab switch unmounts the whole screen — no dismissal callback fires.
    view.unmount()

    await waitFor(() => expect(editTask).toHaveBeenCalledTimes(1))
    expect(editTask.mock.calls[0]?.[1]).toBe('buy oat milk')
  })

  it('deletes an abandoned "+"-added task when the screen unmounts', async () => {
    getOpenTasks.mockResolvedValue([
      task({ text: 'jotted today', dailyDate: '2026-06-14', notePath: 'daily/2026-06-14.md' }),
    ])
    const user = userEvent.setup()
    const view = renderScreen()

    await user.click(await view.findByRole('button', { name: 'Add a task to today' }))
    await view.findByRole('textbox', { name: 'Task text' })
    view.unmount()

    await waitFor(() => expect(deleteTask).toHaveBeenCalledTimes(1))
    expect(editTask).not.toHaveBeenCalled()
  })

  it('hides buckets through the filter sheet', async () => {
    getOpenTasks.mockResolvedValue([
      task({ text: 'jotted today', dailyDate: '2026-06-14', notePath: 'daily/2026-06-14.md' }),
      task({ text: 'undated' }),
    ])
    const user = userEvent.setup()
    const view = renderScreen()

    await view.findByText('Current')
    await user.click(view.getByRole('button', { name: 'Task filters' }))
    await user.click(view.getByRole('checkbox', { name: 'Current' }))

    await waitFor(() => expect(view.queryByText('jotted today')).toBeNull())
    view.getByText('undated')
    view.unmount()
  })

  it('reveals the completed history behind “Show archived”', async () => {
    getOpenTasks.mockResolvedValue([task({ text: 'still open' })])
    getCompletedTasks.mockResolvedValue([
      task({ text: 'long done', markerOffset: 40, checked: true, raw: '[x] long done' }),
    ])
    const user = userEvent.setup()
    const view = renderScreen()

    await view.findByText('still open')
    expect(view.queryByText('long done')).toBeNull()

    await user.click(view.getByRole('button', { name: 'Task filters' }))
    await user.click(view.getByRole('checkbox', { name: 'Show archived' }))

    await view.findByText('long done')
    view.unmount()
  })

  it('filters rows by the search text', async () => {
    getOpenTasks.mockResolvedValue([
      task({ text: 'buy milk', markerOffset: 0 }),
      task({ text: 'call mum', markerOffset: 10 }),
    ])
    const user = userEvent.setup()
    const view = renderScreen()

    await view.findByText('buy milk')
    await user.type(view.getByRole('searchbox', { name: 'Search tasks' }), 'milk')

    await waitFor(() => expect(view.queryByText('call mum')).toBeNull())
    view.getByText('buy milk')
    view.unmount()
  })

  it('shows an empty state whose button adds to today’s daily', async () => {
    getOpenTasks.mockResolvedValue([])
    const user = userEvent.setup()
    const view = renderScreen()

    await view.findByText('No tasks to show')
    await user.click(view.getByRole('button', { name: 'Add a task' }))

    await waitFor(() => expect(insertTask).toHaveBeenCalledWith('daily/2026-06-14.md', 1))
    view.unmount()
  })

  it('surfaces a failed open-tasks read', async () => {
    getOpenTasks.mockRejectedValue(new Error('no index'))
    const view = renderScreen()

    await view.findByRole('alert')
    view.unmount()
  })
})
