import { describe, expect, it } from 'vitest'
import { listRegisteredBindings, registerKeymap } from './keymap.ts'

describe('keymap registry', () => {
  it('rejects duplicate bindings across scopes', () => {
    expect(() => registerKeymap('app', { 'Mod-b': 'collides' })).toThrow(/duplicate keybinding/)
  })

  it('registers all-or-nothing: a colliding batch commits no keys', () => {
    expect(() => registerKeymap('app', { 'Mod-zz-unique': 'fine', 'Mod-b': 'collides' })).toThrow(
      /duplicate keybinding/,
    )
    expect(listRegisteredBindings().has('Mod-zz-unique')).toBe(false)
    expect(listRegisteredBindings().get('Mod-b')).toBe('editor') // untouched
  })

  it('rejects bindings that are the same keystroke on some platform', () => {
    // `Mod` is ⌘ on macOS: `Meta-b` is meowdown's `Mod-b` there.
    expect(() => registerKeymap('app', { 'Meta-b': 'collides' })).toThrow(
      /already registered by the editor scope as "Mod-b"/,
    )
    // ...and Ctrl elsewhere.
    expect(() => registerKeymap('app', { 'Ctrl-i': 'collides' })).toThrow(/duplicate keybinding/)
    // Modifier order does not matter.
    expect(() => registerKeymap('app', { 'Shift-Mod-x': 'collides' })).toThrow(
      /duplicate keybinding/,
    )
    expect(() => registerKeymap('app', { 'Meta-F13': 'fine', 'Mod-F13': 'collides' })).toThrow(
      /duplicate keybinding/,
    )
    expect(listRegisteredBindings().has('Meta-F13')).toBe(false)
  })

  it('holds meowdown editor bindings editor-scope', () => {
    const bindings = listRegisteredBindings()
    expect(bindings.get('Mod-b')).toBe('editor')
    expect(bindings.get('Mod-i')).toBe('editor')
    expect(bindings.get('Mod-Shift-7')).toBe('editor')
  })

  it('leaves meowdown heading shortcuts to graph switching', () => {
    const bindings = listRegisteredBindings()
    for (const level of [1, 2, 3, 4, 5, 6]) {
      expect(bindings.has(`Mod-${level}`)).toBe(false)
    }
  })
})
