import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import type { ReactElement } from 'react'
import type { Route } from '@reflect/app'
import type { GraphInfo } from '@reflect/core'
import { createTestCoreServices, seedNotes } from '@reflect/core/testing'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { formatDayLabel } from '@/lib/dates.ts'
import { AudioMemoProvider } from '@/providers/audio-memo-provider.tsx'
import { DeepLinkProvider } from '@/providers/deep-link-provider.tsx'
import { FocusedDailyProvider } from '@/providers/focused-daily-provider.tsx'
import { NoteFindProvider } from '@/providers/note-find-provider.tsx'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider.tsx'
import { ShortcutsProvider } from '@/providers/shortcuts-provider.tsx'
import { SidebarProvider, useSidebar } from '@/providers/sidebar-provider.tsx'
import { V1ImportProvider } from '@/providers/v1-import-provider.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { WorkspaceContent } from './workspace-content.tsx'

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', generation: 1 }

/**
 * Toggles the sidebar the way the "Toggle sidebar" command does.
 */
function SidebarToggle(): ReactElement {
  const { toggleSidebar } = useSidebar()
  return (
    <button type="button" onClick={toggleSidebar}>
      Toggle sidebar
    </button>
  )
}

function renderWorkspace(route: Route) {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  // Pinned, so the sidebar of this note (and only this note) offers "Un-pin this note".
  seedNotes(app.database, [
    { path: 'notes/project.md', markdown: '---\npinned: true\n---\n# Project\n' },
  ])
  // The providers of `GraphWorkspace`, inside the router of `renderInApp`.
  return renderInApp(
    <PaletteProvider>
      <ShortcutsProvider>
        <NoteTemplatesProvider>
          <SidebarProvider>
            <AudioMemoProvider graph={GRAPH}>
              <DeepLinkProvider>
                <FocusedDailyProvider>
                  <NoteFindProvider>
                    <V1ImportProvider>
                      <WorkspaceContent graph={GRAPH} />
                      <SidebarToggle />
                    </V1ImportProvider>
                  </NoteFindProvider>
                </FocusedDailyProvider>
              </DeepLinkProvider>
            </AudioMemoProvider>
          </SidebarProvider>
        </NoteTemplatesProvider>
      </ShortcutsProvider>
    </PaletteProvider>,
    {
      app,
      graph: GRAPH,
      route,
      // The AppShell asides mount resize handles, which read the persisted widths.
      settings: { sidebarWidth: 260, contextSidebarWidth: 320, dateFormat: 'mdy' },
    },
  )
}

beforeEach(async () => {
  // The context sidebar is `hidden lg:block`, so it only renders on a
  // desktop-width viewport.
  await page.viewport(1280, 800)
})

afterEach(async () => {
  await page.viewport(900, 600)
})

describe('WorkspaceContent', () => {
  it('hides and restores the workspace and daily context sidebars together', async () => {
    const view = await renderWorkspace({ kind: 'daily', date: '2026-07-11' })
    const toggle = view.getByRole('button', { name: 'Toggle sidebar' })

    await expect.element(view.getByRole('complementary', { name: 'Workspace' })).toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Context' })).toBeInTheDocument()
    await expect
      .element(
        view
          .getByTestId('daily-context-sidebar')
          .getByRole('button', { name: formatDayLabel('2026-07-11', 'mdy') }),
      )
      .toHaveAttribute('aria-pressed', 'true')

    await toggle.click()
    await expect
      .element(view.getByRole('complementary', { name: 'Workspace' }))
      .not.toBeInTheDocument()
    expect(view.getByRole('complementary', { name: 'Context' }).query()).toBeNull()

    await toggle.click()
    await expect.element(view.getByRole('complementary', { name: 'Workspace' })).toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Context' })).toBeInTheDocument()
  })

  it('applies the same collapsed state to ordinary note context', async () => {
    const view = await renderWorkspace({ kind: 'note', path: 'notes/project.md' })
    const context = view.getByRole('complementary', { name: 'Context' })
    await expect.element(context.getByTestId('note-context-sidebar')).toBeInTheDocument()
    await expect
      .element(context.getByRole('button', { name: 'Un-pin this note' }))
      .toBeInTheDocument()

    await view.getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect
      .element(view.getByRole('complementary', { name: 'Context' }))
      .not.toBeInTheDocument()
  })
})
