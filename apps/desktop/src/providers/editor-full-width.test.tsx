import { render } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorFullWidthEffect } from './editor-full-width'

const settingsState = vi.hoisted(() => ({ editorFullWidth: false }))

vi.mock('@/providers/settings-provider', () => ({
  useSettings: () => ({ settings: settingsState }),
}))

afterEach(() => {
  delete document.documentElement.dataset['editorFullWidth']
  settingsState.editorFullWidth = false
})

describe('EditorFullWidthEffect', () => {
  it('mirrors the live setting onto the document root', async () => {
    const view = await render(<EditorFullWidthEffect />)
    expect(document.documentElement.dataset['editorFullWidth']).toBe('false')

    settingsState.editorFullWidth = true
    await view.rerender(<EditorFullWidthEffect />)

    expect(document.documentElement.dataset['editorFullWidth']).toBe('true')
  })
})
