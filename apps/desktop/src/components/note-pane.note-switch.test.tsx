import { page, userEvent } from 'vitest/browser'
import { useLayoutEffect, type RefObject } from 'react'
import { expect, it, vi } from 'vitest'
import {
  createTestClockService,
  createTestCoreServices,
  createTestNoteFileService,
  seedNotes,
} from '@reflect/core/testing'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry.ts'
import { queryClient } from '@/lib/query-client.ts'
import { useRouterActions } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import '@/test-utils/locator.ts'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { RouteContent } from './route-content.tsx'

type Router = ReturnType<typeof useRouterActions>

/**
 * Publishes the router so the test can navigate.
 */
function RouterProbe({ routerRef }: { routerRef: RefObject<Router | null> }): null {
  const router = useRouterActions()
  useLayoutEffect(() => {
    routerRef.current = router
  })
  return null
}

function note(title: string): string {
  return `# ${title}\n\n${title} body\n`
}

function privateNote(title: string): string {
  return `---\nprivate: true\n---\n\n${note(title)}`
}

/**
 * Render the note route on `notes/alpha.md` over `files`, with `indexed` in the index.
 */
async function renderNotes(files: Record<string, string>, indexed: readonly string[] = []) {
  const clock = createTestClockService()
  const noteFile = createTestNoteFileService({ files })
  const database = createWasmTestDatabaseService()
  const core = createTestCoreServices({ database, noteFile, clock })
  seedNotes(
    database,
    indexed.map((path) => ({ path, markdown: files[path] ?? '' })),
  )
  const routerRef: { current: Router | null } = { current: null }
  const view = await renderInApp(
    <PaletteProvider>
      <RouterProbe routerRef={routerRef} />
      <RouteContent />
    </PaletteProvider>,
    { core, queryClient, route: { kind: 'note', path: 'notes/alpha.md' } },
  )
  await expect.element(page.getByText('Alpha body')).toBeVisible()
  const navigate = async (path: string, title: string): Promise<void> => {
    routerRef.current?.navigate({ kind: 'note', path })
    await expect.element(page.getByText(`${title} body`)).toBeVisible()
  }
  return { core, noteFile, clock, view, navigate }
}

it('a note switch shows the note it opened, and edits there never take another note’s body', async () => {
  const { noteFile, clock, view, navigate } = await renderNotes({
    'notes/alpha.md': note('Alpha'),
    'notes/beta.md': note('Beta'),
    'notes/gamma.md': note('Gamma'),
  })

  await navigate('notes/beta.md', 'Beta')
  await navigate('notes/gamma.md', 'Gamma')
  await expect.element(page.getByText('Beta body')).not.toBeInTheDocument()

  const gammaEditor = noteEditorHandleFor('notes/gamma.md')
  expect(gammaEditor).not.toBeNull()
  gammaEditor?.insertMarkdown('typed ')
  await clock.advance(2000)

  expect(noteFile.files().get('notes/gamma.md')).toContain('typed ')

  expect(noteFile.files().get('notes/gamma.md')).toContain('Gamma body')
  expect(noteFile.files().get('notes/gamma.md')).not.toContain('Beta body')
  expect(noteFile.files().get('notes/beta.md')).toBe(note('Beta'))
  await view.unmount()
})

it('a note opened after a public one stays out of AI until its own privacy is known', async () => {
  const files = { 'notes/alpha.md': note('Alpha'), 'notes/beta.md': privateNote('Beta') }
  // Beta is not indexed yet (mid-index, or just synced): its row never resolves.
  const { core, view, navigate } = await renderNotes(files, ['notes/alpha.md'])
  await core.aiProviderConfig.add({
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    apiKey: 'sk-ant-test-1234',
    isDefault: true,
  })
  const transform = vi.spyOn(core.selectionTransform, 'transform')
  const sentFrom = (): unknown[] => transform.mock.calls.map(([request]) => request.note)
  const runPromptOnSelection = async (): Promise<void> => {
    await page.locate('.ProseMirror').click()
    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.keyboard('{ControlOrMeta>}{Shift>}j{/Shift}{/ControlOrMeta}')
    await userEvent.keyboard('Summarise')
  }

  // The public note offers the menu, and a prompt runs on its text.
  await runPromptOnSelection()
  await expect.element(page.getByText('Run as a prompt')).toBeVisible()
  await userEvent.keyboard('{Enter}')
  await vi.waitFor(() => expect(sentFrom()).toEqual([{ path: 'notes/alpha.md', isPrivate: false }]))

  // The private one must not inherit Alpha's "not private": with no row yet it
  // fails closed, so no menu opens and nothing is sent.
  await navigate('notes/beta.md', 'Beta')
  await runPromptOnSelection()
  await expect.element(page.getByText('Run as a prompt')).not.toBeInTheDocument()
  expect(sentFrom()).toHaveLength(1)
  await view.unmount()
})
