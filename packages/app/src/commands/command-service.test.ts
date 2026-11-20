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
    expect(commands.list().map((command) => command.id)).toEqual(Object.keys(APP_COMMANDS))
  })

  it('runs the handler of a command', async () => {
    const { commands } = setup()
    const ran: string[] = []
    commands.handle('nav.today', () => void ran.push('today'), new AbortController().signal)
    expect(commands.isHandled('nav.today')).toBe(true)
    await commands.run('nav.today')
    expect(ran).toEqual(['today'])
  })

  it('does nothing for a command without a handler', async () => {
    const { commands } = setup()
    expect(commands.isHandled('nav.today')).toBe(false)
    await expect(commands.run('nav.today')).resolves.toBeUndefined()
    expect(commands.trigger('nav.today')).toBe(false)
  })

  it('removes a handler when its signal aborts', () => {
    const { commands } = setup()
    const controller = new AbortController()
    commands.handle('nav.today', noop, controller.signal)
    controller.abort()
    expect(commands.isHandled('nav.today')).toBe(false)
  })

  it('keeps a newer registration of the same handler when an older one aborts', () => {
    const { commands } = setup()
    const older = new AbortController()
    commands.handle('nav.today', noop, older.signal)
    commands.handle('nav.today', noop, new AbortController().signal)
    older.abort()
    expect(commands.isHandled('nav.today')).toBe(true)
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
    void commands.run('nav.today')
    block.abort()
    expect(commands.trigger('nav.today')).toBe(true)
    expect(ran).toEqual(['shortcuts', 'today', 'today'])
  })

  it('applies only the latest active block', () => {
    const { commands } = setup()
    const handlers = new AbortController()
    commands.handle('nav.today', noop, handlers.signal)
    commands.handle('shortcuts.show', noop, handlers.signal)
    const palette = new AbortController()
    const sheet = new AbortController()
    commands.block([], palette.signal)
    commands.block(['shortcuts.show'], sheet.signal)
    expect(commands.trigger('shortcuts.show')).toBe(true)
    expect(commands.trigger('nav.today')).toBe(false)
    palette.abort()
    expect(commands.trigger('nav.today')).toBe(false)
    sheet.abort()
    expect(commands.trigger('nav.today')).toBe(true)
  })

  it('logs a handler that throws synchronously', async () => {
    const { commands, logger } = setup()
    const failure = new Error('boom')
    commands.handle(
      'note.random',
      () => {
        throw failure
      },
      new AbortController().signal,
    )
    expect(commands.trigger('note.random')).toBe(true)
    await expect
      .poll(() => logger.getErrors())
      .toEqual([{ message: 'command failed: note.random', cause: failure }])
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
