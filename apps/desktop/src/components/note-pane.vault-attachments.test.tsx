import type { ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge, type FileMeta } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { queryClient } from '@/lib/query-client.ts'
import { useAttachmentCatalogSync } from '@/lib/attachment-catalog.ts'
import { RouterProvider } from '@/routing/router.tsx'
import { deferred } from '@/test-utils/deferred.ts'
import '@/test-utils/locator.ts'
import { RouteContent } from './route-content.tsx'

// An Obsidian vault opened in place: images live in `attachments/`, beside
// neither note, and are referenced by relative path and by `![[embed]]`.

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
const GRAPH = vi.hoisted(() => ({ root: '/vault', name: 'Garden', generation: 1 }))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: GRAPH, indexing: false }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
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

const ATTACHMENTS: FileMeta[] = [
  { path: 'attachments/garden-budget.png', size: 2048, modifiedMs: 0 },
  { path: 'attachments/planting-plan.pdf', size: 4000, modifiedMs: 0 },
]

let files: Record<string, string>
let listAttachments: () => Promise<FileMeta[]>

beforeEach(() => {
  files = {}
  listAttachments = async () => ATTACHMENTS
  setBridge({
    invoke: async (command, args) => {
      if (command === 'note_read') return files[String(args.path)]
      if (command === 'list_attachments') return await listAttachments()
      if (command === 'db_query') return []
      return null
    },
    listen: async () => () => {},
  })
})

afterEach(async () => {
  await cleanup()
  setBridge(null)
  queryClient.clear()
  vi.resetAllMocks()
})

function renderNote(path: string) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider initialRoute={{ kind: 'note', path }}>
        <CatalogSync>
          <PaletteProvider>
            <RouteContent />
          </PaletteProvider>
        </CatalogSync>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function CatalogSync({ children }: { children: ReactNode }): ReactNode {
  useAttachmentCatalogSync(GRAPH.generation)
  return children
}

const BUDGET_URL = 'reflect-asset://1/attachments/garden-budget.png'

it("renders a nested note's relative image from the vault's attachments folder", async () => {
  files['Projects/Garden redesign.md'] =
    '# Garden redesign\n\n![Garden budget](../attachments/garden-budget.png)\n'
  const view = await renderNote('Projects/Garden redesign.md')

  await expect.element(page.getByAltText('Garden budget')).toHaveAttribute('src', BUDGET_URL)
  await view.unmount()
})

it('renders Obsidian embeds and vault-root images in a root note', async () => {
  files['Home.md'] = [
    '# Home',
    '',
    'Embed: ![[garden-budget.png]]',
    '',
    '![Budget chart](attachments/garden-budget.png)',
    '',
    'Plan: ![[planting-plan.pdf]]',
    '',
    'Book: ![[Deep Work]]',
    '',
  ].join('\n')
  const view = await renderNote('Home.md')

  await expect.element(page.getByAltText('garden-budget.png')).toHaveAttribute('src', BUDGET_URL)
  await expect.element(page.getByAltText('Budget chart')).toHaveAttribute('src', BUDGET_URL)
  const pill = page.getByTestId('file-pill')
  await expect.element(pill.locate('.md-file-view-name')).toMatchTextContent('planting-plan.pdf')
  await expect.element(pill.getByTestId('file-pill-size')).toMatchTextContent('4 KB')
  // A note embed is a link chip to the note, never transcluded content.
  await expect.element(page.getByText('Deep Work', { exact: true })).toBeVisible()
  expect(document.querySelector('.ProseMirror')?.textContent).not.toContain('Rules for')
  await view.unmount()
})

it('renders an embed once the attachment catalog arrives', async () => {
  const listing = deferred<FileMeta[]>()
  listAttachments = () => listing.promise
  files['Home.md'] = 'Embed: ![[garden-budget.png]]\n'
  const view = await renderNote('Home.md')

  await expect.element(page.getByText('Embed:')).toBeVisible()
  expect(document.querySelectorAll('.ProseMirror img')).toHaveLength(0)

  listing.resolve(ATTACHMENTS)

  await expect.element(page.getByAltText('garden-budget.png')).toHaveAttribute('src', BUDGET_URL)
  await view.unmount()
})
