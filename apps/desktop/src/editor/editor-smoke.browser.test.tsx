import { createRef } from 'react'
import { setBridge, type IpcBridge } from '@reflect/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { NoteEditor, type NoteEditorHandle } from '@/editor/note-editor'
import '@/test-utils/locator'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const pmRoot = page.locate('.ProseMirror')

afterEach(() => {
  setBridge(null)
})

describe('browser mode smoke', () => {
  it('mounts the real editor and serializes typed text', async () => {
    const bridge: IpcBridge = {
      invoke: async () => null,
      listen: async () => () => {},
    }
    setBridge(bridge)

    const handleRef = createRef<NoteEditorHandle>()
    const onChange = vi.fn()
    await render(<NoteEditor initialContent="Hello" onChange={onChange} handleRef={handleRef} />)
    await expect.element(page.getByText('Hello')).toBeInTheDocument()
    await expect.element(pmRoot).toBeInTheDocument()

    await pmRoot.click()
    await userEvent.keyboard('{End} world')
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalled()
    })
    expect(handleRef.current?.getMarkdown()).toBe('Hello world\n')
  })

  it('applies module mocks in browser mode', () => {
    expect(vi.isMockFunction(openUrl)).toBe(true)
  })
})
