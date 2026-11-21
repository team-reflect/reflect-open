import { isNotNullish } from '@ocavue/utils'
import { describe, expect, it } from 'vitest'
import { APP_MENU_LAYOUT } from './app-menu.ts'

describe('APP_MENU_LAYOUT', () => {
  it('lists each command at most once across the whole menu', () => {
    const referenced = APP_MENU_LAYOUT.flatMap((submenu) => {
      return submenu.entries
        .map((entry) => (entry.kind === 'command' ? entry.commandId : null))
        .filter(isNotNullish)
    })
    expect(new Set(referenced).size).toBe(referenced.length)
  })
})
