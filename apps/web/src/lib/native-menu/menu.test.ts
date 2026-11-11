import { isNotNullish } from '@ocavue/utils'
import { describe, expect, it } from 'vitest'
import { APP_COMMANDS, keybindingFor } from '@/lib/commands/app-commands.ts'
import { appMenuLayout } from './menu.ts'

function referencedCommandIds(): string[] {
  return appMenuLayout().flatMap((submenu) => {
    return submenu.entries
      .map((entry) => (entry.kind === 'command' ? entry.commandId : null))
      .filter(isNotNullish)
  })
}

describe('appMenuLayout', () => {
  it('references only registered command ids', () => {
    const known = new Set(APP_COMMANDS.map((appCommand) => appCommand.id))
    const referenced = referencedCommandIds()
    expect(referenced.length).toBeGreaterThan(0)
    for (const commandId of referenced) {
      expect(known).toContain(commandId)
    }
  })

  it('surfaces every ported V1 menu shortcut', () => {
    const referenced = new Set(referencedCommandIds())
    // The V1 Electron menu items that have a V2 command: Preferences ⌘,
    // New Note ⌘N, Search ⌘K, Select Daily Note ⌘D, All Notes ⌘⇧A,
    // Back ⌘[, Forward ⌘], Open Shortcuts ⌘/.
    for (const commandId of [
      'settings.open',
      'note.new',
      'palette.open',
      'nav.today',
      'nav.allNotes',
      'history.back',
      'history.forward',
      'shortcuts.show',
    ]) {
      expect(referenced).toContain(commandId)
    }
    expect(keybindingFor('nav.allNotes')).toBe('Mod-Shift-a')
  })

  it('lists each command at most once across the whole menu', () => {
    const referenced = referencedCommandIds()
    expect(new Set(referenced).size).toBe(referenced.length)
  })

  it('exposes the selected note’s new-window shortcut in the native Window menu', () => {
    const windowMenu = appMenuLayout().find((submenu) => submenu.text === 'Window')
    expect(windowMenu?.entries).toContainEqual({
      kind: 'command',
      commandId: 'note.openInNewWindow',
      text: undefined,
    })
    expect(keybindingFor('note.openInNewWindow')).toBe('Mod-Shift-o')
  })
  it('puts note Find commands and their browser-standard shortcuts in Edit', () => {
    const editMenu = appMenuLayout().find((submenu) => submenu.text === 'Edit')
    expect(editMenu?.entries).toEqual(
      expect.arrayContaining([
        { kind: 'command', commandId: 'note.find', text: undefined },
        { kind: 'command', commandId: 'note.findNext', text: undefined },
        { kind: 'command', commandId: 'note.findPrevious', text: undefined },
      ]),
    )
    expect(keybindingFor('note.find')).toBe('Mod-f')
    expect(keybindingFor('note.findNext')).toBe('Mod-g')
    expect(keybindingFor('note.findPrevious')).toBe('Mod-Shift-g')
  })
})
