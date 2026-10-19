import type { MaybePromise } from '@reflect/utils'
import { createTestWindowService } from '@reflect/app/testing'
import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RetrievalService } from '@reflect/core'
import {
  createTestCoreServices,
  createTestNoteFileService,
  createTestRetrievalService,
} from '@reflect/core/testing'
import type { ReactNode } from 'react'
import { deepLinkForRoute } from '@reflect/app'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { SimilarNotesSection } from './similar-notes-section.tsx'

const relatedNotes = vi.fn<RetrievalService['relatedNotes']>()
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()
let semanticSearchEnabled: boolean

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

async function renderSimilar(path: string, probe: boolean = true) {
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile: createTestNoteFileService({ files: { 'daily/2026-06-09.md': '- daily entry\n' } }),
    retrieval: createTestRetrievalService({ relatedNotes }),
  })
  return await renderInApp(
    <>
      <SimilarNotesSection path={path} />
      {probe ? <RouteProbe /> : null}
    </>,
    {
      app,
      appServices: { window: createTestWindowService({ openNoteWindow }) },
      graph: { root: '/g', name: 'g' },
      settings: { semanticSearchEnabled },
    },
  )
}

beforeEach(() => {
  semanticSearchEnabled = true
  relatedNotes.mockReset().mockResolvedValue([])
  openNoteWindow.mockReset().mockResolvedValue(true)
})

describe('SimilarNotesSection', () => {
  it('renders nothing at all when the note has no semantic neighbors', async () => {
    const view = await renderSimilar('daily/2026-06-09.md', false)
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6))
    expect(view.container.firstChild).toBeNull()
  })

  it('neither queries nor renders while semantic search is disabled', async () => {
    semanticSearchEnabled = false
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/rust.md',
        title: 'Rust',
        score: 0.9,
        snippet: 'borrow checker notes',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = await renderSimilar('notes/languages.md', false)
    // Give a would-be fetch a tick to fire before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    expect(view.container.firstChild).toBeNull()
  })

  it('renders the Similar notes section with one title-only row per neighbor', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/rust.md',
        title: 'Rust',
        score: 0.9,
        snippet: 'borrow checker notes',
        heading: null,
        isPrivate: false,
      },
      {
        path: 'notes/zig.md',
        title: 'Zig',
        score: 0.7,
        snippet: 'comptime experiments',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = await renderSimilar('notes/languages.md')
    await expect.element(view.getByText('Rust')).toBeInTheDocument()
    await expect.element(view.getByText('Similar notes')).toBeInTheDocument()
    await expect.element(view.getByText('Zig')).toBeInTheDocument()
    const rustRow = view.getByRole('button', { name: 'Rust' }).element()
    expect(rustRow.className).toContain('px-3')
    expect(rustRow.parentElement?.className ?? '').not.toContain('-mx-1')
    // V1 rows are bare titles — snippets never render here.
    expect(view.getByText('borrow checker notes').query()).toBeNull()
    expect(view.getByText('comptime experiments').query()).toBeNull()
  })

  it('shows no more than six neighbors', async () => {
    relatedNotes.mockResolvedValue(
      Array.from({ length: 7 }, (_, index) => ({
        path: `notes/note-${index + 1}.md`,
        title: `Note ${index + 1}`,
        score: 1 - index / 10,
        snippet: `snippet ${index + 1}`,
        heading: null,
        isPrivate: false,
      })),
    )
    const view = await renderSimilar('notes/languages.md', false)
    await expect.element(view.getByText('Note 6')).toBeInTheDocument()
    expect(view.getByText('Note 7').query()).toBeNull()
    expect(relatedNotes).toHaveBeenCalledWith('notes/languages.md', 6)
  })

  it('navigates to the clicked neighbor', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/gardening.md',
        title: 'Gardening',
        score: 0.8,
        snippet: 'tomato beds',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = await renderSimilar('daily/2026-06-09.md')
    await userEvent.click(view.getByText('Gardening'))
    await expect.element(view.getByTestId('route')).toMatchTextContent('"kind":"note"')
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/gardening.md')
  })

  it('opens a ⌘-clicked neighbor in a new window', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/gardening.md',
        title: 'Gardening',
        score: 0.8,
        snippet: 'tomato beds',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = await renderSimilar('daily/2026-06-09.md')

    await view.getByRole('button', { name: 'Gardening' }).click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() =>
      expect(openNoteWindow).toHaveBeenCalledWith(
        deepLinkForRoute({
          kind: 'note',
          path: 'notes/gardening.md',
        }),
      ),
    )
    await expect.element(view.getByTestId('route')).toMatchTextContent('"kind":"today"')
  })
})
