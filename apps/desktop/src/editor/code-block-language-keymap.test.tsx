import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '@/test-utils/locator.ts'
import { MOD_KEY } from '@/test-utils/mod-key.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { NoteEditor, type NoteEditorHandle } from './note-editor.tsx'

const MARKDOWN = '```ts\nconst answer = 42\n```\n\nAfter the code\n'
const PRESS_MOD_P = MOD_KEY.metaKey ? '{Meta>}p{/Meta}' : '{Control>}p{/Control}'

/** The language and body of the first fenced code block in `markdown`. */
function fence(markdown: string): { language: string; code: string } | undefined {
  const match = /```(\w*)\n([\s\S]*?)```/.exec(markdown)
  return match ? { language: match[1] ?? '', code: match[2] ?? '' } : undefined
}

const pmRoot = page.locate('.ProseMirror')
const codeBlock = page.locate('.ProseMirror pre')
const search = page.getByPlaceholder('Search or type a language')

async function renderEditor(): Promise<NoteEditorHandle> {
  const handleRef = createRef<NoteEditorHandle>()
  await renderInApp(<NoteEditor initialContent={MARKDOWN} handleRef={handleRef} />)
  await expect.element(codeBlock).toBeInTheDocument()
  if (!handleRef.current) throw new Error('NoteEditor did not expose its handle')
  return handleRef.current
}

describe('CodeBlockLanguageKeymap', () => {
  it('opens the language picker from inside a code block and returns to the code', async () => {
    const handle = await renderEditor()
    await codeBlock.click()

    await userEvent.keyboard(PRESS_MOD_P)
    await expect.element(search).toHaveFocus()

    await userEvent.keyboard('pyth{ArrowDown}{Enter}')
    await vi.waitFor(() => {
      expect(fence(handle.getMarkdown())?.language).toBe('python')
    })
    await expect.element(pmRoot).toHaveFocus()

    await userEvent.keyboard('X')
    await vi.waitFor(() => {
      expect(fence(handle.getMarkdown())?.code).toContain('X')
    })
  })

  it('puts the caret back in the code when the picker is dismissed', async () => {
    const handle = await renderEditor()
    await codeBlock.click()

    await userEvent.keyboard(PRESS_MOD_P)
    await expect.element(search).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(pmRoot).toHaveFocus()

    await userEvent.keyboard('X')
    await vi.waitFor(() => {
      const block = fence(handle.getMarkdown())
      expect(block?.language).toBe('ts')
      expect(block?.code).toContain('X')
    })
  })

  it('leaves the key alone outside a code block', async () => {
    await renderEditor()
    await page.getByText('After the code').click()

    await userEvent.keyboard(PRESS_MOD_P)
    await expect.element(search).not.toBeInTheDocument()
    await expect.element(pmRoot).toHaveFocus()
  })
})
