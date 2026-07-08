import { afterEach, describe, expect, it, vi } from 'vitest'
import { listCommands, registerCommands, resetCommands, runCommand } from './registry'
import type { CommandContext } from './types'

afterEach(() => {
  resetCommands()
})

function fakeContext(overrides?: Partial<CommandContext>): CommandContext {
  return {
    navigate: vi.fn(),
    route: () => ({ kind: 'today' }),
    notePath: () => null,
    back: vi.fn(),
    forward: vi.fn(),
    clearScrollState: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    switchGraph: vi.fn(),
    toggleAudioMemo: vi.fn(),
    generation: () => 1,
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
    ...overrides,
  }
}

describe('command registry', () => {
  it('registers, lists in order, and runs by id', async () => {
    const ran: string[] = []
    registerCommands([
      { id: 'a', title: 'A', run: () => void ran.push('a') },
      { id: 'b', title: 'B', run: () => void ran.push('b') },
    ])
    expect(listCommands().map((command) => command.id)).toEqual(['a', 'b'])
    await runCommand('b', fakeContext())
    expect(ran).toEqual(['b'])
  })

  it('throws on a duplicate id (a programmer error, not a runtime state)', () => {
    registerCommands([{ id: 'a', title: 'A', run: () => {} }])
    expect(() => registerCommands([{ id: 'a', title: 'again', run: () => {} }])).toThrow(
      /already registered/,
    )
  })

  it('an unknown id is a loud no-op (deep links may dangle)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await runCommand('missing', fakeContext())
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('missing'))
    } finally {
      errorSpy.mockRestore()
    }
  })
})
