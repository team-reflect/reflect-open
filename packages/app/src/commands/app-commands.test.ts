import { describe, expect, it } from 'vitest'
import { APP_COMMANDS, keybindingFor } from './app-commands.ts'

describe('APP_COMMANDS', () => {
  it('gives each command a title', () => {
    expect(Object.values(APP_COMMANDS).filter((command) => command.title.trim() === '')).toEqual([])
  })
})

// FIXME: 下面这个测试就完全没有任何作用，请你删除。下面这个测试代码块本质上测试的是我们的代码定义，并不是测试的行为。这个测试用例对用户来说没有任何帮助，它本质上就是把我们 production 代码当中的东西，使用一种新的写法重新写了一遍而已。请你看看这个 pull request 还有没有类似这种没有任何用处的测试用例，把它们删除。
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
