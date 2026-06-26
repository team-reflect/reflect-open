import { beforeEach, describe, expect, it, vi } from 'vitest'

const isTauri = vi.hoisted(() => vi.fn(() => true))
const popup = vi.hoisted(() => vi.fn(async () => {}))
interface NativeMenuItemForTest {
  text: string
  action?: (id: string) => void
}

interface NativeMenuOptionsForTest {
  items?: NativeMenuItemForTest[]
}

interface NativeMenuForTest {
  popup: () => Promise<void>
}

const menuNew = vi.hoisted(() =>
  vi.fn(async (_options?: NativeMenuOptionsForTest): Promise<NativeMenuForTest> => ({
    popup,
  })),
)

vi.mock('@tauri-apps/api/core', () => ({ isTauri }))
vi.mock('@tauri-apps/api/menu', () => ({ Menu: { new: menuNew } }))

const { openPinnedNoteContextMenu } = await import('./pinned-note-context-menu')

beforeEach(() => {
  isTauri.mockReset().mockReturnValue(true)
  popup.mockClear()
  menuNew.mockResolvedValue({ popup })
})

function firstMenuItem(): NativeMenuItemForTest {
  const item = menuNew.mock.calls[0]?.[0]?.items?.[0]
  if (item === undefined) {
    throw new Error('expected native menu item')
  }
  return item
}

describe('openPinnedNoteContextMenu', () => {
  it('does nothing outside Tauri', async () => {
    isTauri.mockReturnValue(false)
    const onUnpin = vi.fn()

    await openPinnedNoteContextMenu(onUnpin)

    expect(menuNew).not.toHaveBeenCalled()
    expect(onUnpin).not.toHaveBeenCalled()
  })

  it('opens a native menu whose item runs the active unpin callback', async () => {
    const onUnpin = vi.fn()

    await openPinnedNoteContextMenu(onUnpin)

    expect(menuNew).toHaveBeenCalledWith({
      items: [
        expect.objectContaining({
          text: 'Unpin Note',
        }),
      ],
    })
    expect(popup).toHaveBeenCalled()
    const item = firstMenuItem()
    item.action?.('pinned-note.unpin')
    expect(onUnpin).toHaveBeenCalled()
  })
})
