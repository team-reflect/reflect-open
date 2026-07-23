import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setWindowTitle = vi.hoisted(() => vi.fn())
vi.mock('@/lib/windows/window-title', () => ({ setWindowTitle }))

import { useNoteWindowTitle } from './use-note-window-title'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useNoteWindowTitle', () => {
  it('sets the title and follows changes (a rename)', () => {
    const view = renderHook(({ title }: { title: string | null }) => useNoteWindowTitle(title), {
      initialProps: { title: 'Meeting Notes' },
    })
    expect(setWindowTitle).toHaveBeenLastCalledWith('Meeting Notes')

    view.rerender({ title: 'Renamed Notes' })
    expect(setWindowTitle).toHaveBeenLastCalledWith('Renamed Notes')
  })

  it('falls back to the app name while the title is unknown', () => {
    renderHook(() => useNoteWindowTitle(null))
    expect(setWindowTitle).toHaveBeenLastCalledWith('Reflect')
  })
})
