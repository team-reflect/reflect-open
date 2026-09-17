import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import type { ResolvedArchivedPost } from '@reflect/core/x-archive'
import { PaletteProvider } from '@/components/command-palette/palette-provider'
import { RouterProvider } from '@/routing/router'
import '@/test-utils/locator'
import { RouteContent } from './route-content'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: async () => ({ contexts: [], nextCursor: null, indexedLinkCount: 0 }),
  relatedNotes: async () => [],
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      allNotesFilterTags: [],
      aiProviders: [],
      defaultAiProviderId: null,
      chatSystemPrompt: '',
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))

let files: Record<string, string>
const resolveArchive = vi.fn<(postId: string) => Promise<ResolvedArchivedPost | null>>()

beforeEach(() => {
  files = {}
  setBridge({
    invoke: async (command, args) => {
      if (command === 'note_read') return files[String(args.path)]
      if (command === 'x_archive_resolve') return await resolveArchive(String(args.postId))
      if (command === 'db_query') return []
      return null
    },
    listen: async () => () => {},
  })
})

afterEach(async () => {
  await cleanup()
  setBridge(null)
  vi.resetAllMocks()
})

function archivedPost(id: string, text: string): ResolvedArchivedPost {
  return {
    archive: {
      kind: 'x-post',
      capturedAt: '2026-09-14T00:00:00Z',
      data: {
        id,
        createdAt: '2026-09-14T00:00:00Z',
        author: { name: 'Jack', handle: 'jack' },
        body: [{ type: 'text', text }],
      },
    },
    resources: [],
  }
}

function renderNote(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'note', path }}>
        <PaletteProvider>
          <RouteContent />
        </PaletteProvider>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

// Every rendered state is observed before it can paint.
function watchLoadingCards(): { seen: boolean; stop: () => void } {
  const watch = { seen: false, stop: () => observer.disconnect() }
  const observer = new MutationObserver(() => {
    if (document.querySelector('post-embed-x-post [data-pending]')) watch.seen = true
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true })
  return watch
}

it('renders archived X posts in the first frame of the editor', async () => {
  files['notes/tweets.md'] = '![](https://x.com/jack/status/101)\n'
  resolveArchive.mockImplementation(async (postId) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return archivedPost(postId, 'Archived first')
  })
  const loadingCards = watchLoadingCards()
  const view = await renderNote('notes/tweets.md')

  await expect.element(page.getByText('Archived first')).toBeVisible()
  loadingCards.stop()
  expect(loadingCards.seen).toBe(false)
  await view.unmount()
})

it('mounts the editor once the wait runs out for a slow archive', async () => {
  files['notes/slow.md'] = 'Slow note\n\n![](https://x.com/jack/status/102)\n'
  resolveArchive.mockImplementation(() => new Promise(() => {}))
  const view = await renderNote('notes/slow.md')

  await expect.element(page.getByText('Slow note')).toBeVisible()
  await expect.element(page.getByText('Loading this post…')).toBeVisible()
  await view.unmount()
})
