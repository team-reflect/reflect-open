import { page } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { act } from '@/test-utils/act.ts'
import { upsertFrontmatter } from '@reflect/core'
import {
  createTestCoreServices,
  createTestIdService,
  createTestNoteFileService,
  createTestPlatformService,
  type TestNoteFileService,
  type TestPlatformOptions,
} from '@reflect/core/testing'
import { PaletteProvider, usePalette } from '@/components/command-palette/palette-provider.tsx'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import { NoteTemplatesProvider } from '@/providers/note-templates-provider.tsx'
import { ShortcutsProvider } from '@/providers/shortcuts-provider.tsx'
import { UpdateProvider } from '@/providers/update-provider.tsx'
import { V1ImportProvider } from '@/providers/v1-import-provider.tsx'
import type { Route } from '@/routing/route.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import '@/test-utils/locator.ts'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { RouteContent } from './route-content.tsx'

/**
 * The route → view seam (Plan 06): non-daily notes must be just as editable as
 * daily ones. These tests drive the real router → RouteContent → NotePane →
 * save-pipeline stack over the test services; only the ProseMirror view is
 * stubbed because editor-DOM behavior lives in the dedicated editor tests.
 */

const editorProbe = vi.hoisted(() => ({
  onChange: null as ((markdown: string) => void) | null,
  focusCalls: [] as string[],
  hoverRenderer: null as boolean | null,
}))

vi.mock('@/editor/note-editor.tsx', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    NoteEditor: ({
      initialContent,
      onChange,
      handleRef,
      renderWikilinkHoverCard,
    }: {
      initialContent: string
      onChange: (markdown: string) => void
      handleRef?: (handle: NoteEditorHandle | null) => void
      renderWikilinkHoverCard?: unknown
    }) => {
      editorProbe.hoverRenderer = renderWikilinkHoverCard !== undefined
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
          focus: () => {
            editorProbe.focusCalls.push('focus')
          },
          setSelection: () => {},
          getSelectedText: () => '',
          openSelectionMenu: () => {},
          startPendingReplacement: () => false,
          appendPendingReplacementText: () => {},
          acceptPendingReplacement: () => {},
          discardPendingReplacement: () => {},
          findNext: () => {},
          findPrevious: () => {},
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

/**
 * The note files a test seeds before it renders.
 */
let files: Record<string, string>
/**
 * The graph of the last render: the seeded files plus every write.
 */
let noteFile: TestNoteFileService
const NEW_NOTE_PATH = 'notes/01arz3ndektsv4rrffq69g5fav.md'

beforeEach(() => {
  files = {}
  editorProbe.onChange = null
  editorProbe.focusCalls.length = 0
  editorProbe.hoverRenderer = null
})

function PaletteProbe(): ReactElement {
  const { open, query } = usePalette()
  return <output data-testid="palette">{JSON.stringify({ open, query })}</output>
}

async function renderRoute(route: Route, platform?: TestPlatformOptions) {
  noteFile = createTestNoteFileService({ files })
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile,
    // A seeded id service mints note ids that read as ULIDs, not as numbers.
    id: createTestIdService({ seed: 'route-content' }),
    platform: createTestPlatformService(platform),
  })
  return await renderInApp(
    <PaletteProvider>
      {/* A bounded viewport, like the app shell's: the stream virtualizes its rows. */}
      <div style={{ height: 800 }}>
        <RouteContent />
      </div>
      <PaletteProbe />
    </PaletteProvider>,
    {
      core,
      graph: { root: '/g', name: 'g', generation: 1 },
      settings: { editorMarkdownSyntax: 'hide', allNotesFilterTags: ['book', 'link', 'person'] },
      route,
      // The providers the settings screen reads.
      wrapper: (children) => (
        <UpdateProvider autoCheck={false}>
          <ShortcutsProvider>
            <NoteTemplatesProvider>
              <V1ImportProvider>{children}</V1ImportProvider>
            </NoteTemplatesProvider>
          </ShortcutsProvider>
        </UpdateProvider>
      ),
    },
  )
}

describe('RouteContent', () => {
  it('renders the daily stream for the today route', async () => {
    const view = await renderRoute({ kind: 'today' })
    await expect.element(page.getByTestId('daily-stream')).toBeInTheDocument()
    await view.unmount()
  })

  it('renders the daily stream for a daily route, surviving a malformed date', async () => {
    const view = await renderRoute({ kind: 'daily', date: '2026-02-31' })
    await expect.element(page.getByTestId('daily-stream')).toBeInTheDocument()
    await view.unmount()
  })

  it('renders an existing non-daily note as an editable pane, not the stream', async () => {
    files['notes/exist.md'] = '# Hello\n\nWorld.\n'
    const view = await renderRoute({ kind: 'note', path: 'notes/exist.md' })

    await expect.element(page.getByLabelText('Editing notes/exist.md')).toBeVisible()
    await expect.element(page.getByTestId('daily-stream')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('fake-editor')).toMatchTextContent('# Hello')
    expect(editorProbe.hoverRenderer).toBe(true)

    // The navigated-to note takes focus on mount.
    await vi.waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))
    await view.unmount()
  })

  it('tracks an adopted nested note retitle while keeping its path', async () => {
    const path = 'Projects/exist.md'
    files[path] = '# Old Title\n'
    const view = await renderRoute({ kind: 'note', path })
    await expect.element(page.getByLabelText(`Editing ${path}`)).toBeVisible()

    await act(() => editorProbe.onChange?.('# New Title\n'))
    await act(() => view.core.openDocuments.flushAll())

    expect(noteFile.files().get(path)).toBe(
      upsertFrontmatter('# New Title\n', {
        aliases: ['Old Title'],
      }),
    )
    expect(noteFile.files().get('notes/new-title.md')).toBeUndefined()
    await view.unmount()
  })

  it('omits the wiki-link hover renderer on a touch editor surface', async () => {
    files['notes/exist.md'] = '# Hello\n'
    const view = await renderRoute(
      { kind: 'note', path: 'notes/exist.md' },
      { surface: { touchEditor: true } },
    )

    await expect.element(page.getByLabelText('Editing notes/exist.md')).toBeVisible()
    expect(editorProbe.hoverRenderer).toBe(false)
    await view.unmount()
  })

  it('opens a missing note seeded with an empty focused title, writing nothing', async () => {
    const view = await renderRoute({ kind: 'note', path: NEW_NOTE_PATH })

    await expect.element(page.getByLabelText(`Editing ${NEW_NOTE_PATH}`)).toBeVisible()
    // The seed is an empty H1: the caret lands in it (plain focus, no text
    // to select) and the title placeholder ghosts "Untitled" over the line.
    expect(page.getByTestId('fake-editor').element().textContent).toBe('#\n')
    await vi.waitFor(() => expect(editorProbe.focusCalls).toContain('focus'))

    // Opening never litters the graph — even a forced flush writes nothing.
    await act(() => view.core.openDocuments.flushAll())
    expect(noteFile.writes()).toEqual([])
    expect(noteFile.files().get(NEW_NOTE_PATH)).toBeUndefined()
    await view.unmount()
  })

  it('creates the file once the user actually edits the seeded note', async () => {
    const view = await renderRoute({ kind: 'note', path: NEW_NOTE_PATH })
    await expect.element(page.getByLabelText(`Editing ${NEW_NOTE_PATH}`)).toBeVisible()

    await act(() => editorProbe.onChange?.('# Manifesto\n'))
    await act(() => view.core.openDocuments.flushAll())

    // The seed's header rides along: the file is born with its identity
    // (`id:` frontmatter, Plan 17) plus exactly what the user typed.
    expect(noteFile.files().get(NEW_NOTE_PATH)).toMatch(
      /^---\nid: [0-9a-z]{26}\n---\n\n# Manifesto\n$/,
    )
    await view.unmount()
  })

  it('never recreates an arbitrary missing vault path', async () => {
    const view = await renderRoute({ kind: 'note', path: 'Projects/missing.md' })

    await expect
      .element(
        page.getByText(/Couldn’t open Projects\/missing\.md: Projects\/missing\.md not found/),
      )
      .toBeVisible()
    await expect.element(page.getByTestId('fake-editor')).not.toBeInTheDocument()
    await act(() => view.core.openDocuments.flushAll())
    expect(noteFile.writes()).toEqual([])
    expect(noteFile.files().get('Projects/missing.md')).toBeUndefined()
    await view.unmount()
  })

  it('renders the settings screen for the settings route', async () => {
    const view = await renderRoute({ kind: 'settings' })
    await expect.element(page.getByTestId('settings-screen')).toBeInTheDocument()
    await view.unmount()
  })

  it('renders the chat screen for the chat route, not the stream', async () => {
    const view = await renderRoute({ kind: 'chat' })
    await expect.element(page.getByTestId('chat-screen')).toBeInTheDocument()
    await expect.element(page.getByTestId('daily-stream')).not.toBeInTheDocument()
    await view.unmount()
  })

  it('renders the All Notes screen for the allNotes route, not the stream', async () => {
    const view = await renderRoute({ kind: 'allNotes', tag: null })
    await expect.element(page.getByLabelText('All notes')).toBeVisible()
    await expect.element(page.getByTestId('daily-stream')).not.toBeInTheDocument()
    // The pinned filter tabs come from settings; the table header renders
    // once the (empty) index query settles.
    await expect.element(page.getByRole('button', { name: '#book' })).toBeVisible()
    await expect.element(page.getByText('Subject')).toBeVisible()
    await expect.element(page.getByText('No notes yet.')).toBeVisible()
    await view.unmount()
  })

  it('arriving on a search route opens the palette pre-filled over the stream', async () => {
    const view = await renderRoute({ kind: 'search', query: 'roadmap' })
    await expect.element(page.getByTestId('daily-stream')).toBeInTheDocument()
    await vi.waitFor(() => {
      expect(JSON.parse(page.getByTestId('palette').element().textContent ?? '')).toEqual({
        open: true,
        query: 'roadmap',
      })
    })
    await view.unmount()
  })
})
