import { page, userEvent } from 'vitest/browser'
import { startTransition, useState, type ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { upsertFrontmatter } from '@reflect/core'
import type { ResolvedArchivedPost } from '@reflect/core/x-archive'
import {
  createTestClockService,
  createTestCoreServices,
  createTestIdService,
  createTestNoteFileService,
  seedNotes,
  type TestCoreServices,
} from '@reflect/core/testing'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry.ts'
import { queryClient } from '@/lib/query-client.ts'
import { act } from '@/test-utils/act.ts'
import '@/test-utils/locator.ts'
import { hover, unhover } from '@/test-utils/mouse.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { NotePane } from './note-pane.tsx'

const NEW_NOTE_PATH = 'notes/01arz3ndektsv4rrffq69g5fav.md'

function note(title: string): string {
  return `# ${title}\n\n${title} body\n`
}

function privateNote(title: string): string {
  return `---\nprivate: true\n---\n\n${note(title)}`
}

function archivedPost(id: string, text: string): ResolvedArchivedPost {
  return {
    archive: {
      kind: 'x-post',
      capturedAt: '2026-09-14T00:00:00Z',
      data: {
        id,
        createdAt: '2026-09-14T00:00:00Z',
        author: { name: 'Jack', handle: 'jack' },
        body: [{ type: 'text', text }],
      },
    },
    resources: [],
  }
}

const editor = () => page.locate('.ProseMirror')

interface RenderPaneOptions {
  /** Note files on disk. */
  files: Record<string, string>
  /** The note the pane opens. */
  path: string
  /** Files that also have an index row. Default: every file. */
  indexed?: readonly string[] | undefined
  lazy?: boolean | undefined
  autoFocus?: boolean | undefined
  /** Spies go here: the providers read services during the first render. */
  prepare?: ((core: TestCoreServices) => void) | undefined
}

/**
 * Render one `NotePane` with the real editor over test services.
 */
async function renderPane(options: RenderPaneOptions) {
  const { files, path, indexed = Object.keys(files), lazy, autoFocus, prepare } = options
  const clock = createTestClockService()
  const noteFile = createTestNoteFileService({ files })
  const database = createWasmTestDatabaseService()
  seedNotes(
    database,
    indexed.map((indexedPath) => ({ path: indexedPath, markdown: files[indexedPath] ?? '' })),
  )
  const core = createTestCoreServices({
    database,
    noteFile,
    clock,
    id: createTestIdService({ seed: 'note-pane' }),
  })
  prepare?.(core)
  let setPath: (path: string) => void = () => {}
  function Pane(): ReactElement {
    const [panePath, setPanePath] = useState(path)
    setPath = setPanePath
    return <NotePane path={panePath} lazy={lazy} autoFocus={autoFocus} />
  }
  await renderInApp(
    <PaletteProvider>
      <Pane />
    </PaletteProvider>,
    {
      core,
      queryClient,
      graph: { root: '/g', name: 'g', generation: 1 },
      settings: { editorMarkdownSyntax: 'hide' },
    },
  )
  /**
   * Point the pane at another note in a transition, as router navigation does,
   * and wait for its body.
   */
  const switchTo = async (nextPath: string, title: string): Promise<void> => {
    startTransition(() => setPath(nextPath))
    await expect.element(page.getByText(`${title} body`)).toBeVisible()
  }
  return { core, noteFile, clock, switchTo }
}

describe('NotePane', () => {
  describe('note switch', () => {
    it('shows the note it opened, and edits there never take another note’s body', async () => {
      const { noteFile, clock, switchTo } = await renderPane({
        files: {
          'notes/alpha.md': note('Alpha'),
          'notes/beta.md': note('Beta'),
          'notes/gamma.md': note('Gamma'),
        },
        path: 'notes/alpha.md',
        // With no index rows yet, the switch races each note's load.
        indexed: [],
      })
      await expect.element(page.getByText('Alpha body')).toBeVisible()

      await switchTo('notes/beta.md', 'Beta')
      await switchTo('notes/gamma.md', 'Gamma')
      await expect.element(page.getByText('Beta body')).not.toBeInTheDocument()

      const gammaEditor = noteEditorHandleFor('notes/gamma.md')
      expect(gammaEditor).not.toBeNull()
      // Flush pending effects first: the editor registers its change listener in one.
      await act(() => {})
      gammaEditor?.insertMarkdown('typed ')
      await clock.advance(2000)

      const gamma = noteFile.files().get('notes/gamma.md')
      expect(gamma).toContain('typed ')
      expect(gamma).toContain('Gamma body')
      expect(gamma).not.toContain('Beta body')
      expect(noteFile.files().get('notes/beta.md')).toBe(note('Beta'))
    })

    it('keeps the next note out of AI until its own privacy is known', async () => {
      const { core, switchTo } = await renderPane({
        files: { 'notes/alpha.md': note('Alpha'), 'notes/beta.md': privateNote('Beta') },
        path: 'notes/alpha.md',
        // Beta is not indexed yet (mid-index, or just synced): its row never resolves.
        indexed: ['notes/alpha.md'],
      })
      await expect.element(page.getByText('Alpha body')).toBeVisible()
      await core.aiProviderConfig.add({
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        apiKey: 'sk-ant-test-1234',
        isDefault: true,
      })
      const transform = vi.spyOn(core.selectionTransform, 'transform')
      const sentFrom = (): unknown[] => {
        return transform.mock.calls.map(([request]) => request.note)
      }
      const runPromptOnSelection = async (): Promise<void> => {
        await editor().click()
        await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
        await userEvent.keyboard('{ControlOrMeta>}{Shift>}j{/Shift}{/ControlOrMeta}')
        await userEvent.keyboard('Summarise')
      }

      // The public note offers the menu, and a prompt runs on its text.
      await runPromptOnSelection()
      await expect.element(page.getByText('Run as a prompt')).toBeVisible()
      await userEvent.keyboard('{Enter}')
      await vi.waitFor(() => {
        expect(sentFrom()).toEqual([{ path: 'notes/alpha.md', isPrivate: false }])
      })

      // With no row yet the private note fails closed: no menu, nothing sent.
      await switchTo('notes/beta.md', 'Beta')
      await runPromptOnSelection()
      await expect.element(page.getByText('Run as a prompt')).not.toBeInTheDocument()
      expect(sentFrom()).toHaveLength(1)
    })
  })

  describe('lazy creation', () => {
    it('opens a missing new note seeded with an empty focused title, writing nothing', async () => {
      const { core, noteFile } = await renderPane({
        files: {},
        path: NEW_NOTE_PATH,
        lazy: true,
        autoFocus: true,
      })

      // The caret lands in the seed's empty H1, ghosted "Untitled".
      await expect.element(editor().locate('h1')).toHaveTextContent('')
      await expect.element(editor()).toHaveFocus()
      await act(() => core.openDocuments.flushAll())
      expect(noteFile.writes()).toEqual([])
    })

    it('creates the file once the user types into the seeded note', async () => {
      const { core, noteFile } = await renderPane({
        files: {},
        path: NEW_NOTE_PATH,
        lazy: true,
        autoFocus: true,
      })
      await expect.element(editor()).toHaveFocus()

      await userEvent.keyboard('Manifesto')
      await act(() => core.openDocuments.flushAll())

      // The file is born with the seed's `id:` frontmatter plus what the user typed.
      expect(noteFile.files().get(NEW_NOTE_PATH)).toMatch(
        /^---\nid: [0-9a-z]{26}\n---\n\n# Manifesto\n$/,
      )
    })

    it('never recreates an arbitrary missing vault path', async () => {
      const { core, noteFile } = await renderPane({
        files: {},
        path: 'Projects/missing.md',
        lazy: true,
      })

      await expect
        .element(
          page.getByText(/Couldn’t open Projects\/missing\.md: Projects\/missing\.md not found/),
        )
        .toBeVisible()
      await expect.element(editor()).not.toBeInTheDocument()
      await act(() => core.openDocuments.flushAll())
      expect(noteFile.writes()).toEqual([])
    })
  })

  it('puts the caret at the end of an existing title', async () => {
    const path = 'notes/exist.md'
    const { core, noteFile } = await renderPane({
      files: { [path]: '# Hello\n\nWorld\n' },
      path,
      autoFocus: true,
    })
    await expect.element(editor()).toHaveFocus()

    await userEvent.keyboard('{Enter}Body')
    await act(() => core.openDocuments.flushAll())

    expect(noteFile.files().get(path)).toBe('# Hello\n\n- Body\n\nWorld\n')
  })

  it('tracks an adopted nested note retitle while keeping its path', async () => {
    const path = 'Projects/exist.md'
    const { core, noteFile } = await renderPane({
      files: { [path]: '# Old Title\n' },
      path,
      autoFocus: true,
    })
    await expect.element(editor()).toHaveFocus()

    await userEvent.keyboard('{ControlOrMeta>}a{/ControlOrMeta}')
    await userEvent.keyboard('# New Title')
    await act(() => core.openDocuments.flushAll())

    expect(noteFile.files().get(path)).toBe(
      upsertFrontmatter('# New Title\n', { aliases: ['Old Title'] }),
    )
    expect(noteFile.files().get('notes/new-title.md')).toBeUndefined()
  })

  it('previews a linked note when its wiki link is hovered', async () => {
    await renderPane({
      files: {
        'notes/exist.md': '# Hello\n\nWorld [[Other]].\n',
        'notes/other.md': '# Other\n\nOther body\n',
      },
      path: 'notes/exist.md',
    })
    // Park the mouse first: an editor that mounts under it misses the first hover.
    await unhover()
    await hover(editor().getByTestId('wikilink'))
    await expect.element(page.getByText('Other body'), { timeout: 5_000 }).toBeVisible()
  })

  describe('X post preload', () => {
    function resolveArchiveWith(resolve: (postId: string) => Promise<ResolvedArchivedPost | null>) {
      return (core: TestCoreServices): void => {
        vi.spyOn(core.xArchive, 'resolve').mockImplementation(
          async (_generation, postId) => await resolve(postId),
        )
      }
    }

    // Every rendered state is observed before it can paint.
    function watchLoadingCards(): { seen: boolean; stop: () => void } {
      const watch = { seen: false, stop: () => observer.disconnect() }
      const observer = new MutationObserver(() => {
        if (document.querySelector('post-embed-x-post [data-pending]')) watch.seen = true
      })
      observer.observe(document.body, { subtree: true, childList: true, attributes: true })
      return watch
    }

    it('renders archived X posts in the first frame of the editor', async () => {
      const loadingCards = watchLoadingCards()
      await renderPane({
        files: { 'notes/tweets.md': '![](https://x.com/jack/status/101)\n' },
        path: 'notes/tweets.md',
        prepare: resolveArchiveWith(async (postId) => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return archivedPost(postId, 'Archived first')
        }),
      })

      await expect.element(page.getByText('Archived first')).toBeVisible()
      loadingCards.stop()
      expect(loadingCards.seen).toBe(false)
    })

    it('mounts the editor once the wait runs out for a slow archive', async () => {
      await renderPane({
        files: { 'notes/slow.md': 'Slow note\n\n![](https://x.com/jack/status/102)\n' },
        path: 'notes/slow.md',
        prepare: resolveArchiveWith(() => new Promise(() => {})),
      })

      await expect.element(page.getByText('Slow note')).toBeVisible()
      await expect.element(page.getByText('Loading this post…')).toBeVisible()
    })
  })
})
