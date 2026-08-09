import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { GraphInfo } from '@reflect/core'
import type { ContextSidebarTarget } from '@/components/context-sidebar/sidebar-route'
import { PdfSessionProvider } from '@/providers/pdf-session-provider'
import { PdfSidebarViewProvider } from '@/providers/pdf-sidebar-view-provider'
import type { PreviewPanelTarget } from '@/providers/preview-panel-provider'

interface WorkspaceState {
  collapsed: boolean
  target: ContextSidebarTarget | null
}

const workspaceState = vi.hoisted<WorkspaceState>(() => ({
  collapsed: false,
  target: { kind: 'daily', date: '2026-07-11' },
}))

const previewPanelState = vi.hoisted(() => ({
  target: null as PreviewPanelTarget | null,
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
  NoteContextSidebar: ({ path }: { path: string }) => <div data-testid="note-context">{path}</div>,
}))
vi.mock('@/components/embeddings-sync', () => ({ EmbeddingsSync: () => null }))
vi.mock('@/components/note-find-bar', () => ({ NoteFindBar: () => null }))
// A stub keeps this suite independent of the preview lane's internals.
vi.mock('@/components/preview/preview-panel', () => ({
  PreviewPanel: ({ target }: { target: unknown }) => (
    <div data-testid="preview-panel-content">{JSON.stringify(target)}</div>
  ),
}))
// The PDF sidebar block reads the pdf session; this suite only cares that the
// context slot hands it the exclusive stage while a PDF is open.
vi.mock('@/components/preview/pdf-sidebar-block', () => ({
  PdfSidebarBlock: () => <div data-testid="pdf-sidebar-block" />,
}))
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
vi.mock('@/providers/preview-panel-provider', () => ({
  usePreviewPanel: () => ({
    target: previewPanelState.target,
    open: vi.fn(),
    close: vi.fn(),
  }),
}))
vi.mock('@/providers/sidebar-provider', () => ({
  useSidebar: () => ({ collapsed: workspaceState.collapsed, toggleSidebar: vi.fn() }),
}))
// The AppShell asides mount resize handles, which read the persisted widths;
// the preview pane's handle reads its own width preference.
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { sidebarWidth: 260, contextSidebarWidth: 320, previewPanelWidth: 380 },
    updateSettings: vi.fn(),
    updateSettingsWith: vi.fn(),
  }),
}))
vi.mock('@/routing/app-shortcuts', () => ({ useAppShortcuts: () => ({}) }))

const { WorkspaceContent } = await import('./workspace-content')

const GRAPH: GraphInfo = { root: '/notes', name: 'Notes', generation: 1 }

// 生产环境里两个 Provider 由 GraphWorkspace 挂在 WorkspaceContent 之上；
// 本套件直接渲染 WorkspaceContent，因此在这里补齐同样的包裹。
function WorkspaceHost({ graph }: { graph: GraphInfo }): ReactElement {
  return (
    <PdfSidebarViewProvider>
      <PdfSessionProvider>
        <WorkspaceContent graph={graph} />
      </PdfSessionProvider>
    </PdfSidebarViewProvider>
  )
}

async function renderWorkspace(graph: GraphInfo = GRAPH) {
  return await render(<WorkspaceHost graph={graph} />)
}

beforeEach(async () => {
  workspaceState.collapsed = false
  workspaceState.target = { kind: 'daily', date: '2026-07-11' }
  previewPanelState.target = null
  // The context sidebar is `hidden lg:block`, so it only renders on a
  // desktop-width viewport.
  await page.viewport(1280, 800)
})

afterEach(async () => {
  await page.viewport(900, 600)
})

describe('WorkspaceContent', () => {
  it('hides and restores the workspace and daily context sidebars together', async () => {
    const view = await renderWorkspace()

    await expect.element(view.getByRole('complementary', { name: 'Workspace' })).toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Context' })).toBeInTheDocument()
    expect(view.getByTestId('daily-context').element().textContent).toBe('2026-07-11')

    workspaceState.collapsed = true
    await view.rerender(<WorkspaceHost graph={{ ...GRAPH }} />)
    expect(view.getByRole('complementary', { name: 'Workspace' }).query()).toBeNull()
    expect(view.getByRole('complementary', { name: 'Context' }).query()).toBeNull()

    workspaceState.collapsed = false
    await view.rerender(<WorkspaceHost graph={{ ...GRAPH }} />)
    await expect.element(view.getByRole('complementary', { name: 'Workspace' })).toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Context' })).toBeInTheDocument()
  })

  it('applies the same collapsed state to ordinary note context', async () => {
    workspaceState.target = { kind: 'note', path: 'notes/project.md' }
    const view = await renderWorkspace()
    expect(view.getByTestId('note-context').element().textContent).toBe('notes/project.md')

    workspaceState.collapsed = true
    await view.rerender(<WorkspaceHost graph={{ ...GRAPH }} />)
    expect(view.getByRole('complementary', { name: 'Context' }).query()).toBeNull()
  })

  it('hands the context aside exclusively to the PDF block while a PDF is open', async () => {
    previewPanelState.target = { kind: 'pdf', assetPath: 'assets/paper.pdf', page: 3 }
    const view = await renderWorkspace()

    // The pane lives in the main column; the context aside is taken over by
    // the PDF block alone — the route's daily context is not rendered at all,
    // so its sessionStorage-backed section state is left untouched.
    expect(view.getByTestId('preview-panel-content').element().textContent).toBe(
      JSON.stringify({ kind: 'pdf', assetPath: 'assets/paper.pdf', page: 3 }),
    )
    await expect.element(view.getByRole('complementary', { name: 'Preview' })).toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Context' })).toBeInTheDocument()
    await expect.element(view.getByTestId('pdf-sidebar-block')).toBeInTheDocument()
    expect(view.getByTestId('daily-context').query()).toBeNull()

    // Its divider is a vertical separator controlling the pane, reporting the
    // persisted preference's clamp range.
    const separator = view.getByRole('separator', { name: 'Resize preview panel' })
    expect(separator.element().getAttribute('aria-orientation')).toBe('vertical')
    expect(separator.element().getAttribute('aria-controls')).toBe('preview-panel')
    expect(separator.element().getAttribute('aria-valuemin')).toBe('320')
    expect(separator.element().getAttribute('aria-valuemax')).toBe('720')

    previewPanelState.target = null
    await view.rerender(<WorkspaceHost graph={{ ...GRAPH }} />)
    expect(view.getByTestId('preview-panel-content').query()).toBeNull()
    expect(view.getByTestId('pdf-sidebar-block').query()).toBeNull()
    await expect
      .element(view.getByRole('complementary', { name: 'Preview' }))
      .not.toBeInTheDocument()
    // 关闭后每日/笔记上下文原样回来（其 SidebarSection 状态未被触碰）。
    expect(view.getByTestId('daily-context').element().textContent).toBe('2026-07-11')
  })

  it('keeps the note context visible for a note preview (only PDF is exclusive)', async () => {
    previewPanelState.target = { kind: 'note', path: 'notes/project.md' }
    const view = await renderWorkspace()

    expect(view.getByTestId('preview-panel-content').element().textContent).toBe(
      JSON.stringify({ kind: 'note', path: 'notes/project.md' }),
    )
    expect(view.getByTestId('pdf-sidebar-block').query()).toBeNull()
    expect(view.getByTestId('daily-context').element().textContent).toBe('2026-07-11')
  })

  it('keeps an open preview panel when the workspace collapses (only the rails hide)', async () => {
    previewPanelState.target = { kind: 'note', path: 'notes/project.md' }
    workspaceState.collapsed = true
    const view = await renderWorkspace()

    // Collapse hides the AppShell rails; the pane is the user's explicit
    // focus inside the main column and stays.
    expect(view.getByRole('complementary', { name: 'Context' }).query()).toBeNull()
    expect(view.getByTestId('preview-panel-content').element().textContent).toBe(
      JSON.stringify({ kind: 'note', path: 'notes/project.md' }),
    )
  })
})
