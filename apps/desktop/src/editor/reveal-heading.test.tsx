import { createRef, useEffect, type Ref } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorHandle } from '@meowdown/react'
import { NoteEditor, type NoteEditorHandle } from './note-editor'

/**
 * `NoteEditorHandle.revealHeading` delegates to meowdown's first-class
 * handle method; this only guards the pass-through.
 */

const revealHeading = vi.hoisted(() => vi.fn(() => true))

vi.mock('@meowdown/react', () => ({
  MeowdownEditor: ({ handleRef }: { handleRef?: Ref<Partial<EditorHandle>> }) => {
    useEffect(() => {
      if (typeof handleRef === 'function') {
        handleRef({ revealHeading })
      } else if (handleRef !== null && handleRef !== undefined) {
        handleRef.current = { revealHeading }
      }
    })
    return <div />
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NoteEditorHandle.revealHeading', () => {
  it('delegates to the meowdown handle and returns its result', () => {
    const ref = createRef<NoteEditorHandle>()
    render(<NoteEditor handleRef={ref} initialContent="# A" />)
    expect(ref.current?.revealHeading('A')).toBe(true)
    expect(revealHeading).toHaveBeenCalledWith('A')
  })
})
