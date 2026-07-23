import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { SimilarNotesSection } from './similar-notes-section'

const relatedNotes = vi.hoisted(() => vi.fn())
const readNote = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  readNote,
  relatedNotes,
}))
vi.mock('@/lib/windows/open-in-new-window', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window')>()),
  openRouteInNewWindow,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
const semanticSetting = vi.hoisted(() => ({ enabled: true }))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { semanticSearchEnabled: semanticSetting.enabled },
    updateSettings: () => {},
  }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSimilar(path: string, probe: boolean = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <SimilarNotesSection path={path} />
        {probe ? <RouteProbe /> : null}
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  semanticSetting.enabled = true
  readNote.mockReset().mockResolvedValue('- daily entry\n')
  relatedNotes.mockReset().mockResolvedValue([])
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
})

describe('SimilarNotesSection', () => {
  it('renders nothing at all when the note has no semantic neighbors', async () => {
    const view = await renderSimilar('daily/2026-06-09.md', false)
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6))
    expect(view.container.firstChild).toBeNull()
    await view.unmount()
  })

  it('neither queries nor renders while semantic search is disabled', async () => {
    semanticSetting.enabled = false
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
    await view.unmount()
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
    await view.unmount()
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
    await view.unmount()
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
    await expect.element(view.getByTestId('route')).toHaveTextContent('"kind":"note"')
    await expect.element(view.getByTestId('route')).toHaveTextContent('notes/gardening.md')
    await view.unmount()
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

    await view.getByRole('button', { name: 'Gardening' }).click({ modifiers: ['Meta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/gardening.md',
      }),
    )
    await expect.element(view.getByTestId('route')).toHaveTextContent('"kind":"today"')
    await view.unmount()
  })
})
