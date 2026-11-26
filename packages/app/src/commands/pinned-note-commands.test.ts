import { describe, expect, it } from 'vitest'
import { APP_COMMANDS } from './app-commands.ts'
import { PINNED_NOTE_COMMAND_IDS } from './pinned-note-commands.ts'

describe('pinned note commands', () => {
  it('bind ⌘6–⌘9 to the top four shelf positions', () => {
    expect(PINNED_NOTE_COMMAND_IDS.map((id) => [id, APP_COMMANDS[id].keybinding])).toEqual([
      ['pinned.open1', 'Mod-6'],
      ['pinned.open2', 'Mod-7'],
      ['pinned.open3', 'Mod-8'],
      ['pinned.open4', 'Mod-9'],
    ])
  })

  it('leave graph switching only ⌘1–⌘5', () => {
    expect(APP_COMMANDS['graph.switch5'].keybinding).toBe('Mod-5')
    expect(APP_COMMANDS['graph.switch6'].keybinding).toBeUndefined()
    expect(APP_COMMANDS['graph.switch9'].keybinding).toBeUndefined()
  })
})
