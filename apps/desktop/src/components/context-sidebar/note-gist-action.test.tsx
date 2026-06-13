import { cleanup, render, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteRow } from '@reflect/core'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NoteGistAction } from './note-gist-action'

const useGithubConnected = vi.hoisted(() => vi.fn(() => true))
const useNoteRow = vi.hoisted(() => vi.fn<(path: string) => NoteRow | null>(() => null))
const runGistPublish = vi.hoisted(() =>
  vi.fn(async (): Promise<string | null> => 'https://gist.github.com/alex/g1'),
)

vi.mock('@/hooks/use-github-connected', () => ({ useGithubConnected }))
vi.mock('@/hooks/use-note-row', () => ({ useNoteRow }))
vi.mock('@/lib/note-gist', () => ({ runGistPublish }))
vi.mock('@/providers/graph-provider', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', cloudSync: false, generation: 7 } }),
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
  useGithubConnected.mockReset().mockReturnValue(true)
  useNoteRow.mockReset().mockReturnValue(null)
  runGistPublish.mockReset().mockResolvedValue('https://gist.github.com/alex/g1')
})

afterEach(() => {
  cleanup()
})

describe('NoteGistAction', () => {
  it('renders nothing without a GitHub connection', () => {
    useGithubConnected.mockReturnValue(false)
    const view = renderAction()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('renders nothing for a private note', () => {
    useNoteRow.mockReturnValue(noteRow({ isPrivate: true }))
    const view = renderAction()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('offers Publish to gist for an unpublished note (even before its row exists)', () => {
    const view = renderAction()
    expect(view.getByRole('button', { name: /Publish to gist/ })).toBeTruthy()
  })

  it('offers Republish gist once the note carries a gist', () => {
    useNoteRow.mockReturnValue(noteRow({ gistUrl: 'https://gist.github.com/alex/g1' }))
    const view = renderAction()
    expect(view.getByRole('button', { name: /Republish gist/ })).toBeTruthy()
  })

  it('publishes on click and flips to Republish before the index catches up', async () => {
    const view = renderAction()
    await userEvent.click(view.getByRole('button', { name: /Publish to gist/ }))

    expect(runGistPublish).toHaveBeenCalledWith('notes/a.md', 7)
    await waitFor(() => {
      expect(view.getByRole('button', { name: /Republish gist/ })).toBeTruthy()
    })
  })

  it('stays on Publish when the publish failed (already surfaced elsewhere)', async () => {
    runGistPublish.mockResolvedValue(null)
    const view = renderAction()
    await userEvent.click(view.getByRole('button', { name: /Publish to gist/ }))

    await waitFor(() => {
      expect(view.getByRole('button', { name: /Publish to gist/ })).toBeTruthy()
    })
  })

  it('keeps nudging after a same-url republish — the bridge retires on url match alone', async () => {
    // A published, edited note: the row already carries the url the republish
    // will return. Were the bridge to also wait for `gistStale` to clear, a
    // body that keeps changing would hold it forever and mute the nudge.
    const url = 'https://gist.github.com/alex/g1'
    runGistPublish.mockResolvedValue(url)
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url, gistStale: true }))

    const view = renderAction()
    const accentIcon = () => view.getByRole('button').querySelector('.text-accent')
    expect(accentIcon()).toBeTruthy()

    await userEvent.click(view.getByRole('button', { name: /Republish gist/ }))
    await waitFor(() => {
      // Index still says stale (the watcher hasn't re-indexed yet) — the
      // retired bridge must not mask it.
      expect(accentIcon()).toBeTruthy()
    })

    // The watcher catches up: staleness clears, and so does the nudge.
    useNoteRow.mockReturnValue(noteRow({ gistUrl: url, gistStale: false }))
    view.rerender(
      <TooltipProvider>
        <NoteGistAction path="notes/a.md" />
      </TooltipProvider>,
    )
    expect(accentIcon()).toBeNull()
  })
})
