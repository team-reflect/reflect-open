import { beforeEach, describe, expect, it, vi } from 'vitest'

const hasBridge = vi.hoisted(() => vi.fn(() => true))
const openNoteWindow = vi.hoisted(() => vi.fn<(link: string) => Promise<void>>())
const isMobileSurface = vi.hoisted(() => vi.fn(() => false))

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge,
  openNoteWindow,
}))
vi.mock('@/lib/platform-surface', () => ({ isMobileSurface }))

import {
  isNewWindowClick,
  openDeepLinkInNewWindow,
  openRouteInNewWindow,
} from './open-in-new-window'

beforeEach(() => {
  vi.clearAllMocks()
  hasBridge.mockReturnValue(true)
  isMobileSurface.mockReturnValue(false)
  openNoteWindow.mockResolvedValue(undefined)
})

describe('isNewWindowClick', () => {
  it('answers true for ⌘-click and ctrl-click', () => {
    expect(isNewWindowClick(new MouseEvent('click', { metaKey: true }))).toBe(true)
    expect(isNewWindowClick(new MouseEvent('click', { ctrlKey: true }))).toBe(true)
  })

  it('answers false for a plain click and a missing event', () => {
    expect(isNewWindowClick(new MouseEvent('click'))).toBe(false)
    expect(isNewWindowClick(undefined)).toBe(false)
  })

  it('never treats a keyboard follow as a new-window request', () => {
    // Mod-Enter follows a link with the modifier held by definition — it must
    // stay an in-window navigation.
    expect(isNewWindowClick(new KeyboardEvent('keydown', { metaKey: true }))).toBe(false)
  })
})

describe('openRouteInNewWindow', () => {
  it('opens the route’s deep link', async () => {
    await expect(openRouteInNewWindow({ kind: 'note', path: 'notes/foo.md' })).resolves.toBe(true)
    expect(openNoteWindow).toHaveBeenCalledWith('reflect://note/notes%2Ffoo.md')
  })

  it('declines routes the deep-link grammar does not name', async () => {
    await expect(openRouteInNewWindow({ kind: 'allNotes', tag: null })).resolves.toBe(false)
    expect(openNoteWindow).not.toHaveBeenCalled()
  })

  it('declines without a native shell and on mobile', async () => {
    hasBridge.mockReturnValue(false)
    await expect(openRouteInNewWindow({ kind: 'note', path: 'notes/foo.md' })).resolves.toBe(false)
    hasBridge.mockReturnValue(true)
    isMobileSurface.mockReturnValue(true)
    await expect(openRouteInNewWindow({ kind: 'note', path: 'notes/foo.md' })).resolves.toBe(false)
    expect(openNoteWindow).not.toHaveBeenCalled()
  })

  it('degrades a failed command to false instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    openNoteWindow.mockRejectedValue(new Error('no window for you'))
    await expect(openRouteInNewWindow({ kind: 'note', path: 'notes/foo.md' })).resolves.toBe(false)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})

describe('openDeepLinkInNewWindow', () => {
  it('opens addressing links verbatim', async () => {
    await expect(openDeepLinkInNewWindow('reflect://note/Some%20Note')).resolves.toBe(true)
    expect(openNoteWindow).toHaveBeenCalledWith('reflect://note/Some%20Note')
  })

  it('declines capture links — they are writes, not places', async () => {
    await expect(openDeepLinkInNewWindow('reflect://append?text=hi')).resolves.toBe(false)
    expect(openNoteWindow).not.toHaveBeenCalled()
  })

  it('declines malformed links', async () => {
    await expect(openDeepLinkInNewWindow('reflect://nonsense/x')).resolves.toBe(false)
    expect(openNoteWindow).not.toHaveBeenCalled()
  })
})
