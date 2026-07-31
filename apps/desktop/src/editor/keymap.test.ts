import { describe, expect, it } from 'vitest'
import { listRegisteredBindings, registerKeymap } from './keymap'

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

  it('holds meowdown editor bindings editor-scope', () => {
    const bindings = listRegisteredBindings()
    expect(bindings.get('Mod-b')).toBe('editor')
    expect(bindings.get('Mod-i')).toBe('editor')
    expect(bindings.get('Mod-1')).toBe('editor')
  })
})
