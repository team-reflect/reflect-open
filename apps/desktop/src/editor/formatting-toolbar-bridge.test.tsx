import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { setPlatformSurface } from '@/lib/platform-surface'
import '@/test-utils/locator'
import { useFormattingToolbar, type FormattingToolbar } from './formatting-toolbar-store'
import { NoteEditor, type NoteEditorHandle } from './note-editor'

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

async function setupEditor(initialContent: string, touchEditor = true): Promise<Setup> {
  setPlatformSurface({ touchEditor })
  const grabbed: { current: NoteEditorHandle | null } = { current: null }
  const editor = (
    <NoteEditor
      initialContent={initialContent}
      onWikilinkSearch={async () => []}
      handleRef={(handle) => {
        grabbed.current = handle
      }}
    />
  )
  const screen = await render(
    <>
      {editor}
      <ToolbarProbe />
    </>,
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
  setPlatformSurface({ touchEditor: false })
  captured.toolbar = null
})

describe('FormattingToolbarBridge', () => {
  it('publishes commands and capabilities when the editor gains focus', async () => {
    await setupEditor('- alpha\n- beta')
    await expect.element(toolbarState).toHaveTextContent('no-toolbar')

    await pmRoot.getByText('beta').click()
    await expect.element(toolbarState).toHaveTextContent('has-toolbar')
    expect(captured.toolbar?.capabilities).toEqual({
      canIndent: true,
      canDedent: true,
      canMoveUp: true,
      canMoveDown: false,
    })
  })

  it('does nothing off the touch surface', async () => {
    await setupEditor('alpha', false)
    await pmRoot.getByText('alpha').click()
    await expect.element(pmRoot).toHaveFocus()
    await expect.element(toolbarState).toHaveTextContent('no-toolbar')
  })

  it('publishes when the editor is focused programmatically (autoFocus arrivals)', async () => {
    const { handle } = await setupEditor('alpha')
    handle.focus()
    await expect.element(toolbarState).toHaveTextContent('has-toolbar')
  })

  it('recomputes capabilities as the caret moves, and clears on blur', async () => {
    await setupEditor('plain\n\n- alpha\n- beta')

    await pmRoot.getByText('plain').click()
    await expect.element(toolbarState).toHaveTextContent('has-toolbar')
    await vi.waitFor(() => {
      expect(captured.toolbar?.capabilities.canIndent).toBe(false)
    })

    await pmRoot.getByText('beta').click()
    await vi.waitFor(() => {
      expect(captured.toolbar?.capabilities.canIndent).toBe(true)
    })

    captured.toolbar?.commands.dismissKeyboard()
    await expect.element(toolbarState).toHaveTextContent('no-toolbar')
  })

  it('turns the focused paragraph into a checkable bullet through the toolbar commands', async () => {
    const { handle } = await setupEditor('alpha')

    await pmRoot.getByText('alpha').click()
    await expect.element(toolbarState).toHaveTextContent('has-toolbar')

    captured.toolbar?.commands.toggleBulletList()
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
    await expect.element(toolbarState).toHaveTextContent('has-toolbar')

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
    await expect.element(toolbarState).toHaveTextContent('has-toolbar')
    handle.setSelection('end')

    captured.toolbar?.commands.insertTrigger('[[')
    await expect.element(page.getByTestId('wikilink-menu')).toBeInTheDocument()
  })

  it('clears its published toolbar on unmount', async () => {
    const setup = await setupEditor('alpha')

    await pmRoot.getByText('alpha').click()
    await expect.element(toolbarState).toHaveTextContent('has-toolbar')

    await setup.rerender(false)
    await expect.element(toolbarState).toHaveTextContent('no-toolbar')
  })
})
