import { describe, expect, it } from 'vitest'
import { createTestLoggerService, createTestPlatformService } from '@reflect/core/testing'
import { createCommandService, type CommandKeyEvent } from './command-service.ts'

function setup(options?: { isApplePlatform?: boolean }) {
  const logger = createTestLoggerService()
  const commands = createCommandService<string[]>({
    platform: createTestPlatformService({ isApplePlatform: options?.isApplePlatform ?? true }),
    logger,
  })
  return { commands, logger }
}

function keyDown(overrides: Partial<CommandKeyEvent>): CommandKeyEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides,
  }
}

describe('createCommandService', () => {
  it('registers, lists in order, and runs by id', async () => {
    const { commands } = setup()
    commands.register([
      { id: 'a', title: 'A', run: (ran) => void ran.push('a') },
      { id: 'b', title: 'B', run: (ran) => void ran.push('b') },
    ])
    expect(commands.list().map((command) => command.id)).toEqual(['a', 'b'])
    const ran: string[] = []
    await commands.run('b', ran)
    expect(ran).toEqual(['b'])
  })

  it('throws on a duplicate id (a programmer error, not a runtime state)', () => {
    const { commands } = setup()
    commands.register([{ id: 'a', title: 'A', run: () => {} }])
    expect(() => commands.register([{ id: 'a', title: 'again', run: () => {} }])).toThrow(
      /already registered/,
    )
  })

  it('throws on a blank id or title', () => {
    const { commands } = setup()
    expect(() => commands.register([{ id: ' ', title: 'A', run: () => {} }])).toThrow(
      'command id cannot be empty',
    )
    expect(() => commands.register([{ id: 'a', title: '', run: () => {} }])).toThrow(
      'command title cannot be empty: a',
    )
  })

  it('an unknown id is a loud no-op (deep links may dangle)', async () => {
    const { commands, logger } = setup()
    await commands.run('missing', [])
    expect(logger.getErrors()).toEqual([{ message: 'unknown command: missing', cause: undefined }])
  })

  it('keeps each registry separate', () => {
    const { commands } = setup()
    commands.register([{ id: 'a', title: 'A', run: () => {} }])
    expect(setup().commands.list()).toEqual([])
  })
})

describe('commandForKeyDown', () => {
  function bound(options?: { isApplePlatform?: boolean }) {
    const { commands } = setup(options)
    commands.register([
      { id: 'today', title: 'Today', keybinding: 'Mod-d', run: () => {} },
      { id: 'all', title: 'All notes', keybinding: 'Mod-Shift-a', run: () => {} },
      { id: 'back', title: 'Back', keybinding: 'Mod-[', run: () => {} },
      { id: 'link', title: 'Copy link', keybinding: 'Alt-Mod-l', run: () => {} },
      { id: 'graph2', title: 'Graph 2', keybinding: 'Mod-2', run: () => {} },
      { id: 'unbound', title: 'Unbound', run: () => {} },
    ])
    return commands
  }

  it('matches ⌘ on Apple and Ctrl elsewhere', () => {
    expect(bound().commandForKeyDown(keyDown({ key: 'd', code: 'KeyD', metaKey: true }))).toBe(
      'today',
    )
    expect(bound().commandForKeyDown(keyDown({ key: 'd', code: 'KeyD', ctrlKey: true }))).toBeNull()
    const other = bound({ isApplePlatform: false })
    expect(other.commandForKeyDown(keyDown({ key: 'd', code: 'KeyD', ctrlKey: true }))).toBe(
      'today',
    )
    expect(other.commandForKeyDown(keyDown({ key: 'd', code: 'KeyD', metaKey: true }))).toBeNull()
  })

  it('ignores keys without ⌘ or Ctrl, and held keys', () => {
    const commands = bound()
    expect(commands.commandForKeyDown(keyDown({ key: 'd', code: 'KeyD' }))).toBeNull()
    expect(
      commands.commandForKeyDown(keyDown({ key: 'd', code: 'KeyD', metaKey: true, repeat: true })),
    ).toBeNull()
  })

  it('counts every held modifier', () => {
    const commands = bound()
    expect(
      commands.commandForKeyDown(
        keyDown({ key: 'A', code: 'KeyA', metaKey: true, shiftKey: true }),
      ),
    ).toBe('all')
    expect(
      commands.commandForKeyDown(
        keyDown({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true }),
      ),
    ).toBeNull()
    expect(
      commands.commandForKeyDown(keyDown({ key: '∂', code: 'KeyD', metaKey: true, altKey: true })),
    ).toBeNull()
  })

  it('matches alt chords by physical code', () => {
    expect(
      bound().commandForKeyDown(keyDown({ key: '¬', code: 'KeyL', metaKey: true, altKey: true })),
    ).toBe('link')
  })

  it('matches brackets by physical code', () => {
    expect(
      bound().commandForKeyDown(keyDown({ key: 'Dead', code: 'BracketLeft', metaKey: true })),
    ).toBe('back')
  })

  it('matches a number-row digit that the layout types with Shift', () => {
    const commands = bound()
    expect(
      commands.commandForKeyDown(
        keyDown({ key: '2', code: 'Digit2', metaKey: true, shiftKey: true }),
      ),
    ).toBe('graph2')
    // US-style ⌘⇧2 types "@": that is not the ⌘2 shortcut.
    expect(
      commands.commandForKeyDown(
        keyDown({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true }),
      ),
    ).toBeNull()
  })
})
