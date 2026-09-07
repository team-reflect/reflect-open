import type { ChatNoteChange } from '@reflect/core'
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { ChatChangeSummary } from './chat-change-summary'

const surface = vi.hoisted(() => ({ mobile: false }))
const navigateNote = vi.hoisted(() => vi.fn())

vi.mock('@/lib/platform-surface', () => ({ isMobileSurface: () => surface.mobile }))
vi.mock('@/hooks/use-note-link-navigation', () => ({
  useNoteLinkNavigation: () => navigateNote,
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open === true ? <>{children}</> : null,
  DialogContent: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('@/components/ui/drawer', () => ({
  Drawer: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open === true ? <>{children}</> : null,
  DrawerContent: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div role="dialog" data-testid="review-drawer" className={className}>
      {children}
    </div>
  ),
  DrawerDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))

function change(overrides: Partial<ChatNoteChange> = {}): ChatNoteChange {
  return {
    id: 'change-1',
    conversationId: 'conversation-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    path: 'notes/project.md',
    sequence: 0,
    operation: 'edit',
    beforeSource: '# Project\n\nBefore\n',
    afterSource: '# Project\n\nAfter\n',
    beforeRevision: 'a'.repeat(64),
    afterRevision: 'b'.repeat(64),
    state: 'applied',
    errorMessage: null,
    createdMs: 1,
    updatedMs: 2,
    ...overrides,
  }
}

function SummaryHarness({
  changes,
  onUndoTurn,
  onUndoPath,
}: {
  changes: readonly ChatNoteChange[]
  onUndoTurn: () => Promise<void>
  onUndoPath: (path: string) => Promise<void>
}): ReactElement {
  return <ChatChangeSummary changes={changes} onUndoTurn={onUndoTurn} onUndoPath={onUndoPath} />
}

beforeEach(() => {
  surface.mobile = false
  navigateNote.mockReset()
})

describe('ChatChangeSummary', () => {
  it('shows a turn summary, desktop diff review, and both guarded Undo actions', async () => {
    const onUndoTurn = vi.fn(async () => {})
    const onUndoPath = vi.fn(async () => {})
    const view = await render(
      <SummaryHarness changes={[change()]} onUndoTurn={onUndoTurn} onUndoPath={onUndoPath} />,
    )

    await expect.element(view.getByText(/Changed 1 note · \+1 −1/)).toBeInTheDocument()
    await view.getByRole('button', { name: 'Undo' }).click()
    expect(onUndoTurn).toHaveBeenCalledOnce()

    await view.getByRole('button', { name: 'Review' }).click()
    const dialog = view.getByRole('dialog')
    await expect.element(dialog.getByRole('heading', { name: 'Note changes' })).toBeVisible()
    await expect
      .element(dialog.getByLabelText('Changes to notes/project.md'))
      .toHaveTextContent('-Before')
    await expect
      .element(dialog.getByLabelText('Changes to notes/project.md'))
      .toHaveTextContent('+After')
    await dialog.getByRole('button', { name: 'Undo changes to Project' }).click()
    expect(onUndoPath).toHaveBeenCalledWith('notes/project.md')
  })

  it('keeps an undone diff visible without offering another mutation action', async () => {
    const view = await render(
      <SummaryHarness
        changes={[change({ state: 'undone' })]}
        onUndoTurn={async () => {}}
        onUndoPath={async () => {}}
      />,
    )

    await expect.element(view.getByText('Undid changes to 1 note')).toBeVisible()
    expect(view.getByRole('button', { name: 'Undo' }).query()).toBeNull()
    await view.getByRole('button', { name: 'Review' }).click()
    await expect.element(view.getByText('Undone')).toBeVisible()
    await expect.element(view.getByLabelText('Changes to notes/project.md')).toBeVisible()
  })

  it('uses the full-height mobile review drawer', async () => {
    surface.mobile = true
    const view = await render(
      <SummaryHarness
        changes={[change()]}
        onUndoTurn={async () => {}}
        onUndoPath={async () => {}}
      />,
    )

    await view.getByRole('button', { name: 'Review' }).click()
    await expect
      .element(view.getByTestId('review-drawer'))
      .toHaveClass('[--drawer-content-height:100dvh]')
    await expect
      .element(view.getByTestId('review-drawer'))
      .toHaveClass('[--drawer-content-max-height:100dvh]')
    await expect.element(view.getByLabelText('Changes to notes/project.md')).toBeVisible()
  })

  it('opens Review with the exact stale-note error after whole-turn Undo is refused', async () => {
    const view = await render(
      <SummaryHarness
        changes={[change()]}
        onUndoTurn={async () => {
          throw new Error('notes/project.md: The note changed after the AI edit.')
        }}
        onUndoPath={async () => {}}
      />,
    )

    await view.getByRole('button', { name: 'Undo' }).click()
    await expect.element(view.getByRole('dialog')).toBeVisible()
    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('notes/project.md: The note changed after the AI edit.')
    await expect
      .element(view.getByRole('dialog').getByRole('button', { name: 'Undo changes to Project' }))
      .toBeVisible()
  })

  it('surfaces uncertain recovery and keeps its checkpoint available for review', async () => {
    const view = await render(
      <SummaryHarness
        changes={[change({ state: 'uncertain' })]}
        onUndoTurn={async () => {}}
        onUndoPath={async () => {}}
      />,
    )

    await expect.element(view.getByText(/Review needed for 1 note · \+1 −1/)).toBeVisible()
    expect(view.getByRole('button', { name: 'Undo' }).query()).toBeNull()
    await view.getByRole('button', { name: 'Review' }).click()
    await expect.element(view.getByText('Review needed', { exact: true })).toBeVisible()
    await expect.element(view.getByLabelText('Changes to notes/project.md')).toBeVisible()
  })

  it('collapses generated frontmatter but lets the user reveal the full creation metadata', async () => {
    const created = change({
      operation: 'create',
      path: 'notes/launch-notes.md',
      beforeSource: null,
      beforeRevision: null,
      afterSource: '---\nid: 01abc\n---\n# Launch notes\n',
    })
    const view = await render(
      <SummaryHarness
        changes={[created]}
        onUndoTurn={async () => {}}
        onUndoPath={async () => {}}
      />,
    )

    await view.getByRole('button', { name: 'Review' }).click()
    const metadata = view.getByText('Generated note metadata')
    expect(metadata.element().closest('details')?.open).toBe(false)
    await metadata.click()
    await expect
      .element(view.getByLabelText('Generated metadata for notes/launch-notes.md'))
      .toHaveTextContent('+id: 01abc')
  })
})
