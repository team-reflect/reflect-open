import { describe, expect, it } from 'vitest'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useNoteWindowTitle } from './use-note-window-title.ts'

describe('useNoteWindowTitle', () => {
  it('sets the title and follows changes (a rename)', async () => {
    const view = await renderHookInApp(
      ({ title }: { title: string | null } = { title: 'Meeting Notes' }) => {
        useNoteWindowTitle(title)
      },
      {
        initialProps: { title: 'Meeting Notes' },
      },
    )
    expect(view.app.window.title()).toBe('Meeting Notes')

    await view.rerender({ title: 'Renamed Notes' })
    expect(view.app.window.title()).toBe('Renamed Notes')
  })

  it('falls back to the app name while the title is unknown', async () => {
    const { app } = await renderHookInApp(() => useNoteWindowTitle(null))
    expect(app.window.title()).toBe('Reflect')
  })
})
