import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge, PASTE_AND_MATCH_STYLE_EVENT } from '@reflect/core'
import { PasteAndMatchStyleBridge } from './paste-and-match-style-bridge'

/** The stub ProseKit editor `useEditor` hands the bridge (see the mock below). */
const editorStub = vi.hoisted(() => ({
  mounted: true,
  focused: true,
  view: { pasteText: vi.fn() },
}))

vi.mock('@meowdown/react', () => ({
  useEditor: () => editorStub,
}))

/** Handlers the fake bridge captured, keyed by event name. */
let listeners: Map<string, (payload: unknown) => void>

beforeEach(() => {
  listeners = new Map()
  editorStub.mounted = true
  editorStub.focused = true
  editorStub.view.pasteText.mockClear()
  setBridge({
    invoke: async () => null,
    listen: async (event, handler) => {
      listeners.set(event, handler)
      return () => {
        listeners.delete(event)
      }
    },
  })
})

afterEach(() => {
  cleanup()
  setBridge(null)
})

async function emitPasteAndMatchStyle(payload: unknown): Promise<void> {
  await waitFor(() => {
    expect(listeners.has(PASTE_AND_MATCH_STYLE_EVENT)).toBe(true)
  })
  listeners.get(PASTE_AND_MATCH_STYLE_EVENT)?.(payload)
}

describe('PasteAndMatchStyleBridge', () => {
  it('pastes the shell-forwarded text into the focused editor as plain text', async () => {
    render(<PasteAndMatchStyleBridge />)

    await emitPasteAndMatchStyle('plain **text**')

    expect(editorStub.view.pasteText).toHaveBeenCalledExactlyOnceWith('plain **text**')
  })

  it('ignores the event while this editor is not focused', async () => {
    editorStub.focused = false
    render(<PasteAndMatchStyleBridge />)

    await emitPasteAndMatchStyle('plain text')

    expect(editorStub.view.pasteText).not.toHaveBeenCalled()
  })

  it('ignores a malformed payload', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<PasteAndMatchStyleBridge />)

    await emitPasteAndMatchStyle({ nested: 'object' })

    expect(editorStub.view.pasteText).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('unsubscribes on unmount', async () => {
    const { unmount } = render(<PasteAndMatchStyleBridge />)
    await waitFor(() => {
      expect(listeners.has(PASTE_AND_MATCH_STYLE_EVENT)).toBe(true)
    })

    unmount()

    await waitFor(() => {
      expect(listeners.has(PASTE_AND_MATCH_STYLE_EVENT)).toBe(false)
    })
  })

  it('does nothing without a native shell bridge', () => {
    setBridge(null)
    render(<PasteAndMatchStyleBridge />)

    expect(listeners.size).toBe(0)
  })
})
