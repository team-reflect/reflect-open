import { act, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { setBridge } from '@reflect/core'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider'
import { flushOpenDocuments } from '@/editor/open-documents'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { RouterProvider } from '@/routing/router'
import type { Route } from '@/routing/route'
import { RouteContent } from './route-content'

/**
 * The route → view seam (Plan 06): non-daily notes must be just as editable as
 * daily ones. These tests drive the real router → RouteContent → NotePane →
 * save-pipeline stack over a fake IPC bridge; only the ProseMirror view is
 * stubbed (jsdom can't host contenteditable — editor-DOM behavior lives in the
 * editor tests and, later, browser-mode vitest).
 */

const editorProbe = vi.hoisted(() => ({
  onChange: null as ((markdown: string) => void) | null,
  focusCalls: [] as string[],
}))

vi.mock('@/editor/note-editor', async () => {
  const { useEffect } = await import('react')
  return {
    NoteEditor: ({
      initialContent,
      onChange,
      handleRef,
    }: {
      initialContent: string
      onChange: (markdown: string) => void
      handleRef?: (handle: NoteEditorHandle | null) => void
    }) => {
      editorProbe.onChange = onChange
      useEffect(() => {
        handleRef?.({
          setMarkdown: () => {},
          getMarkdown: () => '',
          focus: () => editorProbe.focusCalls.push('focus'),
          selectTitle: () => editorProbe.focusCalls.push('selectTitle'),
        })
        return () => handleRef?.(null)
      }, [handleRef])
      return (
        <div data-testid="fake-editor" contentEditable suppressContentEditableWarning>
          {initialContent}
        </div>
      )
    },
  }
})

const indexFns = vi.hoisted(() => ({
  getBacklinksWithContext: vi.fn(async () => []),
  relatedNotes: vi.fn(async () => []),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: indexFns.getBacklinksWithContext,
  relatedNotes: indexFns.relatedNotes,
}))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', cloudSync: null, generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: { editorMarkdownSyntax: 'always' },
    updateSettings: async () => {},
  }),
}))
vi.mock('@/components/settings-screen', () => ({
  SettingsScreen: () => <div data-testid="settings-screen" />,
}))

// jsdom implements neither — the daily stream's virtualizer needs both.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
Element.prototype.scrollTo ??= () => {}

/** The fake graph: files behind the IPC bridge + a write log. */
let files: Record<string, string>
let writes: Array<{ path: string; contents: string }>
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

setBridge({
  invoke: mockInvoke,
  listen: async () => () => {},
})

beforeEach(() => {
  files = {}
  writes = []
  editorProbe.onChange = null
  editorProbe.focusCalls.length = 0
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read') {
      const content = files[(args as { path: string }).path]
      if (content === undefined) {
        throw { kind: 'notFound', message: 'missing' } // AppError shape
      }
      return content
    }
    if (command === 'note_write') {
      const { path, contents } = args as { path: string; contents: string }
      files[path] = contents
      writes.push({ path, contents })
      return null
    }
    if (command === 'db_query') {
      return []
    }
    return null
  })
})

function PaletteProbe(): ReactElement {
  const { open, query } = usePalette()
  return <output data-testid="palette">{JSON.stringify({ open, query })}</output>
}

function renderRoute(route: Route) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={route}>
        <PaletteProvider>
          <RouteContent />
          <PaletteProbe />
        </PaletteProvider>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

describe('RouteContent', () => {
  it('renders the daily stream for the today route', () => {
    const view = renderRoute({ kind: 'today' })
    expect(view.getByTestId('daily-stream')).toBeDefined()
    view.unmount()
  })

  it('renders the daily stream for a daily route, surviving a malformed date', () => {
    const view = renderRoute({ kind: 'daily', date: '2026-02-31' })
    expect(view.getByTestId('daily-stream')).toBeDefined()
    view.unmount()
  })

  it('renders an existing non-daily note as an editable pane, not the stream', async () => {
    files['notes/exist.md'] = '# Hello\n\nWorld.\n'
    const view = renderRoute({ kind: 'note', path: 'notes/exist.md' })

    await view.findByLabelText('Editing notes/exist.md')
    expect(view.queryByTestId('daily-stream')).toBeNull()
    expect(view.getByTestId('fake-editor').textContent).toContain('# Hello')

    // An existing note focuses plainly — no title to claim.
    await waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))
    expect(editorProbe.focusCalls).not.toContain('selectTitle')
    view.unmount()
  })

  it('opens a missing note seeded with a selected Untitled title, writing nothing', async () => {
    const view = renderRoute({ kind: 'note', path: 'notes/new.md' })

    await view.findByLabelText('Editing notes/new.md')
    expect(view.getByTestId('fake-editor').textContent).toContain('# Untitled')
    // The macOS rename pattern: the title is selected so typing names the note.
    await waitFor(() => expect(editorProbe.focusCalls).toContain('selectTitle'))
    expect(editorProbe.focusCalls).not.toContain('focus')

    // Opening never litters the graph — even a forced flush writes nothing.
    await act(() => flushOpenDocuments())
    expect(writes).toEqual([])
    expect(files['notes/new.md']).toBeUndefined()
    view.unmount()
  })

  it('creates the file once the user actually edits the seeded note', async () => {
    const view = renderRoute({ kind: 'note', path: 'notes/new.md' })
    await view.findByLabelText('Editing notes/new.md')

    act(() => editorProbe.onChange?.('# Manifesto\n'))
    await act(() => flushOpenDocuments())

    expect(files['notes/new.md']).toBe('# Manifesto\n')
    view.unmount()
  })

  it('opens a note the editor cannot round-trip as read-only, never editable', async () => {
    files['notes/tasks.md'] = '- [ ] a task\n'
    const view = renderRoute({ kind: 'note', path: 'notes/tasks.md' })

    await view.findByText(/read-only to protect your file/)
    expect(view.queryByTestId('fake-editor')).toBeNull()
    expect(view.getByText(/a task/)).toBeDefined()
    view.unmount()
  })

  it('renders the settings screen for the settings route', () => {
    const view = renderRoute({ kind: 'settings' })
    expect(view.getByTestId('settings-screen')).toBeDefined()
    view.unmount()
  })

  it('arriving on a search route opens the palette pre-filled over the stream', async () => {
    const view = renderRoute({ kind: 'search', query: 'roadmap' })
    expect(view.getByTestId('daily-stream')).toBeDefined()
    await waitFor(() =>
      expect(JSON.parse(view.getByTestId('palette').textContent ?? '')).toEqual({
        open: true,
        query: 'roadmap',
      }),
    )
    view.unmount()
  })
})
