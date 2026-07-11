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
  const { useEffect, useRef } = await import('react')
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
      const markdownRef = useRef(initialContent)
      editorProbe.onChange = (markdown) => {
        markdownRef.current = markdown
        onChange(markdown)
      }
      useEffect(() => {
        handleRef?.({
          setMarkdown: (markdown) => {
            markdownRef.current = markdown
          },
          getMarkdown: () => markdownRef.current,
          insertMarkdown: () => {},
          focus: () => editorProbe.focusCalls.push('focus'),
          setSelection: () => {},
          getSelectedText: () => '',
          openSelectionMenu: () => {},
          startPendingReplacement: () => false,
          appendPendingReplacementText: () => {},
          acceptPendingReplacement: () => {},
          discardPendingReplacement: () => {},
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
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({
    settings: {
      editorMarkdownSyntax: 'hide',
      allNotesFilterTags: ['book', 'link', 'person'],
      aiProviders: [],
      defaultAiProviderId: null,
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
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

    // The navigated-to note takes focus on mount.
    await waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))
    view.unmount()
  })

  it('opens a missing note seeded with an empty focused title, writing nothing', async () => {
    const view = renderRoute({ kind: 'note', path: 'notes/new.md' })

    await view.findByLabelText('Editing notes/new.md')
    // The seed is an empty H1: the caret lands in it (plain focus, no text
    // to select) and the title placeholder ghosts "Untitled" over the line.
    expect(view.getByTestId('fake-editor').textContent).toBe('#\n')
    await waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))

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

    // The seed's header rides along: the file is born with its identity
    // (`id:` frontmatter, Plan 17) plus exactly what the user typed.
    expect(files['notes/new.md']).toMatch(/^---\nid: [0-9a-z]{26}\n---\n# Manifesto\n$/)
    view.unmount()
  })

  it('opens a note the editor cannot round-trip as read-only, never editable', async () => {
    // Git conflict markers are a known meowdown converter gap (see roundtrip.ts),
    // and get their own view: both sides shown, labeled by the marker names.
    files['notes/conflict.md'] =
      '# Shared\n\n<<<<<<< this device\nedited on a\n=======\nedited on b\n>>>>>>> other device\n'
    const view = renderRoute({ kind: 'note', path: 'notes/conflict.md' })

    await view.findByText(/edited on a/)
    expect(view.queryByTestId('fake-editor')).toBeNull()
    expect(view.getByText('this device')).toBeDefined()
    expect(view.getByText('other device')).toBeDefined()
    expect(view.getByText(/edited on b/)).toBeDefined()
    view.unmount()
  })

  it('renders the settings screen for the settings route', () => {
    const view = renderRoute({ kind: 'settings' })
    expect(view.getByTestId('settings-screen')).toBeDefined()
    view.unmount()
  })

  it('renders the chat screen for the chat route, not the stream', () => {
    const view = renderRoute({ kind: 'chat' })
    expect(view.getByTestId('chat-screen')).toBeDefined()
    expect(view.queryByTestId('daily-stream')).toBeNull()
    view.unmount()
  })

  it('renders the All Notes screen for the allNotes route, not the stream', async () => {
    const view = renderRoute({ kind: 'allNotes', tag: null })
    expect(view.getByLabelText('All notes')).toBeDefined()
    expect(view.queryByTestId('daily-stream')).toBeNull()
    // The pinned filter tabs come from settings; the table header renders
    // once the (empty) index query settles.
    expect(view.getByRole('button', { name: '#book' })).toBeDefined()
    await view.findByText('Subject')
    expect(view.getByText('No notes yet.')).toBeDefined()
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
