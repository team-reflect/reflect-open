import { useEffect, type ReactElement } from 'react'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { FocusedDailyProvider } from '@/providers/focused-daily-provider'
import {
  NoteFindProvider,
  useNoteFindActions,
  useNoteSearchQuery,
  useNoteSearchReport,
} from '@/providers/note-find-provider'
import { RouterProvider } from '@/routing/router'
import { NoteFindBar } from './note-find-bar'

vi.mock('@/lib/windows/window-role', () => ({ isMainWindow: () => true }))

const NOTE_PATH = 'notes/find-me.md'

const findBar = page.getByRole('search', { name: 'Find in note' })
const queryInput = page.getByRole('textbox', { name: 'Find in note' })
const matchCount = page.getByRole('status')

function editorHandle(): NoteEditorHandle {
  return {
    getMarkdown: () => '',
    setMarkdown: vi.fn(),
    insertMarkdown: vi.fn(),
    focus: vi.fn(),
    setSelection: vi.fn(),
    getSelectedText: () => '',
    openSelectionMenu: vi.fn(),
    startPendingReplacement: () => false,
    appendPendingReplacementText: vi.fn(),
    acceptPendingReplacement: vi.fn(),
    discardPendingReplacement: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
  }
}

/**
 * Stands in for the note pane: it reports a match count for whatever query the
 * session pushes at it, the way a mounted editor would.
 */
function Harness(): ReactElement {
  const find = useNoteFindActions()
  const query = useNoteSearchQuery(NOTE_PATH)
  const report = useNoteSearchReport()

  useEffect(() => {
    report(NOTE_PATH, query.length > 0 ? { total: 3, active: 1 } : { total: 0, active: 0 })
  }, [query, report])

  return (
    <>
      <button type="button" onClick={() => find.openForPath(NOTE_PATH)}>
        Open find
      </button>
      <button type="button" onClick={find.next}>
        Continue find
      </button>
      <button type="button">Elsewhere</button>
      <NoteFindBar />
    </>
  )
}

function renderFindBar() {
  return render(
    <RouterProvider initialRoute={{ kind: 'note', path: NOTE_PATH }}>
      <FocusedDailyProvider>
        <NoteFindProvider>
          <Harness />
        </NoteFindProvider>
      </FocusedDailyProvider>
    </RouterProvider>,
  )
}

let registered: NoteEditorHandle | null = null

function registerHandle(): NoteEditorHandle {
  const handle = editorHandle()
  registerNoteEditorHandle(NOTE_PATH, handle)
  registered = handle
  return handle
}

afterEach(() => {
  if (registered !== null) {
    unregisterNoteEditorHandle(NOTE_PATH, registered)
    registered = null
  }
})

describe('NoteFindBar', () => {
  it('searches the note, reports the match position, and traverses matches', async () => {
    const handle = registerHandle()
    await renderFindBar()

    await page.getByRole('button', { name: 'Open find' }).click()
    await expect.element(queryInput).toHaveFocus()

    await userEvent.fill(queryInput, 'alpha')
    await expect.element(matchCount).toHaveTextContent('1 / 3')

    await page.getByRole('button', { name: 'Next match' }).click()
    expect(handle.findNext).toHaveBeenCalledTimes(1)

    await page.getByRole('button', { name: 'Previous match' }).click()
    expect(handle.findPrevious).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape from the bar and hands focus back to the editor', async () => {
    const handle = registerHandle()
    await renderFindBar()

    await page.getByRole('button', { name: 'Open find' }).click()
    await expect.element(queryInput).toHaveFocus()

    await userEvent.keyboard('{Escape}')

    await expect.element(findBar).not.toBeInTheDocument()
    expect(handle.focus).toHaveBeenCalledTimes(1)
  })

  it('closes without stealing focus when Escape comes from another control', async () => {
    const handle = registerHandle()
    await renderFindBar()

    await page.getByRole('button', { name: 'Open find' }).click()
    await expect.element(queryInput).toHaveFocus()

    // WebKit follows the macOS convention of not focusing a button on click, so
    // move focus explicitly to model the user having gone somewhere else.
    const outside = page.getByRole('button', { name: 'Elsewhere' })
    outside.element().focus()
    await expect.element(outside).toHaveFocus()

    await userEvent.keyboard('{Escape}')

    await expect.element(findBar).not.toBeInTheDocument()
    expect(handle.focus).not.toHaveBeenCalled()
    await expect.element(outside).toHaveFocus()
  })

  it('reopens with the previous query and resumes navigation after closing', async () => {
    const handle = registerHandle()
    await renderFindBar()

    await page.getByRole('button', { name: 'Open find' }).click()
    await userEvent.fill(queryInput, 'alpha')
    await userEvent.keyboard('{Escape}')
    await expect.element(findBar).not.toBeInTheDocument()

    await page.getByRole('button', { name: 'Continue find' }).click()

    await expect.element(findBar).toBeInTheDocument()
    await expect.element(queryInput).toHaveValue('alpha')
    expect(handle.findNext).toHaveBeenCalledTimes(1)
  })
})
