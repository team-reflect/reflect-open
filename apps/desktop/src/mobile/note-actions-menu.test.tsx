import type { ShareService } from '@reflect/app'
import {
  frontmatterPatchToYaml,
  isOstensiblyEmptyNoteSource,
  upsertFrontmatter,
  type IndexQueryService,
  type NoteActionsService,
  type NoteDocumentService,
  type NoteRow,
  AppError,
} from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import type { ReactElement, ReactNode } from 'react'
import { act } from '@/test-utils/act.ts'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { NoteActionsMenu } from './note-actions-menu.tsx'

// What the app's fakes answer; each test sets them before `mount`.
const getNote = vi.fn<IndexQueryService['getNote']>()
const readNoteSource = vi.fn<NoteDocumentService['readSource']>()
const commitNoteFrontmatter = vi.fn<NoteDocumentService['commitFrontmatter']>()
const shareMock = vi.fn<(data: ShareData) => Promise<void>>()
const SHARED = { title: 'meeting', text: '# Meeting\n' }
const noteSource = { value: '# A\n' }

// The services of the rendered app; set by `mount`.
let app: TestCoreServices
let trash: MockInstance<NoteActionsService['trashOne']>
let noteContent: MockInstance<ShareService['noteContent']>

/**
 * The mobile note actions drawer: pin/share/delete already live here; this
 * suite adds privacy parity coverage against mocked index state and canonical
 * toggle helpers so close/reopen and failure rollback are exercised directly.
 * Delete routes through the shared {@link NoteDeleteDrawer}; the graph comes
 * from a mutable store so the no-graph failure path can be exercised too.
 *
 * The real drawer's drag/animation is covered elsewhere and on-device. This
 * mock honours `open` and the trigger contract so the tests can verify that
 * actions close the sheet and that reopened content reflects bridged state.
 */
vi.mock('@/components/ui/drawer.tsx', async () => {
  const React = await import('react')
  const DrawerContext = React.createContext<{
    open: boolean
    onOpenChange: ((open: boolean) => void) | undefined
  }>({ open: false, onOpenChange: undefined })

  function useDrawerContext() {
    return React.use(DrawerContext)
  }

  return {
    Drawer: ({
      open = false,
      onOpenChange,
      children,
    }: {
      open?: boolean
      onOpenChange?: (open: boolean) => void
      children?: ReactNode
    }) => <DrawerContext value={{ open, onOpenChange }}>{children}</DrawerContext>,
    DrawerTrigger: ({ children, render }: { children?: ReactNode; render?: ReactElement }) => {
      const { onOpenChange } = useDrawerContext()
      if (
        render !== undefined &&
        React.isValidElement<{ 'aria-label'?: string; className?: string }>(render)
      ) {
        return (
          <button
            type="button"
            aria-label={render.props['aria-label']}
            className={render.props.className}
            onClick={() => onOpenChange?.(true)}
          >
            {children}
          </button>
        )
      }
      return (
        <button type="button" onClick={() => onOpenChange?.(true)}>
          {children}
        </button>
      )
    },
    DrawerContent: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => {
      const { open } = useDrawerContext()
      return open ? (
        <div role="dialog" data-slot="drawer-content" {...props}>
          {children}
        </div>
      ) : null
    },
    DrawerBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    DrawerDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
    DrawerTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
  }
})

let currentNoteRow: NoteRow | null
let currentNoteRowSettled: boolean

function noteRow(path: string, isPrivate: boolean, title = 'Meeting'): NoteRow {
  return {
    path,
    title,
    dailyDate: null,
    isPrivate,
    gistUrl: null,
    gistStale: false,
  }
}

beforeEach(() => {
  currentNoteRow = noteRow('notes/meeting.md', false)
  currentNoteRowSettled = true
  getNote
    .mockReset()
    .mockImplementation(() =>
      currentNoteRowSettled ? Promise.resolve(currentNoteRow ?? undefined) : new Promise(() => {}),
    )
  noteSource.value = '# A\n'
  readNoteSource.mockReset().mockImplementation(() => Promise.resolve(noteSource.value))
  commitNoteFrontmatter.mockReset().mockImplementation((_path, patch) =>
    Promise.try(() => {
      noteSource.value = upsertFrontmatter(noteSource.value, frontmatterPatchToYaml(patch))
    }),
  )
  shareMock.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'share', { configurable: true, value: shareMock })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'share')
})

async function mount(path = 'notes/meeting.md', onDeleted = vi.fn()) {
  const created = createTestCoreServices({
    noteDocuments: {
      readSource: readNoteSource,
      readExisting: async (notePath) => await readNoteSource(notePath),
      commitFrontmatter: commitNoteFrontmatter,
      commitSourceEdit: () => Promise.reject(new Error('commitSourceEdit is not stubbed')),
      isOstensiblyEmpty: isOstensiblyEmptyNoteSource,
    },
  })
  vi.spyOn(created.indexQuery, 'getNote').mockImplementation(getNote)
  vi.spyOn(created.indexQuery, 'getPinnedNotes').mockResolvedValue([])
  trash = vi.spyOn(created.noteActions, 'trashOne').mockResolvedValue()
  const view = await renderInApp(<NoteActionsMenu path={path} onDeleted={onDeleted} />, {
    app: created,
    graph: { root: '/g', name: 'g', generation: 7 },
  })
  app = view.app
  noteContent = vi.spyOn(view.appServices.share, 'noteContent').mockReturnValue(SHARED)
  return { view, onDeleted, client: view.queryClient }
}

async function openActions(): Promise<void> {
  await page.getByRole('button', { name: 'Note actions' }).click()
}

describe('NoteActionsMenu', () => {
  it('offers Lock note for a public note, toggles canonically, and closes the drawer', async () => {
    const { view } = await mount()

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Lock note' })).toBeInTheDocument()

    await view.getByRole('button', { name: 'Lock note' }).click()

    await vi.waitFor(() =>
      expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/meeting.md', { private: true }, 7),
    )
    await expect.element(view.getByRole('button', { name: 'Lock note' })).not.toBeInTheDocument()
  })

  it('offers Unlock note for a private daily note and toggles canonically', async () => {
    currentNoteRow = noteRow('daily/2026-06-10.md', true, 'June 10th, 2026')
    noteSource.value = '---\nprivate: true\n---\n# A\n'
    const { view } = await mount('daily/2026-06-10.md')

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Unlock note' })).toBeInTheDocument()

    await view.getByRole('button', { name: 'Unlock note' }).click()

    await vi.waitFor(() =>
      expect(commitNoteFrontmatter).toHaveBeenCalledWith(
        'daily/2026-06-10.md',
        { private: false },
        7,
      ),
    )
  })

  it('bridges the privacy label from the toggle result while the index is stale', async () => {
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Lock note' }).click()
    await vi.waitFor(() => expect(commitNoteFrontmatter).toHaveBeenCalledTimes(1))

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Unlock note' })).toBeInTheDocument()

    noteSource.value = '---\nprivate: true\n---\n# A\n'
    await view.getByRole('button', { name: 'Unlock note' }).click()
    await vi.waitFor(() => expect(commitNoteFrontmatter).toHaveBeenCalledTimes(2))

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Lock note' })).toBeInTheDocument()
  })

  it('shows shared privacy on reopening while a menu write is still pending', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const { view } = await mount()
    await openActions()
    await view.getByRole('button', { name: 'Lock note' }).click()
    await openActions()
    await expect.element(view.getByRole('button', { name: 'Unlock note' })).toBeInTheDocument()
    write.resolve()
    await write.promise
  })

  it('rolls back stale optimistic privacy state and surfaces failures for retry', async () => {
    commitNoteFrontmatter.mockRejectedValueOnce(new AppError('io', 'disk on fire'))
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Lock note' }).click()

    await vi.waitFor(() =>
      expect(app.progress.findByLabel('Updating privacy')).toMatchObject({
        status: 'failed',
        message: 'disk on fire',
      }),
    )
    await expect.element(view.getByRole('button', { name: 'Lock note' })).not.toBeInTheDocument()

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Lock note' })).toBeInTheDocument()
  })

  it('disables the privacy action until the note row query settles', async () => {
    currentNoteRow = null
    currentNoteRowSettled = false
    const { view } = await mount()

    await openActions()
    await expect.element(view.getByRole('button', { name: 'Loading privacy…' })).toBeDisabled()
    expect(commitNoteFrontmatter).not.toHaveBeenCalled()
  })

  it('offers Lock note for a visible note with no indexed row yet', async () => {
    currentNoteRow = null
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Lock note' }).click()

    await vi.waitFor(() =>
      expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/meeting.md', { private: true }, 7),
    )
  })

  it('shows Unpin on reopening while the pin write is still pending', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const { view } = await mount()
    await openActions()
    await view.getByRole('button', { name: 'Pin', exact: true }).click()
    await vi.waitFor(() =>
      expect(view.app.noteRows.getOverlay('notes/meeting.md')).toMatchObject({ isPinned: true }),
    )
    await openActions()
    await expect
      .element(view.getByRole('button', { name: 'Unpin', exact: true }))
      .toBeInTheDocument()
    write.resolve()
    await write.promise
  })

  it('keeps the pin action intact and closes the drawer', async () => {
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Pin' }).click()

    await vi.waitFor(() =>
      expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/meeting.md', { pinned: 1024 }, 7),
    )
    await expect.element(view.getByRole('button', { name: 'Pin' })).not.toBeInTheDocument()
  })

  it('keeps the share action intact and closes the drawer', async () => {
    const { view } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Share' }).click()

    await vi.waitFor(() => expect(shareMock).toHaveBeenCalledWith(SHARED))
    expect(noteContent).toHaveBeenCalledWith('notes/meeting.md')
    await expect.element(view.getByRole('button', { name: 'Share' })).not.toBeInTheDocument()
  })

  it('deletes after confirmation and notifies the screen', async () => {
    const { view, onDeleted } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Delete' }).click()

    const dialog = page.getByRole('dialog')
    await expect.element(dialog).toHaveAttribute('data-slot', 'drawer-content')
    await dialog.getByRole('button', { name: 'Delete' }).click()

    await vi.waitFor(() => expect(trash).toHaveBeenCalledWith('notes/meeting.md'))
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('reports when the graph disappears before delete confirmation', async () => {
    const { view, onDeleted } = await mount()

    await openActions()
    await view.getByRole('button', { name: 'Delete' }).click()

    const dialog = page.getByRole('dialog')
    // The real trash reports the missing graph.
    trash.mockRestore()
    await act(() => app.graphSession.setGraph(null))
    await dialog.getByRole('button', { name: 'Delete' }).click()

    await expect.element(dialog.getByText('No graph is open.')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
  })
})
