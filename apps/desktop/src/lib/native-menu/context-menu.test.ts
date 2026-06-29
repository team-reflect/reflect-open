import { beforeEach, describe, expect, it, vi } from 'vitest'

const isTauri = vi.hoisted(() => vi.fn(() => true))
const popup = vi.hoisted(() => vi.fn(async () => {}))
interface NativeMenuItemForTest {
  text: string
  action?: () => void
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

const { openNativeContextMenu } = await import('./context-menu')

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

describe('openNativeContextMenu', () => {
  it('does nothing outside Tauri', async () => {
    isTauri.mockReturnValue(false)
    const onSelect = vi.fn()

    await openNativeContextMenu({ items: [{ text: 'Unpin Note', action: onSelect }] })

    expect(menuNew).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('opens a native menu whose items run their actions', async () => {
    const onSelect = vi.fn()

    await openNativeContextMenu({ items: [{ text: 'Unpin Note', action: onSelect }] })

    expect(menuNew).toHaveBeenCalledWith({
      items: [
        expect.objectContaining({
          text: 'Unpin Note',
        }),
      ],
    })
    expect(popup).toHaveBeenCalled()
    const item = firstMenuItem()
    item.action?.()
    expect(onSelect).toHaveBeenCalled()
  })
})
