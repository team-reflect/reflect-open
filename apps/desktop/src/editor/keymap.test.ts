import { describe, expect, it } from 'vitest'
import { createTestAppServices } from '@reflect/app/testing'
import { createNodeTestDatabaseService, createTestCoreServices } from '@reflect/core/testing'
import { registerAppKeymaps } from '@/lib/shortcuts.ts'

function registered() {
  const { keymap } = createTestAppServices(
    createTestCoreServices({ database: createNodeTestDatabaseService() }),
  )
  registerAppKeymaps(keymap)
  return keymap
}

describe('keymap registry', () => {
  it('rejects an app binding that collides with an editor binding', () => {
    const keymap = registered()
    expect(() => keymap.register('app', { 'Mod-b': 'collides' })).toThrow(/duplicate keybinding/)
    expect(keymap.list().get('Mod-b')).toBe('editor') // untouched
  })

  it('holds meowdown editor bindings editor-scope', () => {
    const bindings = registered().list()
    expect(bindings.get('Mod-b')).toBe('editor')
    expect(bindings.get('Mod-i')).toBe('editor')
    expect(bindings.get('Mod-Alt-1')).toBe('editor')
  })
})
