import { describe, expect, it } from 'vitest'
import { listRegisteredBindings, registerKeymap } from './keymap.ts'

describe('keymap registry', () => {
  it('rejects duplicate bindings across scopes', () => {
    expect(() => registerKeymap('app', { 'Mod-b': 'collides' })).toThrow(/duplicate keybinding/)
  })

  it('registers all-or-nothing: a colliding batch commits no keys', () => {
    expect(() => registerKeymap('app', { 'Mod-F13': 'fine', 'Mod-b': 'collides' })).toThrow(
      /duplicate keybinding/,
    )
    expect(listRegisteredBindings().has('Mod-F13')).toBe(false)
    expect(listRegisteredBindings().get('Mod-b')).toBe('editor') // untouched
  })

  it('compares bindings after normalizing them', () => {
    expect(() => registerKeymap('app', { 'Shift-Mod-x': 'collides' })).toThrow(
      /already registered by the editor scope as "Mod-Shift-x"/,
    )
    expect(() => registerKeymap('app', { 'Alt-Mod-F14': 'fine', 'Mod-Alt-F14': 'collides' })).toThrow(
      /duplicate keybinding/,
    )
    expect(listRegisteredBindings().has('Alt-Mod-F14')).toBe(false)
  })

  it('rejects Meta: bindings spell the command key Mod', () => {
    expect(() => registerKeymap('app', { 'Meta-F15': 'meta' })).toThrow(/uses Meta; use Mod/)
    expect(listRegisteredBindings().has('Meta-F15')).toBe(false)
  })

  it('holds meowdown editor bindings editor-scope', () => {
    const bindings = listRegisteredBindings()
    expect(bindings.get('Mod-b')).toBe('editor')
    expect(bindings.get('Mod-i')).toBe('editor')
    expect(bindings.get('Mod-Alt-1')).toBe('editor')
  })
})
