import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
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
import { createTestCoreServices, createTestPlatformService } from '@reflect/core/testing'
import { createTestOperationsService, type TestOperationsService } from '@reflect/app/testing'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { NoteActionsSection } from './note-actions-section.tsx'

// What the app's fakes answer; each test sets them before `renderSection`.
const getPinnedNotes = vi.fn<IndexQueryService['getPinnedNotes']>()
const getNote = vi.fn<IndexQueryService['getNote']>()
const readNoteSource = vi.fn<NoteDocumentService['readSource']>()
const commitNoteFrontmatter = vi.fn<NoteDocumentService['commitFrontmatter']>()
let noteSource: string

// The services of the rendered app; set by `renderSection`.
let operations: TestOperationsService
let trash: MockInstance<NoteActionsService['trashOne']>

/**
 * The shelf as the sidebar reads it, as comma-joined titles.
 */
function PinnedTitles() {
  const titles = usePinnedNotes().map((note) => note.title)
  return <output data-testid="pinned" data-titles={titles.join(',')} />
}

function pinnedTitles(): string | null {
  return page.getByTestId('pinned').element().getAttribute('data-titles')
}

async function renderSection(path: string, showTrash = false, copies = 1) {
  operations = createTestOperationsService()
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    progress: operations,
    noteDocuments: {
      readSource: readNoteSource,
      readExisting: async (notePath) => await readNoteSource(notePath),
      commitFrontmatter: commitNoteFrontmatter,
      commitSourceEdit: () => Promise.reject(new Error('commitSourceEdit is not stubbed')),
      isOstensiblyEmpty: isOstensiblyEmptyNoteSource,
    },
    platform: createTestPlatformService({
      isNativeShell: false,
      isMacosDesktop: false,
      isApplePlatform: false,
      hasMacosTitleBarOverlay: false,
    }),
  })
  vi.spyOn(core.indexQuery, 'getPinnedNotes').mockImplementation(getPinnedNotes)
  vi.spyOn(core.indexQuery, 'getNote').mockImplementation(getNote)
  trash = vi.spyOn(core.noteActions, 'trashOne').mockResolvedValue()
  const view = await renderInApp(
    <>
      {Array.from({ length: copies }, (_, copy) => (
        <div key={copy} data-testid={`copy-${copy}`}>
          <NoteActionsSection path={path} showTrash={showTrash} />
        </div>
      ))}
      <PinnedTitles />
    </>,
    {
      core,
      graph: { root: '/g', name: 'g', generation: 7 },
      route: { kind: 'note', path },
    },
  )
  return Object.assign(view, { client: view.queryClient })
}

beforeEach(() => {
  getPinnedNotes.mockReset().mockResolvedValue([])
  getNote.mockReset().mockResolvedValue(noteRow('notes/a.md', false))
  noteSource = '# A\n'
  readNoteSource.mockReset().mockImplementation(() => Promise.resolve(noteSource))
  commitNoteFrontmatter.mockReset().mockImplementation((_path, patch) => {
    return Promise.try(() => {
      noteSource = upsertFrontmatter(noteSource, frontmatterPatchToYaml(patch))
    })
  })
})

function noteRow(path: string, isPrivate: boolean, title = 'A'): NoteRow {
  return {
    path,
    title,
    dailyDate: null,
    isPrivate,
    gistUrl: null,
    gistStale: false,
  }
}

describe('NoteActionsSection pin toggle', () => {
  it('offers Pin this note with the platform-formatted hint and toggles on click', async () => {
    const view = await renderSection('notes/a.md')
    const button = view.getByRole('button', { name: /Pin this note/ })
    // The mocked platform is non-Apple, so Mod renders as Ctrl.
    expect(button.element().textContent).toContain('CtrlO')
    await userEvent.click(button)
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/a.md', { pinned: 1024 }, 7)
  })

  it('offers Un-pin this note when the index lists the note as pinned', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'daily/2026-06-10.md', title: 'June 10th, 2026', dailyDate: '2026-06-10' },
    ])
    noteSource = '---\npinned: true\n---\n# A\n'
    const view = await renderSection('daily/2026-06-10.md')
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('daily/2026-06-10.md', { pinned: false }, 7)
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    // The index still reports unpinned; the toggle's resolved state bridges
    // the watcher round-trip so a second click can't invert the user's intent.
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    noteSource = '---\npinned: true\n---\n# A\n'
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    await expect.element(view.getByText('Pin this note', { exact: true })).toBeInTheDocument()
    expect(commitNoteFrontmatter).toHaveBeenCalledTimes(2)
  })

  it('updates the button and shelf while the pin write is still pending', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const view = await renderSection('notes/a.md')
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(1))
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    expect(pinnedTitles()).toBe('A')
    write.resolve()
    await write.promise
  })

  it('optimistically adds a newly pinned note after explicitly ordered pins', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/zeta.md', title: 'Zeta', dailyDate: null, pinnedOrder: 0 },
      { path: 'notes/alpha.md', title: 'Alpha', dailyDate: null, pinnedOrder: 1 },
    ])
    getNote.mockResolvedValue(noteRow('notes/mid.md', false, 'Mid'))
    const view = await renderSection('notes/mid.md')
    await vi.waitFor(() => expect(pinnedTitles()).toBe('Zeta,Alpha'))

    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))

    await vi.waitFor(() => expect(pinnedTitles()).toBe('Zeta,Alpha,Mid'))
  })

  it('reverts the pin when the write fails', async () => {
    let rejectToggle!: (cause: unknown) => void
    commitNoteFrontmatter.mockImplementationOnce(() => {
      return new Promise<void>((_resolve, reject) => {
        rejectToggle = reject
      })
    })
    const view = await renderSection('notes/a.md')
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(1))

    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    rejectToggle({ kind: 'io', message: 'disk on fire' })

    await expect.element(view.getByText('Pin this note', { exact: true })).toBeInTheDocument()
    expect(pinnedTitles()).toBe('')
    expect(operations.findByLabel('Updating pin')?.status).toBe('failed')
  })
})

describe('NoteActionsSection private toggle', () => {
  it('offers Lock note and toggles on click', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/a.md', { private: true }, 7)
  })

  it('offers Unlock note when the index reports the note private', async () => {
    getNote.mockResolvedValue(noteRow('daily/2026-06-10.md', true))
    noteSource = '---\nprivate: true\n---\n# A\n'
    const view = await renderSection('daily/2026-06-10.md')
    await expect.element(view.getByText('Unlock note')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('daily/2026-06-10.md', { private: false }, 7)
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    await expect.element(view.getByText('Unlock note')).toBeInTheDocument()
    noteSource = '---\nprivate: true\n---\n# A\n'
    await userEvent.click(view.getByRole('button', { name: /Unlock note/ }))
    await expect.element(view.getByText('Lock note', { exact: true })).toBeInTheDocument()
    expect(commitNoteFrontmatter).toHaveBeenCalledTimes(2)
  })

  it('shares an externally triggered privacy toggle with the button while saving', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    // The second copy is the other entry point: both read one note row cache.
    const view = await renderSection('notes/a.md', false, 2)
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledOnce())

    await userEvent.click(view.getByTestId('copy-1').getByRole('button', { name: /Lock note/ }))

    await expect.element(view.getByTestId('copy-0').getByText('Unlock note')).toBeInTheDocument()
    write.resolve()
    await write.promise
  })

  it('restores the private label when a write fails', async () => {
    commitNoteFrontmatter.mockRejectedValueOnce(new AppError('io', 'disk on fire'))
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Lock note/ }))
    await expect.element(view.getByText('Lock note', { exact: true })).toBeInTheDocument()
    expect(operations.findByLabel('Updating privacy')?.status).toBe('failed')
  })
})

describe('NoteActionsSection deep-link action', () => {
  it('does not offer Copy deep link in note actions', async () => {
    const view = await renderSection('notes/a.md')
    expect(view.getByRole('button', { name: /Copy deep link/ }).query()).toBeNull()
  })
})

describe('NoteActionsSection trash action', () => {
  it('does not offer trash unless the note sidebar opts in', async () => {
    const view = await renderSection('notes/a.md')
    expect(view.getByRole('button', { name: 'Trash note' }).query()).toBeNull()
  })

  it('trashes an ordinary note after confirmation', async () => {
    const view = await renderSection('notes/a.md', true)
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))
    const confirmButton = page.getByRole('dialog').getByRole('button', { name: 'Trash note' })
    await userEvent.click(confirmButton)
    await vi.waitFor(() => expect(trash).toHaveBeenCalledWith('notes/a.md'))
    expect(operations.findByLabel('Trashing note')).toBeDefined()
  })

  it('starts a reopened trash confirmation without the last failure', async () => {
    const view = await renderSection('notes/a.md', true)
    trash.mockRejectedValueOnce(new Error('Disk is full'))
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))
    await userEvent.click(page.getByRole('dialog').getByRole('button', { name: 'Trash note' }))
    await expect.element(page.getByRole('dialog').getByText('Disk is full')).toBeVisible()

    await userEvent.click(page.getByRole('dialog').getByRole('button', { name: 'Cancel' }))
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))

    await expect.element(page.getByRole('dialog')).toBeVisible()
    expect(page.getByText('Disk is full').query()).toBeNull()
  })

  it('does not offer trash for daily notes even if enabled', async () => {
    const view = await renderSection('daily/2026-06-10.md', true)
    expect(view.getByRole('button', { name: 'Trash note' }).query()).toBeNull()
  })
})
