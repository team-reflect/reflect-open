import { act, useState, type ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NoteRowList } from './note-row-list'
import { SwipeableNoteRow, type NoteRowModel } from './swipeable-note-row'

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy', timeFormat: '12h' } }),
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/mobile/use-reduced-motion', () => ({ usePrefersReducedMotion: () => true }))

const onOpen = vi.fn()
const onTogglePin = vi.fn()
const onDelete = vi.fn()

function row(overrides: Partial<NoteRowModel> = {}): NoteRowModel {
  return {
    path: 'notes/alpha.md',
    titleSegments: [{ text: 'Alpha', highlighted: false }],
    mtime: new Date(2020, 0, 1).getTime(),
    isPinned: false,
    canDelete: true,
    snippet: [{ text: 'First line', highlighted: false }],
    ...overrides,
  }
}

function SwipeHarness({ note = row() }: { note?: NoteRowModel }): ReactElement {
  const [revealed, setRevealed] = useState(false)
  return (
    <div style={{ width: 360 }}>
      <SwipeableNoteRow
        row={note}
        revealed={revealed}
        onReveal={() => setRevealed(true)}
        onClose={() => setRevealed(false)}
        onBeginInteraction={() => {}}
        onOpen={onOpen}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
    </div>
  )
}

function pointer(
  node: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
): void {
  act(() => {
    node.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        isPrimary: true,
        pointerId: 1,
        clientX,
        clientY,
      }),
    )
  })
}

function swipe(
  surface: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
): void {
  pointer(surface, 'pointerdown', from.x, from.y)
  pointer(surface, 'pointermove', to.x, to.y)
  pointer(surface, 'pointerup', to.x, to.y)
  // A real touch sequence synthesizes a click after pointerup; dispatchEvent
  // does not, so mirror it to exercise the row's drag-click suppression.
  const touchSurface = surface as HTMLElement
  touchSurface.click()
}

function translateX(element: Element): number {
  return new DOMMatrixReadOnly(getComputedStyle(element).transform).m41
}

beforeEach(() => {
  onOpen.mockReset()
  onTogglePin.mockReset()
  onDelete.mockReset()
})

describe('NoteRowList', () => {
  it('renders title search matches with the snippet highlight treatment', async () => {
    const row: NoteRowModel = {
      path: 'notes/tim-maccaw.md',
      titleSegments: [
        { text: 'Tim Mac', highlighted: true },
        { text: 'Caw', highlighted: false },
      ],
      mtime: new Date(2020, 0, 1).getTime(),
      isPinned: false,
      canDelete: true,
      snippet: [],
    }

    const view = await render(<NoteRowList rows={[row]} onOpen={() => {}} onDeleted={() => {}} />)
    const match = view.getByText('Tim Mac')

    await expect.element(match).toBeInTheDocument()
    await vi.waitFor(() => expect(match.element().tagName).toBe('MARK'))
    await expect.element(match).toHaveClass('bg-primary/15')
    await expect.element(view.getByRole('button')).toHaveTextContent('Tim MacCaw')
  })

  it('tracks a leftward touch and reveals pin and delete actions', async () => {
    const view = await render(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()

    swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 32 },
      { x: rect.right - 120, y: rect.top + 32 },
    )

    await expect.element(view.getByRole('button', { name: 'Pin Alpha' })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Delete Alpha' })).toBeInTheDocument()
    expect(translateX(surface)).toBe(-136)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('leaves vertical scrolling in control and keeps the actions closed', async () => {
    const view = await render(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()

    swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 12 },
      { x: rect.right - 22, y: rect.top + 52 },
    )

    expect(view.getByRole('button', { name: 'Delete Alpha' }).query()).toBeNull()
    expect(translateX(surface)).toBe(0)
  })

  it('closes an open row when its note surface is tapped', async () => {
    const view = await render(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()

    swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 32 },
      { x: rect.right - 120, y: rect.top + 32 },
    )
    await view.getByRole('button', { name: /Alpha.*First line/ }).click()

    await vi.waitFor(() => {
      expect(view.getByRole('button', { name: 'Delete Alpha' }).query()).toBeNull()
    })
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('runs the revealed delete action without opening the note', async () => {
    const view = await render(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()
    swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 32 },
      { x: rect.right - 120, y: rect.top + 32 },
    )

    await view.getByRole('button', { name: 'Delete Alpha' }).click()

    expect(onDelete).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does not offer delete for a daily note', async () => {
    const view = await render(
      <SwipeHarness note={row({ path: 'daily/2026-08-15.md', canDelete: false })} />,
    )
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()
    swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 32 },
      { x: rect.right - 90, y: rect.top + 32 },
    )

    await expect.element(view.getByRole('button', { name: 'Pin Alpha' })).toBeInTheDocument()
    expect(view.getByRole('button', { name: 'Delete Alpha' }).query()).toBeNull()
  })

  it('recovers when a pre-threshold touch is abandoned outside the row', async () => {
    const view = await render(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()

    // No move/up reaches the row for this first armed touch.
    pointer(surface, 'pointerdown', rect.right - 20, rect.top + 32)
    swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 32 },
      { x: rect.right - 120, y: rect.top + 32 },
    )

    await expect.element(view.getByRole('button', { name: 'Delete Alpha' })).toBeInTheDocument()
  })
})
