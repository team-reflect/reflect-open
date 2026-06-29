import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isApplePlatform } from '@/lib/keybindings'
import { RouterProvider } from '@/routing/router'
import { NoteActionsSection } from './note-actions-section'

const getPinnedNotes = vi.hoisted(() => vi.fn())
const getNote = vi.hoisted(() => vi.fn())
const toggleNotePinned = vi.hoisted(() => vi.fn(async () => true))
const toggleNotePrivate = vi.hoisted(() => vi.fn(async () => true))
const deleteOpenNote = vi.hoisted(() => vi.fn(async () => {}))
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({ progress: vi.fn(), done: vi.fn(), fail: operationFail })),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getPinnedNotes,
  getNote,
}))
vi.mock('@/lib/note-pin', () => ({ toggleNotePinned }))
vi.mock('@/lib/note-private', () => ({ toggleNotePrivate }))
vi.mock('@/lib/note-delete', () => ({ deleteOpenNote }))
vi.mock('@/lib/operations', () => ({ startOperation }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 7 } }),
}))

function renderSection(path: string, showTrash = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <RouterProvider initialRoute={{ kind: 'note', path }}>
          <NoteActionsSection path={path} showTrash={showTrash} />
        </RouterProvider>
      </QueryClientProvider>
    </TooltipProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  getPinnedNotes.mockReset().mockResolvedValue([])
  getNote.mockReset().mockResolvedValue(undefined)
  toggleNotePinned.mockReset().mockResolvedValue(true)
  toggleNotePrivate.mockReset().mockResolvedValue(true)
  deleteOpenNote.mockReset().mockResolvedValue(undefined)
  startOperation.mockClear()
  operationFail.mockClear()
})

function noteRow(path: string, isPrivate: boolean) {
  return { path, title: 'A', dailyDate: null, isPrivate }
}

describe('NoteActionsSection pin toggle', () => {
  it('offers Pin this note with the platform-formatted hint and toggles on click', async () => {
    const view = await renderSection('notes/a.md')
    const button = view.getByRole('button', { name: /Pin this note/ })
    // The hint is platform-formatted: the browser project sees the real
    // platform, so Mod renders as the Apple symbol on macOS and Ctrl elsewhere.
    const modifier = isApplePlatform() ? '⌘' : 'Ctrl'
    expect(button.element().textContent).toContain(`${modifier}O`)
    await userEvent.click(button)
    expect(toggleNotePinned).toHaveBeenCalledWith('notes/a.md', 7)
  })

  it('offers Un-pin this note when the index lists the note as pinned', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'daily/2026-06-10.md', title: 'June 10th, 2026', dailyDate: '2026-06-10' }])
    const view = await renderSection('daily/2026-06-10.md')
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(toggleNotePinned).toHaveBeenCalledWith('daily/2026-06-10.md', 7)
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    // The index still reports unpinned; the toggle's resolved state bridges
    // the watcher round-trip so a second click can't invert the user's intent.
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    toggleNotePinned.mockResolvedValueOnce(false)
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    await expect.element(view.getByText('Pin this note')).toBeInTheDocument()
    expect(toggleNotePinned).toHaveBeenCalledTimes(2)
  })

  it('stays on Pin this note when a different note is pinned', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'notes/other.md', title: 'Other', dailyDate: null }])
    const view = await renderSection('notes/a.md')
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())
    await expect.element(view.getByText('Pin this note')).toBeInTheDocument()
    await expect.element(view.getByText('Un-pin this note')).not.toBeInTheDocument()
  })

  it('surfaces a toggle failure through the operations status', async () => {
    toggleNotePinned.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    expect(startOperation).toHaveBeenCalledWith('Pinning note')
    expect(operationFail).toHaveBeenCalled()
  })

  it('labels a failed unpin as unpinning', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'notes/a.md', title: 'A', dailyDate: null }])
    toggleNotePinned.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(startOperation).toHaveBeenCalledWith('Unpinning note')
    expect(operationFail).toHaveBeenCalled()
  })
})

describe('NoteActionsSection private toggle', () => {
  it('offers Lock note and toggles on click', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    expect(toggleNotePrivate).toHaveBeenCalledWith('notes/a.md', 7)
  })

  it('offers Unlock note when the index reports the note private', async () => {
    getNote.mockResolvedValue(noteRow('daily/2026-06-10.md', true))
    const view = await renderSection('daily/2026-06-10.md')
    await expect.element(view.getByText('Unlock note')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    expect(toggleNotePrivate).toHaveBeenCalledWith('daily/2026-06-10.md', 7)
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    await expect.element(view.getByText('Unlock note')).toBeInTheDocument()
    toggleNotePrivate.mockResolvedValueOnce(false)
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    await expect.element(view.getByText('Lock note')).toBeInTheDocument()
    expect(toggleNotePrivate).toHaveBeenCalledTimes(2)
  })

  it('stays on Lock note for a note the index reports as not private', async () => {
    getNote.mockResolvedValue(noteRow('notes/a.md', false))
    const view = await renderSection('notes/a.md')
    await vi.waitFor(() => expect(getNote).toHaveBeenCalled())
    await expect.element(view.getByText('Lock note')).toBeInTheDocument()
    await expect.element(view.getByText('Unlock note')).not.toBeInTheDocument()
  })

  it('surfaces a toggle failure through the operations status', async () => {
    toggleNotePrivate.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    expect(startOperation).toHaveBeenCalledWith('Locking note')
    expect(operationFail).toHaveBeenCalled()
  })

  it('labels a failed un-mark as un-marking', async () => {
    getNote.mockResolvedValue(noteRow('notes/a.md', true))
    toggleNotePrivate.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    expect(startOperation).toHaveBeenCalledWith('Unlocking note')
    expect(operationFail).toHaveBeenCalled()
  })
})

describe('NoteActionsSection trash action', () => {
  it('does not offer trash unless the note sidebar opts in', async () => {
    const view = await renderSection('notes/a.md')
    await expect.element(view.getByRole('button', { name: 'Trash note' })).not.toBeInTheDocument()
  })

  it('trashes an ordinary note after confirmation', async () => {
    const view = await renderSection('notes/a.md', true)
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))
    // Confirming opens the dialog, which portals a second "Trash note" button
    // (the destructive confirm). Click the last match.
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }).last())
    await vi.waitFor(() => expect(deleteOpenNote).toHaveBeenCalledWith('notes/a.md', 7))
    expect(startOperation).toHaveBeenCalledWith('Trashing note')
  })

  it('does not offer trash for daily notes even if enabled', async () => {
    const view = await renderSection('daily/2026-06-10.md', true)
    await expect.element(view.getByRole('button', { name: 'Trash note' })).not.toBeInTheDocument()
  })
})
