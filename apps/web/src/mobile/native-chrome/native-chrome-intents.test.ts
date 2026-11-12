import { describe, expect, it, vi } from 'vitest'
import {
  runNativeIntent,
  type IntentContext,
} from '@/mobile/native-chrome/native-chrome-projection.tsx'
import { parseNativeIntent } from '@/mobile/native-chrome/protocol.ts'
import { nativeMenuHandler, rememberNativeMenu } from '@/mobile/native-chrome/registrations.ts'

function createContext(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    entryId: 5,
    canBack: true,
    back: vi.fn(),
    navigate: vi.fn(),
    selectTab: vi.fn(),
    attachCommands: null,
    ...overrides,
  }
}

describe('parseNativeIntent', () => {
  it('reads every intent and refuses anything else', () => {
    expect(parseNativeIntent({ type: 'tab', tab: 'all' })).toEqual({ type: 'tab', tab: 'all' })
    expect(parseNativeIntent({ type: 'back', entryId: 1 })).toEqual({ type: 'back', entryId: 1 })
    expect(parseNativeIntent({ type: 'tab', tab: 'chat' })).toBeNull()
    expect(parseNativeIntent('back')).toBeNull()
  })
})

describe('runNativeIntent', () => {
  it('goes back for the entry on screen', () => {
    const context = createContext()
    runNativeIntent({ type: 'back', entryId: 5 }, context)
    expect(context.back).toHaveBeenCalledOnce()
  })

  it('drops a back for another entry', () => {
    const context = createContext()
    runNativeIntent({ type: 'back', entryId: 4 }, context)
    expect(context.back).not.toHaveBeenCalled()
  })

  it('opens today when there is no history to go back to', () => {
    const context = createContext({ canBack: false })
    runNativeIntent({ type: 'back', entryId: 5 }, context)
    expect(context.navigate).toHaveBeenCalledWith({ kind: 'today' })
  })

  it('selects a tab', () => {
    const context = createContext()
    runNativeIntent({ type: 'tab', tab: 'tasks' }, context)
    expect(context.selectTab).toHaveBeenCalledWith('tasks')
  })

  it('runs a menu item only for the entry that opened the menu', () => {
    const onSelect = vi.fn()
    rememberNativeMenu('filters', { entryId: 5, onSelect })
    runNativeIntent({ type: 'menu', entryId: 6, menuId: 'filters', id: 'a' }, createContext())
    expect(onSelect).not.toHaveBeenCalled()
    runNativeIntent({ type: 'menu', entryId: 5, menuId: 'filters', id: 'a' }, createContext())
    expect(onSelect).toHaveBeenCalledWith('a')
    expect(nativeMenuHandler('filters', 4)).toBeNull()
  })
})
