import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { NoteEditor, type NoteEditorHandle } from './note-editor.tsx'

const pmRoot = page.locate('.ProseMirror')

describe('NoteEditorHandle.insertMarkdown', () => {
  it('inserts the fragment into the document through the meowdown handle', async () => {
    let handle: NoteEditorHandle | null = null
    await renderInApp(
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
