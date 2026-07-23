import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteRow } from '@reflect/core'
import { resetNoteRowOverlays, setNoteRowOverlay } from '@/hooks/note-row-overlay'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NoteGistAction } from './note-gist-action'

const useGithubConnected = vi.hoisted(() => vi.fn(() => true))
const useNoteRow = vi.hoisted(() => vi.fn<(path: string) => NoteRow | null>(() => null))
const runGistPublish = vi.hoisted(() =>
  vi.fn<(path: string, generation: number) => Promise<string | null>>(
    async () => 'https://gist.github.com/alex/g1',
  ),
)
const runGistUnpublish = vi.hoisted(() => vi.fn<(path: string, generation: number) => Promise<boolean>>(async () => true))

vi.mock('@/hooks/use-github-connected', () => ({ useGithubConnected }))
vi.mock('@/hooks/use-note-row', () => ({ useNoteRow }))
vi.mock('@/lib/note-gist', () => ({ runGistPublish, runGistUnpublish }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'notes/a.md',
    title: 'A',
    dailyDate: null,
    isPrivate: false,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

function renderAction() {
  return render(
    <TooltipProvider>
      <NoteGistAction path="notes/a.md" />
    </TooltipProvider>,
  )
}

beforeEach(() => {
  resetNoteRowOverlays()
  useGithubConnected.mockReset().mockReturnValue(true)
  useNoteRow.mockReset().mockReturnValue(null)
  runGistPublish.mockReset().mockResolvedValue('https://gist.github.com/alex/g1')
  runGistUnpublish.mockReset().mockResolvedValue(true)
})

describe('NoteGistAction', () => {
  it('renders nothing without a GitHub connection', async () => {
    useGithubConnected.mockReturnValue(false)
    const view = await renderAction()
    expect(view.getByRole('button').query()).toBeNull()
  })

  it('renders nothing for a private note', async () => {
    useNoteRow.mockReturnValue(noteRow({ isPrivate: true }))
    const view = await renderAction()
    expect(view.getByRole('button').query()).toBeNull()
  })

  it('offers Share with private link for an unpublished note (even before its row exists)', async () => {
    const view = await renderAction()
    await expect
      .element(view.getByRole('button', { name: /Share with private link/ }))
      .toBeInTheDocument()
  })

  it('offers Unpublish link once the note carries a gist', async () => {
    useNoteRow.mockReturnValue(noteRow({ gistUrl: 'https://gist.github.com/alex/g1' }))
    const view = await renderAction()
    await expect.element(view.getByRole('button', { name: /Unpublish link/ })).toBeInTheDocument()
  })

  it('publishes the open note on click', async () => {
    const view = await renderAction()
    await userEvent.click(view.getByRole('button', { name: /Share with private link/ }))
    expect(runGistPublish).toHaveBeenCalledWith('notes/a.md', 7)
  })

  it('unpublishes the open note on click once it carries a gist', async () => {
    useNoteRow.mockReturnValue(noteRow({ gistUrl: 'https://gist.github.com/alex/g1' }))
    const view = await renderAction()
    await userEvent.click(view.getByRole('button', { name: /Unpublish link/ }))
    expect(runGistUnpublish).toHaveBeenCalledWith('notes/a.md', 7)
  })

  it('reflects an optimistic publish as Republish before the index catches up', async () => {
    // The overlay is what `runGistPublish` writes on success (its contract is
    // covered in note-gist.test.ts); given one, the label flips without waiting
    // on the index.
    setNoteRowOverlay('notes/a.md', 7, { gistUrl: 'https://gist.github.com/alex/g1' })
    const view = await renderAction()
    await expect.element(view.getByRole('button', { name: /Unpublish link/ })).toBeInTheDocument()
  })

  it('stays on Publish when the publish failed (already surfaced elsewhere)', async () => {
    runGistPublish.mockResolvedValue(null)
    const view = await renderAction()
    await userEvent.click(view.getByRole('button', { name: /Share with private link/ }))

    await expect
      .element(view.getByRole('button', { name: /Share with private link/ }))
      .toBeInTheDocument()
  })

})
