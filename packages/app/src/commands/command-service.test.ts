import { describe, expect, it } from 'vitest'
import { createTestLoggerService, createTestPlatformService } from '@reflect/core/testing'
import { APP_COMMANDS } from './app-commands.ts'
import { createCommandService, type CommandKeyEvent } from './command-service.ts'
import { noop } from '@ocavue/utils'

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
  it('lists the declared commands in order', () => {
    const { commands } = setup()
    expect(commands.list()).toBe(APP_COMMANDS)
  })

  it('runs the current handler and returns its result', async () => {
    const { commands } = setup()
    const ran: string[] = []
    const controller = new AbortController()
    commands.handle(
      'note.random',
      () => {
        ran.push('random')
        return Promise.resolve()
      },
      controller.signal,
    )
    expect(commands.isHandled('note.random')).toBe(true)
    await commands.run('note.random')
    expect(ran).toEqual(['random'])
  })

  it('does nothing for a command without a handler', () => {
    const { commands } = setup()
    expect(commands.isHandled('nav.today')).toBe(false)
    expect(commands.run('nav.today')).toBeUndefined()
    expect(commands.trigger('nav.today')).toBe(false)
  })

  it('lets a later handler shadow an earlier one until it is removed', () => {
    const { commands } = setup()
    const ran: string[] = []
    const outer = new AbortController()
    const inner = new AbortController()
    commands.handle('nav.today', () => void ran.push('outer'), outer.signal)
    commands.handle('nav.today', () => void ran.push('inner'), inner.signal)
    commands.run('nav.today')
    inner.abort()
    commands.run('nav.today')
    outer.abort()
    expect(commands.run('nav.today')).toBeUndefined()
    expect(ran).toEqual(['inner', 'outer'])
  })

  it('ignores a handler whose signal already aborted', () => {
    const { commands } = setup()
    commands.handle('nav.today', noop, AbortSignal.abort())
    expect(commands.isHandled('nav.today')).toBe(false)
  })

  it('stops triggers outside the allow list while a block is active', () => {
    const { commands } = setup()
    const ran: string[] = []
    const handlers = new AbortController()
    commands.handle('nav.today', () => void ran.push('today'), handlers.signal)
    commands.handle('shortcuts.show', () => void ran.push('shortcuts'), handlers.signal)
    const block = new AbortController()
    commands.block(['shortcuts.show'], block.signal)
    expect(commands.trigger('nav.today')).toBe(false)
    expect(commands.trigger('shortcuts.show')).toBe(true)
    // A direct run is the caller's decision, so blocks do not apply to it.
    commands.run('nav.today')
    block.abort()
    expect(commands.trigger('nav.today')).toBe(true)
    expect(ran).toEqual(['shortcuts', 'today', 'today'])
  })

  it('logs the failure of a triggered handler', async () => {
    const { commands, logger } = setup()
    const failure = new Error('boom')
    commands.handle('note.random', () => Promise.reject(failure), new AbortController().signal)
    expect(commands.trigger('note.random')).toBe(true)
    await expect
      .poll(() => logger.getErrors())
      .toEqual([{ message: 'command failed: note.random', cause: failure }])
  })

  it('keeps each registry separate', () => {
    const { commands } = setup()
    commands.handle('nav.today', noop, new AbortController().signal)
    expect(setup().commands.isHandled('nav.today')).toBe(false)
  })
})

describe('commandForKeyDown', () => {
  function bound(options?: { isApplePlatform?: boolean }) {
    return setup(options).commands
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
