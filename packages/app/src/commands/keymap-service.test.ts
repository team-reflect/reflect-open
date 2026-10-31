import { describe, expect, it } from 'vitest'
import { createTestPlatformService } from '@reflect/core/testing'
import { createKeymapService } from './keymap-service.ts'

function setup(options?: { isApplePlatform?: boolean }) {
  const keymap = createKeymapService({
    platform: createTestPlatformService({ isApplePlatform: options?.isApplePlatform ?? true }),
  })
  keymap.register('editor', { 'Mod-b': 'bold', 'Mod-Shift-x': 'strike' })
  return keymap
}

describe('createKeymapService', () => {
  it('returns the registered bindings and lists them under their scope', () => {
    const keymap = setup()
    const bindings = { 'Mod-d': 'today' }
    expect(keymap.register('app', bindings)).toBe(bindings)
    expect(keymap.list().get('Mod-b')).toBe('editor')
    expect(keymap.list().get('Mod-d')).toBe('app')
  })

  it('rejects duplicate bindings across scopes', () => {
    const keymap = setup()
    expect(() => keymap.register('app', { 'Mod-b': 'collides' })).toThrow(/duplicate keybinding/)
  })

  it('registers all-or-nothing: a colliding batch commits no keys', () => {
    const keymap = setup()
    expect(() => keymap.register('app', { 'Mod-F13': 'fine', 'Mod-b': 'collides' })).toThrow(
      /duplicate keybinding/,
    )
    expect(keymap.list().has('Mod-F13')).toBe(false)
    expect(keymap.list().get('Mod-b')).toBe('editor') // untouched
  })

  it('compares bindings after normalizing them', () => {
    const keymap = setup()
    expect(() => keymap.register('app', { 'Shift-Mod-x': 'collides' })).toThrow(
      /already registered by the editor scope as "Mod-Shift-x"/,
    )
    expect(() => {
      return keymap.register('app', { 'Alt-Mod-F14': 'fine', 'Mod-Alt-F14': 'collides' })
    }).toThrow(/duplicate keybinding/)
    expect(keymap.list().has('Alt-Mod-F14')).toBe(false)
  })

  it('normalizes with the platform: Ctrl is the command key off Apple', () => {
    expect(() => setup({ isApplePlatform: false }).register('app', { 'Ctrl-b': 'x' })).toThrow(
      /already registered by the editor scope as "Mod-b"/,
    )
    expect(setup().register('app', { 'Ctrl-b': 'x' })).toEqual({ 'Ctrl-b': 'x' })
  })

  it('rejects Meta: bindings spell the command key Mod', () => {
    const keymap = setup()
    expect(() => keymap.register('app', { 'Meta-F15': 'meta' })).toThrow(/uses Meta; use Mod/)
    expect(keymap.list().has('Meta-F15')).toBe(false)
  })

  it('keeps each registry separate', () => {
    const keymap = setup()
    expect(setup().list()).not.toBe(keymap.list())
    expect(() => setup().register('app', { 'Mod-d': 'today' })).not.toThrow()
    keymap.register('app', { 'Mod-d': 'today' })
    expect(() => keymap.register('app', { 'Mod-d': 'again' })).toThrow(/duplicate keybinding/)
  })

  it('formats one label with the platform symbols', () => {
    expect(setup().formatLabel('Mod-Shift-p')).toBe('⌘⇧P')
    expect(setup({ isApplePlatform: false }).formatLabel('Mod-Shift-p')).toBe('Ctrl+Shift+P')
  })
})
