import { useEffect, type Ref } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorHandle } from '@meowdown/react'
import { NoteEditor, type NoteEditorHandle } from './note-editor'

const revealHeading = vi.hoisted(() => vi.fn(() => true))

interface PrerequisiteEditorHandle extends Partial<EditorHandle> {
  revealHeading(fragment: string): boolean
}

vi.mock('@meowdown/react', () => ({
  MeowdownEditor: ({ handleRef }: { handleRef?: Ref<Partial<EditorHandle>> }) => {
    useEffect(() => {
      const handle: PrerequisiteEditorHandle = { revealHeading }
      if (typeof handleRef === 'function') {
        handleRef(handle)
      } else if (handleRef !== null && handleRef !== undefined) {
        handleRef.current = handle
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
  it('forwards a decoded fragment to a Meowdown handle that supports the prerequisite API', () => {
    const handleRef = vi.fn<(handle: NoteEditorHandle | null) => void>()
    render(
      <NoteEditor
        initialContent="# Early life\n"
        handleRef={handleRef}
      />,
    )

    const editor = handleRef.mock.calls.at(-1)?.[0] ?? null
    expect(editor?.revealHeading('Early life')).toBe(true)
    expect(revealHeading).toHaveBeenCalledExactlyOnceWith('Early life')
  })
})
