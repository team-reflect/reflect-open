import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { FocusedDailyProvider } from '@/providers/focused-daily-provider'
import {
  NoteFindProvider,
  useNoteFindActions,
} from '@/providers/note-find-provider'
import { RouterProvider, useRouter } from '@/routing/router'
import { NoteFindBar } from './note-find-bar'

const windowRole = vi.hoisted(() => ({ main: true }))

vi.mock('@/lib/windows/window-role', () => ({
  isMainWindow: () => windowRole.main,
}))

const NOTE_PATH = 'notes/find-me.md'

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
    beginFind: vi.fn(() => ({ active: 0, total: 0 })),
    updateFindQuery: vi.fn((query) =>
      query.length > 0 ? { active: 1, total: 3 } : { active: 0, total: 0 },
    ),
    findNext: vi.fn(() => ({ active: 2, total: 3 })),
    findPrevious: vi.fn(() => ({ active: 3, total: 3 })),
    clearFind: vi.fn(),
    subscribeFind: vi.fn(() => () => {}),
  }
}

function Harness(): ReactElement {
  const find = useNoteFindActions()
  const { navigate } = useRouter()
  return (
    <>
      <button type="button" onClick={() => find.openForPath(NOTE_PATH)}>
        Open find
      </button>
      <button type="button" onClick={find.next}>
        Continue find
      </button>
      <button type="button" onClick={() => navigate({ kind: 'allNotes', tag: null })}>
        Leave note
      </button>
      <NoteFindBar />
    </>
  )
}

function renderFindBar(): void {
  render(
    <RouterProvider initialRoute={{ kind: 'note', path: NOTE_PATH }}>
      <FocusedDailyProvider>
        <NoteFindProvider>
          <Harness />
        </NoteFindProvider>
      </FocusedDailyProvider>
    </RouterProvider>,
  )
}

function modKey(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  })
  window.dispatchEvent(event)
  return event
}

beforeEach(() => {
  windowRole.main = true
})

afterEach(() => {
  cleanup()
})

describe('NoteFindBar', () => {
  it('searches, reports match position, traverses, and restores editor focus on close', () => {
    const handle = editorHandle()
    registerNoteEditorHandle(NOTE_PATH, handle)
    renderFindBar()

    fireEvent.click(screen.getByRole('button', { name: 'Open find' }))
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Find in note' })
    expect(document.activeElement).toBe(input)
    expect(handle.beginFind).toHaveBeenCalledWith('')

    fireEvent.change(input, { target: { value: 'alpha' } })
    expect(handle.updateFindQuery).toHaveBeenLastCalledWith('alpha')
    expect(screen.getByRole('status').textContent).toContain('1 / 3')

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    expect(handle.findNext).not.toHaveBeenCalled()
    expect(screen.getByRole('search')).not.toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(handle.findNext).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('2 / 3')

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(handle.findPrevious).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('3 / 3')

    input.setSelectionRange(input.value.length, input.value.length)
    fireEvent.keyDown(input, { key: 'f', metaKey: true })
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    input.setSelectionRange(input.value.length, input.value.length)
    fireEvent.click(screen.getByRole('button', { name: 'Open find' }))
    expect(handle.beginFind).toHaveBeenCalledTimes(1)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('search')).toBeNull()
    expect(handle.clearFind).toHaveBeenCalledTimes(1)
    expect(handle.focus).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Continue find' }))
    expect(handle.beginFind).toHaveBeenLastCalledWith('alpha', {
      direction: 'next',
      resume: true,
    })
    expect(screen.getByRole('search')).not.toBeNull()

    unregisterNoteEditorHandle(NOTE_PATH, handle)
  })

  it('closes and clears highlights without stealing focus when navigation leaves the note', () => {
    const handle = editorHandle()
    registerNoteEditorHandle(NOTE_PATH, handle)
    renderFindBar()

    fireEvent.click(screen.getByRole('button', { name: 'Open find' }))
    fireEvent.click(screen.getByRole('button', { name: 'Leave note' }))

    expect(screen.queryByRole('search')).toBeNull()
    expect(handle.clearFind).toHaveBeenCalledTimes(1)
    expect(handle.focus).not.toHaveBeenCalled()

    unregisterNoteEditorHandle(NOTE_PATH, handle)
  })

  it('closes on Escape without stealing focus from another control', () => {
    const handle = editorHandle()
    registerNoteEditorHandle(NOTE_PATH, handle)
    renderFindBar()

    fireEvent.click(screen.getByRole('button', { name: 'Open find' }))
    const outside = screen.getByRole('button', { name: 'Leave note' })
    outside.focus()
    fireEvent.keyDown(outside, { key: 'Escape' })

    expect(screen.queryByRole('search')).toBeNull()
    expect(handle.clearFind).toHaveBeenCalledTimes(1)
    expect(handle.focus).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(outside)

    unregisterNoteEditorHandle(NOTE_PATH, handle)
  })

  it('restores editor focus when Escape is pressed from a Find control', () => {
    const handle = editorHandle()
    registerNoteEditorHandle(NOTE_PATH, handle)
    renderFindBar()

    fireEvent.click(screen.getByRole('button', { name: 'Open find' }))
    const closeButton = screen.getByRole('button', { name: 'Close find' })
    closeButton.focus()
    fireEvent.keyDown(closeButton, { key: 'Escape' })

    expect(screen.queryByRole('search')).toBeNull()
    expect(handle.clearFind).toHaveBeenCalledTimes(1)
    expect(handle.focus).toHaveBeenCalledTimes(1)

    unregisterNoteEditorHandle(NOTE_PATH, handle)
  })

  it('opens while a note loads and retains navigation until its editor mounts', () => {
    const handle = editorHandle()
    renderFindBar()

    fireEvent.click(screen.getByRole('button', { name: 'Open find' }))
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Find in note' })
    fireEvent.change(input, { target: { value: 'alpha' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(handle.beginFind).not.toHaveBeenCalled()

    act(() => registerNoteEditorHandle(NOTE_PATH, handle))

    expect(screen.getByRole('search')).not.toBeNull()
    expect(handle.beginFind).toHaveBeenCalledWith('alpha', { direction: 'previous' })

    unregisterNoteEditorHandle(NOTE_PATH, handle)
  })

  it('resets pending navigation when the query changes before the editor mounts', () => {
    const handle = editorHandle()
    renderFindBar()

    fireEvent.click(screen.getByRole('button', { name: 'Open find' }))
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Find in note' })
    fireEvent.change(input, { target: { value: 'alpha' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.change(input, { target: { value: 'alphabet' } })

    act(() => registerNoteEditorHandle(NOTE_PATH, handle))

    expect(handle.beginFind).toHaveBeenCalledWith('alphabet', { direction: 'next' })

    unregisterNoteEditorHandle(NOTE_PATH, handle)
  })

  it('closes without stealing focus when virtualization unmounts its editor', () => {
    const handle = editorHandle()
    registerNoteEditorHandle(NOTE_PATH, handle)
    renderFindBar()

    fireEvent.click(screen.getByRole('button', { name: 'Open find' }))
    expect(screen.getByRole('search')).not.toBeNull()

    act(() => unregisterNoteEditorHandle(NOTE_PATH, handle))

    expect(screen.queryByRole('search')).toBeNull()
    expect(handle.clearFind).toHaveBeenCalledTimes(1)
    expect(handle.focus).not.toHaveBeenCalled()
  })

  it('handles Find shortcuts inside secondary note windows', () => {
    windowRole.main = false
    const handle = editorHandle()
    registerNoteEditorHandle(NOTE_PATH, handle)
    renderFindBar()

    let event: KeyboardEvent
    act(() => {
      event = modKey('f')
    })
    expect(event!).toBeDefined()
    expect(event!.defaultPrevented).toBe(true)
    expect(handle.beginFind).toHaveBeenCalledWith('')
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Find in note' }),
    )

    act(() => {
      modKey('g')
      modKey('g', { shiftKey: true })
    })
    expect(handle.findNext).toHaveBeenCalledTimes(1)
    expect(handle.findPrevious).toHaveBeenCalledTimes(1)

    unregisterNoteEditorHandle(NOTE_PATH, handle)
  })
})
