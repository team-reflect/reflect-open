import { describe, expect, it } from 'vitest'
import { createTestLoggerService, createTestPlatformService } from '@reflect/core/testing'
import {
  createCommandService,
  type AppCommandId,
  type CommandContext,
  type CommandKeyEvent,
} from './command-service.ts'
import { noop } from '@ocavue/utils'

// The registry passes the context through without reading it.
const CONTEXT = {} as CommandContext

function setup(options?: { isApplePlatform?: boolean }) {
  const logger = createTestLoggerService()
  const commands = createCommandService({
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
    const ran: CommandContext[] = []
    commands.register([
      { id: 'nav.today', title: 'A', run: noop },
      { id: 'nav.allNotes', title: 'B', run: (context) => void ran.push(context) },
    ])
    expect(commands.list().map((command) => command.id)).toEqual(['nav.today', 'nav.allNotes'])
    await commands.run('nav.allNotes', CONTEXT)
    expect(ran).toEqual([CONTEXT])
  })

  it('throws on a duplicate id (a programmer error, not a runtime state)', () => {
    const { commands } = setup()
    commands.register([{ id: 'nav.today', title: 'A', run: noop }])
    expect(() => commands.register([{ id: 'nav.today', title: 'again', run: noop }])).toThrow(
      /already registered/,
    )
  })

  it('throws on a blank id or title', () => {
    const { commands } = setup()
    expect(() => commands.register([{ id: ' ' as AppCommandId, title: 'A', run: noop }])).toThrow(
      'command id cannot be empty',
    )
    expect(() => commands.register([{ id: 'nav.today', title: '', run: noop }])).toThrow(
      'command title cannot be empty: nav.today',
    )
  })

  it('an unknown id is a loud no-op (deep links may dangle)', async () => {
    const { commands, logger } = setup()
    // Ids from outside, such as a deep link, are checked only at run time.
    await commands.run('missing' as AppCommandId, CONTEXT)
    expect(logger.getErrors()).toEqual([{ message: 'unknown command: missing', cause: undefined }])
  })

  it('keeps each registry separate', () => {
    const { commands } = setup()
    commands.register([{ id: 'nav.today', title: 'A', run: noop }])
    expect(setup().commands.list()).toEqual([])
  })
})

describe('commandForKeyDown', () => {
  function bound(options?: { isApplePlatform?: boolean }) {
    const { commands } = setup(options)
    commands.register([
      { id: 'nav.today', title: 'Today', keybinding: 'Mod-d', run: noop },
      { id: 'nav.allNotes', title: 'All notes', keybinding: 'Mod-Shift-a', run: noop },
      { id: 'history.back', title: 'Back', keybinding: 'Mod-[', run: noop },
      { id: 'note.copyDeepLink', title: 'Copy link', keybinding: 'Alt-Mod-l', run: noop },
      { id: 'graph.switch2', title: 'Graph 2', keybinding: 'Mod-2', run: noop },
      { id: 'theme.toggle', title: 'Unbound', run: noop },
    ])
    return commands
  }

  it('matches ⌘ on Apple and Ctrl elsewhere', () => {
    expect(bound().commandForKeyDown(keyDown({ key: 'd', code: 'KeyD', metaKey: true }))).toBe(
      'nav.today',
    )
    expect(bound().commandForKeyDown(keyDown({ key: 'd', code: 'KeyD', ctrlKey: true }))).toBeNull()
    const other = bound({ isApplePlatform: false })
    expect(other.commandForKeyDown(keyDown({ key: 'd', code: 'KeyD', ctrlKey: true }))).toBe(
      'nav.today',
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
    ).toBe('nav.allNotes')
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
    ).toBe('note.copyDeepLink')
  })

  it('matches brackets by physical code', () => {
    expect(
      bound().commandForKeyDown(keyDown({ key: 'Dead', code: 'BracketLeft', metaKey: true })),
    ).toBe('history.back')
  })

  it('matches a number-row digit that the layout types with Shift', () => {
    const commands = bound()
    expect(
      commands.commandForKeyDown(
        keyDown({ key: '2', code: 'Digit2', metaKey: true, shiftKey: true }),
      ),
    ).toBe('graph.switch2')
    // US-style ⌘⇧2 types "@": that is not the ⌘2 shortcut.
    expect(
      commands.commandForKeyDown(
        keyDown({ key: '@', code: 'Digit2', metaKey: true, shiftKey: true }),
      ),
    ).toBeNull()
  })
})
