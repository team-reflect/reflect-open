import { render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router'
import { RelatedNotes } from './related-notes'

const relatedNotes = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  relatedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 } }),
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

function renderRelated(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // A fresh element per render: React bails out on an identical element
  // reference, and the rerender must re-read the mocked settings.
  const tree = () => (
    <QueryClientProvider client={client}>
      <RouterProvider>
        <RelatedNotes path={path} />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>
  )
  const view = render(tree())
  return { view, rerender: () => view.rerender(tree()) }
}

beforeEach(() => {
  semanticSetting.enabled = true
  relatedNotes.mockReset()
})

describe('RelatedNotes', () => {
  it('lists semantic neighbors and navigates on click', async () => {
    relatedNotes.mockResolvedValue([
      { path: 'notes/kin.md', title: 'Kindred', score: 0.8, snippet: 'close by', heading: null, isPrivate: false },
    ])
    const { view } = renderRelated('notes/self.md')
    await view.findByText('Kindred')

    await userEvent.click(view.getByText('Kindred'))
    expect(view.getByTestId('route').textContent).toContain('notes/kin.md')
    view.unmount()
  })

  it('renders nothing when the note has no vectors (or nothing relates)', async () => {
    relatedNotes.mockResolvedValue([]) // model never enabled / not yet embedded
    const { view } = renderRelated('notes/a.md')
    await waitFor(() => expect(view.queryByText('Similar notes')).toBeNull())
    view.unmount()
  })

  it('neither queries nor renders while semantic search is disabled', async () => {
    semanticSetting.enabled = false
    relatedNotes.mockResolvedValue([
      { path: 'notes/kin.md', title: 'Kindred', score: 0.8, snippet: 'close by', heading: null, isPrivate: false },
    ])
    const { view } = renderRelated('notes/self.md')
    // Give a would-be fetch a tick to fire before asserting it never did.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    expect(view.queryByText('Kindred')).toBeNull()
    view.unmount()
  })

  it('empties immediately when semantic search is disabled mid-session', async () => {
    relatedNotes.mockResolvedValue([
      { path: 'notes/kin.md', title: 'Kindred', score: 0.8, snippet: 'close by', heading: null, isPrivate: false },
    ])
    const { view, rerender } = renderRelated('notes/self.md')
    await view.findByText('Kindred')

    // The disabled query still holds its cached rows — the hook must mask
    // them, not just stop fetching.
    semanticSetting.enabled = false
    rerender()
    await waitFor(() => expect(view.queryByText('Kindred')).toBeNull())
    view.unmount()
  })
})
