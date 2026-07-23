import { renderHook } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setWindowTitle = vi.hoisted(() => vi.fn())
vi.mock('@/lib/windows/window-title', () => ({ setWindowTitle }))

import { useNoteWindowTitle } from './use-note-window-title'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useNoteWindowTitle', () => {
  it('sets the title and follows changes (a rename)', async () => {
    const view = await renderHook(
      ({ title }: { title: string | null } = { title: 'Meeting Notes' }) =>
        useNoteWindowTitle(title),
      {
        initialProps: { title: 'Meeting Notes' },
      },
    )
    expect(setWindowTitle).toHaveBeenLastCalledWith('Meeting Notes')

    await view.rerender({ title: 'Renamed Notes' })
    expect(setWindowTitle).toHaveBeenLastCalledWith('Renamed Notes')
  })

  it('falls back to the app name while the title is unknown', async () => {
    await renderHook(() => useNoteWindowTitle(null))
    expect(setWindowTitle).toHaveBeenLastCalledWith('Reflect')
  })
})
