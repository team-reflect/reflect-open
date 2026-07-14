import { describe, expect, it, vi } from 'vitest'
import type { NoteEditorHandle } from './note-editor'
import {
  registerNoteEditorHandle,
  requestNoteHeadingReveal,
  unregisterNoteEditorHandle,
} from './editor-handle-registry'

function editorHandle(revealHeading: (fragment: string) => boolean): NoteEditorHandle {
  return {
    getMarkdown: () => '',
    setMarkdown: vi.fn(),
    insertMarkdown: vi.fn(),
    focus: vi.fn(),
    revealHeading,
    setSelection: vi.fn(),
    getSelectedText: () => '',
    openSelectionMenu: vi.fn(),
    startPendingReplacement: () => false,
    appendPendingReplacementText: vi.fn(),
    acceptPendingReplacement: vi.fn(),
    discardPendingReplacement: vi.fn(),
  }
}

describe('heading reveal registry', () => {
  it('reveals immediately in an already-mounted note', () => {
    const revealHeading = vi.fn(() => true)
    const handle = editorHandle(revealHeading)
    registerNoteEditorHandle('Projects/Plan.md', handle)

    expect(requestNoteHeadingReveal('Projects/Plan.md', 'Roadmap')).toBe(true)
    expect(revealHeading).toHaveBeenCalledExactlyOnceWith('Roadmap')

    unregisterNoteEditorHandle('Projects/Plan.md', handle)
  })

  it('consumes a pending reveal when the navigated note mounts', () => {
    const revealHeading = vi.fn(() => true)
    const handle = editorHandle(revealHeading)

    expect(requestNoteHeadingReveal('People/Ada.md', 'Early life')).toBe(false)
    registerNoteEditorHandle('People/Ada.md', handle)

    expect(revealHeading).toHaveBeenCalledExactlyOnceWith('Early life')
    unregisterNoteEditorHandle('People/Ada.md', handle)
  })

  it('does not reveal a pending heading in the same path from another graph generation', () => {
    const staleRevealHeading = vi.fn(() => true)
    const currentRevealHeading = vi.fn(() => true)
    const staleHandle = editorHandle(staleRevealHeading)
    const currentHandle = editorHandle(currentRevealHeading)

    expect(requestNoteHeadingReveal('README.md', 'Install', 12)).toBe(false)
    registerNoteEditorHandle('README.md', staleHandle, 11)
    expect(staleRevealHeading).not.toHaveBeenCalled()

    registerNoteEditorHandle('README.md', currentHandle, 12)
    expect(currentRevealHeading).toHaveBeenCalledExactlyOnceWith('Install')

    unregisterNoteEditorHandle('README.md', currentHandle)
  })
})
