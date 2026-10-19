import {
  isOstensiblyEmptyNoteSource,
  type CoreServices,
  type FilteredSearchHit,
  type NoteDocumentService,
} from '@reflect/core'
import { createTestCoreServices, createTestPlatformService } from '@reflect/core/testing'
import { queryKeys } from '@/lib/query-client.ts'
import { useQuery } from '@tanstack/react-query'
import { useNoteRows } from '@/hooks/note-row-overlay.ts'
import { useState, type ReactElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderInApp, type InAppRenderResult } from '@/test-utils/render-in-app.tsx'
import { pointer, swipe, translateX } from '@/test-utils/swipe.ts'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { NoteRowList } from './note-row-list.tsx'
import { SwipeableNoteRow, type NoteRowModel } from './swipeable-note-row.tsx'

const commitNoteFrontmatter = vi.fn<NoteDocumentService['commitFrontmatter']>()

/**
 * Render `ui` in the graph `/g` with reduced motion, so a swipe settles at once.
 */
function mount(ui: ReactNode): Promise<InAppRenderResult<CoreServices>> {
  const readSource = (): Promise<string> => Promise.resolve('# A\n')
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    platform: createTestPlatformService({ reducedMotion: true }),
    noteDocuments: {
      readSource,
      readExisting: readSource,
      commitFrontmatter: commitNoteFrontmatter,
      commitSourceEdit: () => Promise.reject(new Error('commitSourceEdit is not stubbed')),
      isOstensiblyEmpty: isOstensiblyEmptyNoteSource,
    },
  })
  return renderInApp(ui, {
    app,
    graph: { root: '/g', name: 'g', generation: 1 },
    settings: { dateFormat: 'mdy', timeFormat: '12h' },
  })
}

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

const mobileKey = queryKeys.index.mobileAllNotesWithSearch('/g', { text: '' })

function CachedNoteList(): ReactElement {
  const { data } = useQuery<FilteredSearchHit[]>({
    queryKey: mobileKey,
    queryFn: () => [],
    enabled: false,
  })
  const hits = useNoteRows(data) ?? []
  return <NoteRowList rows={hits.map((hit) => row({ isPinned: hit.isPinned }))} onOpen={onOpen} />
}

beforeEach(() => {
  onOpen.mockReset()
  onTogglePin.mockReset()
  onDelete.mockReset()
  commitNoteFrontmatter.mockReset().mockResolvedValue(undefined)
})

describe('NoteRowList', () => {
  it('a swipe pin updates the row marker through the overlay while persistence is pending', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const view = await mount(
      <div style={{ width: 360, height: 300, display: 'flex' }}>
        <CachedNoteList />
      </div>,
    )
    const client = view.queryClient
    client.setQueryData<FilteredSearchHit[]>(mobileKey, [
      {
        path: 'notes/alpha.md',
        title: 'Alpha',
        highlightedTitle: 'Alpha',
        dailyDate: null,
        snippet: null,
        preview: '',
        mtime: 0,
        isPinned: false,
      },
    ])
    await expect
      .element(view.getByRole('button', { name: /Alpha.*First line/ }))
      .toBeInTheDocument()
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()
    await swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 32 },
      { x: rect.right - 120, y: rect.top + 32 },
    )
    await view.getByRole('button', { name: 'Pin Alpha', exact: true }).click()
    await vi.waitFor(() => {
      expect(view.app.noteRows.getOverlay('notes/alpha.md')).toMatchObject({
        isPinned: true,
      })
    })
    await expect.element(view.getByText('Pinned', { exact: true })).toBeInTheDocument()
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/alpha.md', { pinned: 1024 }, 1)
    write.resolve()
    await write.promise
  })

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

    const view = await mount(<NoteRowList rows={[row]} onOpen={() => {}} />)
    const match = view.getByText('Tim Mac')

    await expect.element(match).toBeInTheDocument()
    await vi.waitFor(() => expect(match.element().tagName).toBe('MARK'))
    await expect.element(match).toHaveClass('bg-primary/15')
    await expect.element(view.getByRole('button')).toMatchTextContent('Tim MacCaw')
  })

  it('tracks a leftward touch and reveals pin and delete actions', async () => {
    const view = await mount(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()

    await swipe(
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
    const view = await mount(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()

    await swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 12 },
      { x: rect.right - 22, y: rect.top + 52 },
    )

    expect(view.getByRole('button', { name: 'Delete Alpha' }).query()).toBeNull()
    expect(translateX(surface)).toBe(0)
  })

  it('closes an open row when its note surface is tapped', async () => {
    const view = await mount(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()

    await swipe(
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
    const view = await mount(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()
    await swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 32 },
      { x: rect.right - 120, y: rect.top + 32 },
    )

    await view.getByRole('button', { name: 'Delete Alpha' }).click()

    expect(onDelete).toHaveBeenCalledOnce()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('does not offer delete for a daily note', async () => {
    const view = await mount(
      <SwipeHarness note={row({ path: 'daily/2026-08-15.md', canDelete: false })} />,
    )
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()
    await swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 32 },
      { x: rect.right - 90, y: rect.top + 32 },
    )

    await expect.element(view.getByRole('button', { name: 'Pin Alpha' })).toBeInTheDocument()
    expect(view.getByRole('button', { name: 'Delete Alpha' }).query()).toBeNull()
  })

  it('recovers when a pre-threshold touch is abandoned outside the row', async () => {
    const view = await mount(<SwipeHarness />)
    const surface = view.getByRole('button', { name: /Alpha.*First line/ }).element()
    const rect = surface.getBoundingClientRect()

    // No move/up reaches the row for this first armed touch.
    await pointer(surface, 'pointerdown', rect.right - 20, rect.top + 32)
    await swipe(
      surface,
      { x: rect.right - 20, y: rect.top + 32 },
      { x: rect.right - 120, y: rect.top + 32 },
    )

    await expect.element(view.getByRole('button', { name: 'Delete Alpha' })).toBeInTheDocument()
  })
})
