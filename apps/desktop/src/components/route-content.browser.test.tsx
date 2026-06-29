import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { act } from '@/test-utils/act'
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
 * stubbed (editor-DOM behavior lives in the editor tests).
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
          setSelection: () => {},
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
    settings: { editorMarkdownSyntax: 'hide', allNotesFilterTags: ['book', 'link', 'person'] },
    updateSettings: async () => {},
  }),
}))
vi.mock('@/components/settings-screen', () => ({
  SettingsScreen: () => <div data-testid="settings-screen" />,
}))
// The chat screen needs the ChatProvider stack (covered by its own tests);
// here only the route → view mapping is under test.
vi.mock('@/components/chat/chat-screen', () => ({
  ChatScreen: () => <div data-testid="chat-screen" />,
}))

// The daily stream's virtualizer needs both; guarded so the real browser's
// implementations win when present.
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
  it('renders the daily stream for the today route', async () => {
    const view = await renderRoute({ kind: 'today' })
    await expect.element(view.getByTestId('daily-stream')).toBeInTheDocument()
  })

  it('renders the daily stream for a daily route, surviving a malformed date', async () => {
    const view = await renderRoute({ kind: 'daily', date: '2026-02-31' })
    await expect.element(view.getByTestId('daily-stream')).toBeInTheDocument()
  })

  it('renders an existing non-daily note as an editable pane, not the stream', async () => {
    files['notes/exist.md'] = '# Hello\n\nWorld.\n'
    const view = await renderRoute({ kind: 'note', path: 'notes/exist.md' })

    await expect.element(view.getByLabelText('Editing notes/exist.md')).toBeInTheDocument()
    await expect.element(view.getByTestId('daily-stream')).not.toBeInTheDocument()
    await expect.element(view.getByTestId('fake-editor')).toHaveTextContent('# Hello')

    // The navigated-to note takes focus on mount.
    await vi.waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))
  })

  it('opens a missing note seeded with an empty focused title, writing nothing', async () => {
    const view = await renderRoute({ kind: 'note', path: 'notes/new.md' })

    await expect.element(view.getByLabelText('Editing notes/new.md')).toBeInTheDocument()
    // The seed is an empty H1: the caret lands in it (plain focus, no text
    // to select) and the title placeholder ghosts "Untitled" over the line.
    expect(view.getByTestId('fake-editor').element().textContent).toBe('#\n')
    await vi.waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))

    // Opening never litters the graph — even a forced flush writes nothing.
    await act(() => flushOpenDocuments())
    expect(writes).toEqual([])
    expect(files['notes/new.md']).toBeUndefined()
  })

  it('creates the file once the user actually edits the seeded note', async () => {
    const view = await renderRoute({ kind: 'note', path: 'notes/new.md' })
    await expect.element(view.getByLabelText('Editing notes/new.md')).toBeInTheDocument()

    act(() => editorProbe.onChange?.('# Manifesto\n'))
    await act(() => flushOpenDocuments())

    // The seed's header rides along: the file is born with its identity
    // (`id:` frontmatter, Plan 17) plus exactly what the user typed.
    expect(files['notes/new.md']).toMatch(/^---\nid: [0-9a-z]{26}\n---\n# Manifesto\n$/)
  })

  it('opens a note the editor cannot round-trip as read-only, never editable', async () => {
    // Git conflict markers are a known meowdown converter gap (see roundtrip.ts).
    files['notes/conflict.md'] =
      '# Shared\n\n<<<<<<< this device\nedited on a\n=======\nedited on b\n>>>>>>> other device\n'
    const view = await renderRoute({ kind: 'note', path: 'notes/conflict.md' })

    await expect.element(view.getByText(/read-only to protect your file/)).toBeInTheDocument()
    await expect.element(view.getByTestId('fake-editor')).not.toBeInTheDocument()
    await expect.element(view.getByText(/edited on a/)).toBeInTheDocument()
  })

  it('renders the settings screen for the settings route', async () => {
    const view = await renderRoute({ kind: 'settings' })
    await expect.element(view.getByTestId('settings-screen')).toBeInTheDocument()
  })

  it('renders the chat screen for the chat route, not the stream', async () => {
    const view = await renderRoute({ kind: 'chat' })
    await expect.element(view.getByTestId('chat-screen')).toBeInTheDocument()
    await expect.element(view.getByTestId('daily-stream')).not.toBeInTheDocument()
  })

  it('renders the All Notes screen for the allNotes route, not the stream', async () => {
    const view = await renderRoute({ kind: 'allNotes', tag: null })
    await expect.element(view.getByLabelText('All notes')).toBeInTheDocument()
    await expect.element(view.getByTestId('daily-stream')).not.toBeInTheDocument()
    // The pinned filter tabs come from settings; the table header renders
    // once the (empty) index query settles.
    await expect.element(view.getByRole('button', { name: '#book' })).toBeInTheDocument()
    await expect.element(view.getByText('Subject')).toBeInTheDocument()
    await expect.element(view.getByText('No notes yet.')).toBeInTheDocument()
  })

  it('arriving on a search route opens the palette pre-filled over the stream', async () => {
    const view = await renderRoute({ kind: 'search', query: 'roadmap' })
    await expect.element(view.getByTestId('daily-stream')).toBeInTheDocument()
    await vi.waitFor(() =>
      expect(JSON.parse(view.getByTestId('palette').element().textContent ?? '')).toEqual({
        open: true,
        query: 'roadmap',
      }),
    )
  })
})
