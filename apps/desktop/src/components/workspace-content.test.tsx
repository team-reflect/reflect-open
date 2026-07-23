import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphInfo } from '@reflect/core'
import type { ContextSidebarTarget } from '@/components/context-sidebar/sidebar-route'

interface WorkspaceState {
  collapsed: boolean
  target: ContextSidebarTarget | null
}

const workspaceState = vi.hoisted<WorkspaceState>(() => ({
  collapsed: false,
  target: { kind: 'daily', date: '2026-07-11' },
}))

vi.mock('@/components/command-palette/command-palette', () => ({
  CommandPalette: () => null,
}))
vi.mock('@/components/context-sidebar/daily-context-sidebar', () => ({
  DailyContextSidebar: ({ date }: { date: string }) => (
    <div data-testid="daily-context">{date}</div>
  ),
}))
vi.mock('@/components/context-sidebar/note-context-sidebar', () => ({
  NoteContextSidebar: ({ path }: { path: string }) => (
    <div data-testid="note-context">{path}</div>
  ),
}))
vi.mock('@/components/embeddings-sync', () => ({ EmbeddingsSync: () => null }))
vi.mock('@/components/route-content', () => ({ RouteContent: () => <div>Route content</div> }))
vi.mock('@/components/shortcuts-dialog', () => ({ ShortcutsDialog: () => null }))
vi.mock('@/components/sidebar/sidebar', () => ({
  Sidebar: () => <div data-testid="workspace-sidebar" />,
}))
vi.mock('@/components/templates/template-create-dialog', () => ({
  TemplateCreateDialog: () => null,
}))
vi.mock('@/components/templates/template-picker', () => ({ TemplatePicker: () => null }))
vi.mock('@/providers/focused-daily-provider', () => ({
  useDailyContextTarget: () => workspaceState.target,
}))
vi.mock('@/providers/sidebar-provider', () => ({
  useSidebar: () => ({ collapsed: workspaceState.collapsed, toggleSidebar: vi.fn() }),
}))
// The AppShell asides mount resize handles, which read the persisted widths.
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { sidebarWidth: 260, contextSidebarWidth: 320 },
    updateSettings: vi.fn(),
    updateSettingsWith: vi.fn(),
  }),
}))
vi.mock('@/routing/app-shortcuts', () => ({ useAppShortcuts: () => ({}) }))

const { WorkspaceContent } = await import('./workspace-content')

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', generation: 1 }

beforeEach(async () => {
  workspaceState.collapsed = false
  workspaceState.target = { kind: 'daily', date: '2026-07-11' }
  // The context sidebar is `hidden lg:block`, so it only renders on a
  // desktop-width viewport.
  await page.viewport(1280, 800)
})

afterEach(async () => {
  await page.viewport(900, 600)
})

describe('WorkspaceContent', () => {
  it('hides and restores the workspace and daily context sidebars together', async () => {
    const view = await render(<WorkspaceContent graph={GRAPH} />)

    await expect
      .element(view.getByRole('complementary', { name: 'Workspace' }))
      .toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Context' })).toBeInTheDocument()
    expect(view.getByTestId('daily-context').element().textContent).toBe('2026-07-11')

    workspaceState.collapsed = true
    await view.rerender(<WorkspaceContent graph={GRAPH} />)
    expect(view.getByRole('complementary', { name: 'Workspace' }).query()).toBeNull()
    expect(view.getByRole('complementary', { name: 'Context' }).query()).toBeNull()

    workspaceState.collapsed = false
    await view.rerender(<WorkspaceContent graph={GRAPH} />)
    await expect
      .element(view.getByRole('complementary', { name: 'Workspace' }))
      .toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Context' })).toBeInTheDocument()
  })

  it('applies the same collapsed state to ordinary note context', async () => {
    workspaceState.target = { kind: 'note', path: 'notes/project.md' }
    const view = await render(<WorkspaceContent graph={GRAPH} />)
    expect(view.getByTestId('note-context').element().textContent).toBe('notes/project.md')

    workspaceState.collapsed = true
    await view.rerender(<WorkspaceContent graph={GRAPH} />)
    expect(view.getByRole('complementary', { name: 'Context' }).query()).toBeNull()
  })
})
