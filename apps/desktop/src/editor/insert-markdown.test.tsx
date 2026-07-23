import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import '@/test-utils/locator'
import { NoteEditor, type NoteEditorHandle } from './note-editor'

const pmRoot = page.locate('.ProseMirror')

describe('NoteEditorHandle.insertMarkdown', () => {
  it('inserts the fragment into the document through the meowdown handle', async () => {
    let handle: NoteEditorHandle | null = null
    await render(
      <NoteEditor
        initialContent=""
        handleRef={(grabbed) => {
          handle = grabbed
        }}
      />,
    )
    await expect.element(pmRoot).toBeInTheDocument()

    handle!.insertMarkdown('# Journal\n\nMood:\n')
    await expect.element(page.getByText('Journal')).toBeInTheDocument()
    expect(handle!.getMarkdown()).toBe('# Journal\n\nMood:\n')
  })
})
