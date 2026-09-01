import { act, type ReactElement, type ReactNode } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'

const useNoteRowState = vi.hoisted(() => vi.fn())
const usePinnedNotes = vi.hoisted(() => vi.fn())
const toggleNotePinned = vi.hoisted(() => vi.fn(async () => true))
const toggleNotePrivate = vi.hoisted(() => vi.fn(async () => true))
const deleteOpenNote = vi.hoisted(() => vi.fn(async () => {}))
const shareNote = vi.hoisted(() => vi.fn(async () => {}))
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({
    progress: vi.fn(),
    done: vi.fn(),
    warn: vi.fn(),
    dismiss: vi.fn(),
    fail: operationFail,
  })),
)

/**
 * The mobile note actions drawer: pin/share/delete already live here; this
 * suite adds privacy parity coverage against mocked index state and canonical
 * toggle helpers so close/reopen and failure rollback are exercised directly.
 * Delete routes through the shared {@link NoteDeleteDrawer}; the graph comes
 * from a mutable store so the no-graph failure path can be exercised too.
 *
 * The real drawer's drag/animation is covered elsewhere and on-device. This
 * mock honours `open` and the trigger contract so the tests can verify that
 * actions close the sheet and that reopened content reflects bridged state.
 */
vi.mock('@/components/ui/drawer', async () => {
  const React = await import('react')
  const DrawerContext = React.createContext<{
    open: boolean
    onOpenChange: ((open: boolean) => void) | undefined
  }>({ open: false, onOpenChange: undefined })

  function useDrawerContext() {
    return React.use(DrawerContext)
  }

  return {
    Drawer: ({
      open = false,
      onOpenChange,
      children,
    }: {
      open?: boolean
      onOpenChange?: (open: boolean) => void
      children?: ReactNode
    }) => <DrawerContext value={{ open, onOpenChange }}>{children}</DrawerContext>,
    DrawerTrigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) => {
      const { onOpenChange } = useDrawerContext()
      if (
        render !== undefined &&
        React.isValidElement<{ 'aria-label'?: string; className?: string }>(render)
      ) {
        return (
          <button
            type="button"
            aria-label={render.props['aria-label']}
            className={render.props.className}
            onClick={() => onOpenChange?.(true)}
          >
            {children}
          </button>
        )
      }
      return (
        <button type="button" onClick={() => onOpenChange?.(true)}>
          {children}
        </button>
      )
    },
    DrawerContent: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => {
      const { open } = useDrawerContext()
      return open ? (
        <div role="dialog" data-slot="drawer-content" {...props}>
          {children}
        </div>
      ) : null
    },
    DrawerBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DrawerDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  }
})

const graphStore = vi.hoisted(() => {
  let graph: GraphInfo | null = null
  const listeners = new Set<() => void>()
  return {
    getSnapshot: (): GraphInfo | null => graph,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next: GraphInfo | null): void => {
      graph = next
      for (const listener of listeners) {
        listener()
      }
    },
  }
})
vi.mock('@/providers/graph-provider', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useGraph: () => ({
      graph: useSyncExternalStore(graphStore.subscribe, graphStore.getSnapshot),
    }),
  }
})
vi.mock('@/hooks/use-note-row', () => ({ useNoteRowState }))
vi.mock('@/hooks/use-pinned-notes', () => ({ usePinnedNotes }))
vi.mock('@/lib/note-pin', () => ({ toggleNotePinned }))
vi.mock('@/lib/note-private', () => ({ toggleNotePrivate }))
vi.mock('@/lib/note-delete', () => ({ deleteOpenNote }))
vi.mock('@/mobile/share', () => ({ shareNote }))
vi.mock('@/lib/operations', () => ({ startOperation }))

const { NoteActionsMenu } = await import('./note-actions-menu')

let currentNoteRow: {
  path: string
  title: string
  dailyDate: string | null
  isPrivate: boolean
} | null
let currentNoteRowSettled: boolean
let currentPinnedNotes: Array<{ path: string; title: string; dailyDate: string | null }>

function noteRow(path: string, isPrivate: boolean, title = 'Meeting') {
  return { path, title, dailyDate: null, isPrivate }
}

beforeEach(() => {
  graphStore.set({ root: '/g', name: 'g', generation: 7 })
  currentNoteRow = noteRow('notes/meeting.md', false)
  currentNoteRowSettled = true
  currentPinnedNotes = []
  useNoteRowState.mockImplementation(() => ({
    row: currentNoteRow,
    settled: currentNoteRowSettled,
  }))
  usePinnedNotes.mockImplementation(() => currentPinnedNotes)
  toggleNotePinned.mockReset().mockResolvedValue(true)
  toggleNotePrivate.mockReset().mockResolvedValue(true)
  deleteOpenNote.mockReset().mockResolvedValue(undefined)
  shareNote.mockReset().mockResolvedValue(undefined)
  startOperation.mockClear()
  operationFail.mockClear()
})

afterEach(async () => {
  await cleanup()
})

async function mount(path = 'notes/meeting.md', onDeleted = vi.fn()) {
  const view = await render(<NoteActionsMenu path={path} onDeleted={onDeleted} />)
  return { view, onDeleted }
}

async function openActions(): Promise<void> {
  await page.getByRole('button', { name: 'Note actions' }).click()
}

describe('NoteActionsMenu', () => {
  it('offers Lock note for a public note, toggles canonically, and closes the drawer', async () => {
    const { view } = await mount()

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Lock note' })).toBeInTheDocument()

    await view.getByRole('button', { name: 'Lock note' }).click()

    await vi.waitFor(() => expect(toggleNotePrivate).toHaveBeenCalledWith('notes/meeting.md', 7))
    await expect.element(view.getByRole('button', { name: 'Lock note' })).not.toBeInTheDocument()
  })

  it('offers Unlock note for a private daily note and toggles canonically', async () => {
    currentNoteRow = noteRow('daily/2026-06-10.md', true, 'June 10th, 2026')
    const { view } = await mount('daily/2026-06-10.md')

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Unlock note' })).toBeInTheDocument()

    await view.getByRole('button', { name: 'Unlock note' }).click()

    await vi.waitFor(() => expect(toggleNotePrivate).toHaveBeenCalledWith('daily/2026-06-10.md', 7))
  })

  it('bridges the privacy label from the toggle result while the index is stale', async () => {
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Lock note' }).click()
    await vi.waitFor(() => expect(toggleNotePrivate).toHaveBeenCalledTimes(1))

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Unlock note' })).toBeInTheDocument()

    toggleNotePrivate.mockResolvedValueOnce(false)
    await view.getByRole('button', { name: 'Unlock note' }).click()
    await vi.waitFor(() => expect(toggleNotePrivate).toHaveBeenCalledTimes(2))

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Lock note' })).toBeInTheDocument()
  })

  it('rolls back stale optimistic privacy state and surfaces failures for retry', async () => {
    toggleNotePrivate.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Lock note' }).click()

    await vi.waitFor(() => expect(startOperation).toHaveBeenCalledWith('Locking note'))
    await vi.waitFor(() => expect(operationFail).toHaveBeenCalledWith('disk on fire'))
    await expect.element(view.getByRole('button', { name: 'Lock note' })).not.toBeInTheDocument()

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Lock note' })).toBeInTheDocument()
  })

  it('disables the privacy action until the note row query settles', async () => {
    currentNoteRow = null
    currentNoteRowSettled = false
    const { view } = await mount()

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Loading privacy…' })).toBeDisabled()
    expect(toggleNotePrivate).not.toHaveBeenCalled()
  })

  it('offers Lock note for a visible note with no indexed row yet', async () => {
    currentNoteRow = null
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Lock note' }).click()

    await vi.waitFor(() => expect(toggleNotePrivate).toHaveBeenCalledWith('notes/meeting.md', 7))
  })

  it('keeps the pin action intact and closes the drawer', async () => {
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Pin' }).click()

    await vi.waitFor(() => expect(toggleNotePinned).toHaveBeenCalledWith('notes/meeting.md', 7))
    await expect.element(view.getByRole('button', { name: 'Pin' })).not.toBeInTheDocument()
  })

  it('keeps the share action intact and closes the drawer', async () => {
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Share' }).click()

    await vi.waitFor(() => expect(shareNote).toHaveBeenCalledWith('notes/meeting.md'))
    await expect.element(view.getByRole('button', { name: 'Share' })).not.toBeInTheDocument()
  })

  it('deletes after confirmation and notifies the screen', async () => {
    const { view, onDeleted } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Delete' }).click()

    const dialog = page.getByRole('dialog')
    await expect.element(dialog).toHaveAttribute('data-slot', 'drawer-content')
    await dialog.getByRole('button', { name: 'Delete' }).click()

    await vi.waitFor(() => expect(deleteOpenNote).toHaveBeenCalledWith('notes/meeting.md', 7))
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('reports when the graph disappears before delete confirmation', async () => {
    const { view, onDeleted } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Delete' }).click()

    const dialog = page.getByRole('dialog')
    act(() => graphStore.set(null))
    await dialog.getByRole('button', { name: 'Delete' }).click()

    await expect.element(dialog.getByText('No graph is open.')).toBeInTheDocument()
    expect(deleteOpenNote).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
