import { describe, expect, it } from 'vitest'
import { APP_COMMANDS, keybindingFor } from './app-commands.ts'

describe('APP_COMMANDS', () => {
  it('declares each command once, with a title', () => {
    const ids = APP_COMMANDS.map((command) => command.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(APP_COMMANDS.filter((command) => command.title.trim() === '')).toEqual([])
  })
})

describe('keybindingFor', () => {
  it('returns the binding UI hints derive from', () => {
    expect(keybindingFor('nav.today')).toBe('Mod-d')
    expect(keybindingFor('nav.allNotes')).toBe('Mod-Shift-a')
    expect(keybindingFor('palette.open')).toBe('Mod-k')
  })

  it('returns null for unbound commands', () => {
    expect(keybindingFor('theme.toggle')).toBeNull()
  })

  it('audioMemo.toggle is bound to Mod-Shift-r', () => {
    expect(keybindingFor('audioMemo.toggle')).toBe('Mod-Shift-r')
  })

  it('dev.toggleDevtools is bound to Mod-Shift-i', () => {
    expect(keybindingFor('dev.toggleDevtools')).toBe('Mod-Shift-i')
  })

  it('note.copyDeepLink keeps the V1 copy-link shortcut', () => {
    expect(keybindingFor('note.copyDeepLink')).toBe('Alt-Mod-l')
  })

  it('note.copyPath uses the Finder copy-as-pathname chord', () => {
    expect(keybindingFor('note.copyPath')).toBe('Alt-Mod-c')
  })

  it('note.openInNewWindow uses the system-level open-window shortcut', () => {
    expect(keybindingFor('note.openInNewWindow')).toBe('Mod-Shift-o')
  })

  it('graph switch commands use command-number bindings', () => {
    expect(keybindingFor('graph.switch1')).toBe('Mod-1')
    expect(keybindingFor('graph.switch9')).toBe('Mod-9')
  })
})
