import { cleanup, render } from '@testing-library/react'
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
vi.mock('@/routing/app-shortcuts', () => ({ useAppShortcuts: () => ({}) }))

const { WorkspaceContent } = await import('./workspace-content')

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', generation: 1 }

beforeEach(() => {
  workspaceState.collapsed = false
  workspaceState.target = { kind: 'daily', date: '2026-07-11' }
})

afterEach(cleanup)

describe('WorkspaceContent', () => {
  it('hides and restores the workspace and daily context sidebars together', () => {
    const view = render(<WorkspaceContent graph={GRAPH} />)

    expect(view.getByRole('complementary', { name: 'Workspace' })).toBeTruthy()
    expect(view.getByRole('complementary', { name: 'Context' })).toBeTruthy()
    expect(view.getByTestId('daily-context').textContent).toBe('2026-07-11')

    workspaceState.collapsed = true
    view.rerender(<WorkspaceContent graph={GRAPH} />)
    expect(view.queryByRole('complementary', { name: 'Workspace' })).toBeNull()
    expect(view.queryByRole('complementary', { name: 'Context' })).toBeNull()

    workspaceState.collapsed = false
    view.rerender(<WorkspaceContent graph={GRAPH} />)
    expect(view.getByRole('complementary', { name: 'Workspace' })).toBeTruthy()
    expect(view.getByRole('complementary', { name: 'Context' })).toBeTruthy()
  })

  it('applies the same collapsed state to ordinary note context', () => {
    workspaceState.target = { kind: 'note', path: 'notes/project.md' }
    const view = render(<WorkspaceContent graph={GRAPH} />)
    expect(view.getByTestId('note-context').textContent).toBe('notes/project.md')

    workspaceState.collapsed = true
    view.rerender(<WorkspaceContent graph={GRAPH} />)
    expect(view.queryByRole('complementary', { name: 'Context' })).toBeNull()
  })
})
