import { act, type ReactNode } from 'react'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge, type GraphInfo } from '@reflect/core'
import { NoteActionsMenu } from './note-actions-menu'

/**
 * The note-actions sheet (Plan 19): pin toggles the frontmatter flag, and
 * delete confirms then moves the note to trash and notifies the screen. Runs
 * the real toggle/delete core paths over a fake IPC bridge.
 *
 * The drawer wrapper needs browser APIs jsdom doesn't provide
 * (matchMedia, pointer capture); its drag/animation is verified on-device.
 * Here it's mocked to a passthrough so the action rows are always rendered and
 * the test can exercise the IPC side effects directly.
 */

vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  DrawerContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

const graphStore = vi.hoisted(() => {
  let graph: GraphInfo | null = { root: '/g', name: 'g', generation: 1 }
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
// The pinned set comes from the index; an empty list means "not pinned".
vi.mock('@/hooks/use-pinned-notes', () => ({ usePinnedNotes: () => [] }))
// No session is open for the note in this unit; discard is a no-op lookup.
vi.mock('@/editor/open-documents', () => ({ openSession: () => null }))

const calls: Array<{ command: string; args: Record<string, unknown> }> = []
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

setBridge({ invoke: mockInvoke, listen: async () => () => {} })

beforeEach(() => {
  graphStore.set({ root: '/g', name: 'g', generation: 1 })
  calls.length = 0
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    calls.push({ command, args })
    if (command === 'note_read') {
      return '# Meeting\n'
    }
    return null
  })
})

async function mount(onDeleted = vi.fn()): Promise<{
  view: Awaited<ReturnType<typeof render>>
  onDeleted: typeof onDeleted
}> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
    <QueryClientProvider client={queryClient}>
      <NoteActionsMenu path="notes/meeting.md" onDeleted={onDeleted} />
    </QueryClientProvider>,
  )
  return { view, onDeleted }
}

describe('NoteActionsMenu', () => {
  it('pins the note by writing the frontmatter flag', async () => {
    const { view } = await mount()

    await view.getByRole('button', { name: 'Pin' }).click()

    await vi.waitFor(() => {
      const write = calls.find((call) => call.command === 'note_write')
      expect(write?.args['contents']).toContain('pinned: true')
    })
  })

  it('deletes after confirmation and notifies the screen', async () => {
    const { view, onDeleted } = await mount()

    await view.getByRole('button', { name: 'Delete' }).click()
    // A second "Delete" appears in the confirm dialog; scope to it.
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Delete' }).click()

    await vi.waitFor(() => {
      expect(calls.some((call) => call.command === 'note_delete')).toBe(true)
    })
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('reports when the graph disappears before delete confirmation', async () => {
    const { view, onDeleted } = await mount()

    await view.getByRole('button', { name: 'Delete' }).click()
    const dialog = page.getByRole('dialog')
    act(() => graphStore.set(null))
    await dialog.getByRole('button', { name: 'Delete' }).click()

    await expect.element(dialog.getByText('No graph is open.')).toBeInTheDocument()
    expect(calls.some((call) => call.command === 'note_delete')).toBe(false)
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
