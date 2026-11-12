import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { EditorFullWidthEffect } from './editor-full-width.tsx'

afterEach(() => {
  delete document.documentElement.dataset['editorFullWidth']
})

describe('EditorFullWidthEffect', () => {
  it('mirrors the live setting onto the document root', async () => {
    const { core } = await renderInApp(<EditorFullWidthEffect />, {
      settings: { editorFullWidth: false },
    })
    expect(document.documentElement.dataset['editorFullWidth']).toBe('false')

    core.settings.update({ editorFullWidth: true })

    await vi.waitFor(() => expect(document.documentElement.dataset['editorFullWidth']).toBe('true'))
  })
})
