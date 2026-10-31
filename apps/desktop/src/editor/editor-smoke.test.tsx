import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

const pmRoot = page.locate('.ProseMirror')

describe('NoteEditor smoke', () => {
  it('mounts the real editor and serializes typed text', async () => {
    const handleRef = createRef<NoteEditorHandle>()
    const onChange = vi.fn()
    await renderInApp(
      <NoteEditor initialContent="Hello" onChange={onChange} handleRef={handleRef} />,
    )
    await expect.element(page.getByText('Hello')).toBeInTheDocument()
    await expect.element(pmRoot).toBeInTheDocument()

    await pmRoot.click()
    await userEvent.keyboard('{End} world')
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalled()
    })
    expect(handleRef.current?.getMarkdown()).toBe('Hello world\n')
  })
})
