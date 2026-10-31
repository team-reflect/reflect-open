import { page } from 'vitest/browser'
import { expect, it, vi } from 'vitest'
import type { ResolvedArchivedPost } from '@reflect/core/x-archive'
import { createTestCoreServices, createTestNoteFileService } from '@reflect/core/testing'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { queryClient } from '@/lib/query-client.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import '@/test-utils/locator.ts'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { RouteContent } from './route-content.tsx'

type ResolvedArchive = ResolvedArchivedPost | null

function archivedPost(id: string, text: string): NonNullable<ResolvedArchive> {
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

async function renderNote(
  path: string,
  source: string,
  resolveArchive: (postId: string) => Promise<ResolvedArchive>,
) {
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile: createTestNoteFileService({ files: { [path]: source } }),
  })
  vi.spyOn(core.xArchive, 'resolve').mockImplementation(
    async (_generation, postId) => await resolveArchive(postId),
  )
  // The X post resolver and its preload read the app's shared query client.
  return await renderInApp(
    <PaletteProvider>
      <RouteContent />
    </PaletteProvider>,
    {
      core,
      queryClient,
      graph: { root: '/g', name: 'g', generation: 1 },
      settings: { editorMarkdownSyntax: 'hide' },
      route: { kind: 'note', path },
    },
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
  const loadingCards = watchLoadingCards()
  const view = await renderNote(
    'notes/tweets.md',
    '![](https://x.com/jack/status/101)\n',
    async (postId) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return archivedPost(postId, 'Archived first')
    },
  )

  await expect.element(page.getByText('Archived first')).toBeVisible()
  loadingCards.stop()
  expect(loadingCards.seen).toBe(false)
  await view.unmount()
})

it('mounts the editor once the wait runs out for a slow archive', async () => {
  const view = await renderNote(
    'notes/slow.md',
    'Slow note\n\n![](https://x.com/jack/status/102)\n',
    () => new Promise(() => {}),
  )

  await expect.element(page.getByText('Slow note')).toBeVisible()
  await expect.element(page.getByText('Loading this post…')).toBeVisible()
  await view.unmount()
})
