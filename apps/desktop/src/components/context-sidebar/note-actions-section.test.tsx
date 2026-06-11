import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteActionsSection } from './note-actions-section'

const getPinnedNotes = vi.hoisted(() => vi.fn())
const toggleNotePinned = vi.hoisted(() => vi.fn(async () => true))
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({ progress: vi.fn(), done: vi.fn(), fail: operationFail })),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getPinnedNotes,
}))
vi.mock('@/lib/note-pin', () => ({ toggleNotePinned }))
vi.mock('@/lib/operations', () => ({ startOperation }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 7 } }),
}))

function renderSection(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <NoteActionsSection path={path} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  getPinnedNotes.mockReset().mockResolvedValue([])
  toggleNotePinned.mockReset().mockResolvedValue(true)
  startOperation.mockClear()
  operationFail.mockClear()
})

describe('NoteActionsSection pin toggle', () => {
  it('offers Pin this note with the platform-formatted hint and toggles on click', async () => {
    const view = renderSection('notes/a.md')
    const button = view.getByRole('button', { name: /Pin this note/ })
    // jsdom reports a non-Apple platform, so Mod renders as Ctrl.
    expect(button.textContent).toContain('CtrlO')
    await userEvent.click(button)
    expect(toggleNotePinned).toHaveBeenCalledWith('notes/a.md', 7)
    view.unmount()
  })

  it('offers Un-pin this note when the index lists the note as pinned', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'daily/2026-06-10.md', title: 'June 10th, 2026', dailyDate: '2026-06-10' }])
    const view = renderSection('daily/2026-06-10.md')
    await view.findByText('Un-pin this note')
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(toggleNotePinned).toHaveBeenCalledWith('daily/2026-06-10.md', 7)
    view.unmount()
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    // The index still reports unpinned; the toggle's resolved state bridges
    // the watcher round-trip so a second click can't invert the user's intent.
    expect(await view.findByText('Un-pin this note')).toBeDefined()
    toggleNotePinned.mockResolvedValueOnce(false)
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(await view.findByText('Pin this note')).toBeDefined()
    expect(toggleNotePinned).toHaveBeenCalledTimes(2)
    view.unmount()
  })

  it('stays on Pin this note when a different note is pinned', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'notes/other.md', title: 'Other', dailyDate: null }])
    const view = renderSection('notes/a.md')
    await waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())
    expect(view.getByText('Pin this note')).toBeDefined()
    expect(view.queryByText('Un-pin this note')).toBeNull()
    view.unmount()
  })

  it('surfaces a toggle failure through the operations status', async () => {
    toggleNotePinned.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    expect(startOperation).toHaveBeenCalledWith('Pinning note')
    expect(operationFail).toHaveBeenCalled()
    view.unmount()
  })

  it('labels a failed unpin as unpinning', async () => {
    getPinnedNotes.mockResolvedValue([{ path: 'notes/a.md', title: 'A', dailyDate: null }])
    toggleNotePinned.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = renderSection('notes/a.md')
    await userEvent.click(await view.findByRole('button', { name: /Un-pin this note/ }))
    expect(startOperation).toHaveBeenCalledWith('Unpinning note')
    expect(operationFail).toHaveBeenCalled()
    view.unmount()
  })
})
