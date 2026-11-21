import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { setBottomScrollInset } from './bottom-scroll-inset.ts'
import { useFormattingToolbar, type FormattingToolbar } from './formatting-toolbar-store.ts'
import { NoteEditor, type NoteEditorHandle } from './note-editor.tsx'

const pmRoot = page.locate('.ProseMirror')
const toolbarState = page.getByTestId('toolbar-state')

const captured: { toolbar: FormattingToolbar | null } = { toolbar: null }

function ToolbarProbe() {
  const toolbar = useFormattingToolbar()
  useEffect(() => {
    captured.toolbar = toolbar
  })
  return <span data-testid="toolbar-state">{toolbar === null ? 'no-toolbar' : 'has-toolbar'}</span>
}

interface Setup {
  handle: NoteEditorHandle
  rerender: (nextEditor: boolean) => Promise<void>
}

async function setupEditor(
  initialContent: string,
  touchEditor = true,
  saveFile?: (file: File) => Promise<string | null>,
): Promise<Setup> {
  const grabbed: { current: NoteEditorHandle | null } = { current: null }
  const editor = (
    <NoteEditor
      initialContent={initialContent}
      onWikilinkSearch={() => []}
      saveFile={saveFile}
      handleRef={(handle) => {
        grabbed.current = handle
      }}
    />
  )
  const screen = await renderInApp(
    <>
      {editor}
      <ToolbarProbe />
    </>,
    { platform: { surface: { touchEditor } } },
  )
  await expect.element(pmRoot).toBeInTheDocument()
  return {
    handle: grabbed.current!,
    rerender: async (nextEditor: boolean) => {
      await screen.rerender(
        <>
          {nextEditor ? editor : null}
          <ToolbarProbe />
        </>,
      )
    },
  }
}

afterEach(() => {
  captured.toolbar = null
  setBottomScrollInset(0)
})

describe('FormattingToolbarBridge', () => {
  it('publishes commands and capabilities when the editor gains focus', async () => {
    await setupEditor('- alpha\n- beta')
    await expect.element(toolbarState).toMatchTextContent('no-toolbar')

    await pmRoot.getByText('beta').click()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')
    expect(captured.toolbar?.capabilities).toEqual({
      canIndent: true,
      canDedent: true,
      canMoveUp: true,
      canMoveDown: false,
      canAttachFiles: false,
    })
  })

  it('does nothing off the touch surface', async () => {
    await setupEditor('alpha', false)
    await pmRoot.getByText('alpha').click()
    await expect.element(pmRoot).toHaveFocus()
    await expect.element(toolbarState).toMatchTextContent('no-toolbar')
  })

  it('publishes when the editor is focused programmatically (autoFocus arrivals)', async () => {
    const { handle } = await setupEditor('alpha')
    handle.focus()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')
  })

  it('recomputes capabilities as the caret moves, and clears on blur', async () => {
    await setupEditor('plain\n\n- alpha\n- beta')

    await pmRoot.getByText('plain').click()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')
    await vi.waitFor(() => {
      expect(captured.toolbar?.capabilities.canIndent).toBe(false)
    })

    await pmRoot.getByText('beta').click()
    await vi.waitFor(() => {
      expect(captured.toolbar?.capabilities.canIndent).toBe(true)
    })

    captured.toolbar?.commands.dismissKeyboard()
    await expect.element(toolbarState).toMatchTextContent('no-toolbar')
  })

  it('turns the focused paragraph into a checkable bullet through the toolbar commands', async () => {
    const { handle } = await setupEditor('alpha')

    await pmRoot.getByText('alpha').click()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')

    captured.toolbar?.commands.cycleBulletOrderedList()
    await vi.waitFor(() => {
      expect(handle.getMarkdown()).toBe('- alpha\n')
    })

    captured.toolbar?.commands.cycleCheckableList()
    await vi.waitFor(() => {
      expect(handle.getMarkdown()).toBe('- [ ] alpha\n')
    })
  })

  it('restructures a list with indent, dedent, and move commands', async () => {
    const { handle } = await setupEditor('- alpha\n- beta')

    await pmRoot.getByText('beta').click()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')

    captured.toolbar?.commands.indent()
    await vi.waitFor(() => {
      expect(handle.getMarkdown()).toBe('- alpha\n  - beta\n')
    })

    captured.toolbar?.commands.dedent()
    await vi.waitFor(() => {
      expect(handle.getMarkdown()).toBe('- alpha\n- beta\n')
    })

    captured.toolbar?.commands.moveUp()
    await vi.waitFor(() => {
      expect(handle.getMarkdown()).toBe('- beta\n- alpha\n')
    })
  })

  it("opens the wiki-link menu through the editor's insertTrigger command", async () => {
    const { handle } = await setupEditor('alpha')

    await pmRoot.getByText('alpha').click()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')
    handle.setSelection('end')

    captured.toolbar?.commands.insertTrigger('[[')
    await expect.element(page.getByTestId('wikilink-menu')).toBeInTheDocument()
  })

  it('persists attached files and inserts their markdown', async () => {
    const saveFile = vi.fn((file: File) => Promise.resolve(`assets/${file.name}`))
    const { handle } = await setupEditor('alpha', true, saveFile)

    await pmRoot.getByText('alpha').click()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')
    expect(captured.toolbar?.capabilities.canAttachFiles).toBe(true)
    handle.setSelection('end')

    await captured.toolbar?.commands.attachFiles([
      new File(['png'], 'photo.png', { type: 'image/png' }),
      new File(['txt'], 'notes.txt', { type: 'text/plain' }),
    ])

    expect(saveFile).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => {
      // An image becomes an embed and any other file a link, exactly as a
      // paste of the same files would.
      expect(handle.getMarkdown()).toContain('![](assets/photo.png)')
      expect(handle.getMarkdown()).toContain('[notes.txt](assets/notes.txt)')
    })
  })

  it('inserts nothing when the save declines the file', async () => {
    const saveFile = vi.fn(() => Promise.resolve(null))
    const { handle } = await setupEditor('alpha', true, saveFile)

    await pmRoot.getByText('alpha').click()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')

    await captured.toolbar?.commands.attachFiles([
      new File(['png'], 'photo.png', { type: 'image/png' }),
    ])

    expect(saveFile).toHaveBeenCalledOnce()
    expect(handle.getMarkdown()).toBe('alpha\n')
  })

  it('clears its published toolbar on unmount', async () => {
    const setup = await setupEditor('alpha')

    await pmRoot.getByText('alpha').click()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')

    await setup.rerender(false)
    await expect.element(toolbarState).toMatchTextContent('no-toolbar')
  })

  it('reveals the caret above the bottom scroll inset', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
    await renderInApp(
      <div data-testid="scroller" style={{ height: 300, overflowY: 'auto' }}>
        <NoteEditor initialContent={lines.join('\n\n')} onWikilinkSearch={() => []} />
        <ToolbarProbe />
      </div>,
      { platform: { surface: { touchEditor: true } } },
    )
    const scroller = page.getByTestId('scroller').element()
    const bottom = scroller.getBoundingClientRect().bottom
    const target = [...pmRoot.element().querySelectorAll('p')].find((paragraph) => {
      const rect = paragraph.getBoundingClientRect()
      return rect.top > bottom - 120 && rect.bottom < bottom
    })
    if (target === undefined) {
      throw new Error('no paragraph near the bottom of the scroller')
    }
    await page.elementLocator(target).click()
    await expect.element(toolbarState).toMatchTextContent('has-toolbar')

    captured.toolbar?.commands.scrollCaretIntoView()
    expect(scroller.scrollTop).toBe(0)

    setBottomScrollInset(200)
    captured.toolbar?.commands.scrollCaretIntoView()
    await vi.waitFor(() => {
      expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(bottom - 200)
    })
  })
})
