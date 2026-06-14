import { describe, expect, it } from 'vitest'
import { APP_COMMANDS, keybindingFor } from '@/lib/commands/app-commands'
import { appMenuLayout } from './menu'

function referencedCommandIds(): string[] {
  return appMenuLayout().flatMap((submenu) =>
    submenu.entries.flatMap((entry) => (entry.kind === 'command' ? [entry.commandId] : [])),
  )
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
})
