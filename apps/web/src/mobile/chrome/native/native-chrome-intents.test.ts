import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { noop } from '@ocavue/utils'
import { describe, expect, it, vi } from 'vitest'
import {
  createAttachQueue,
  runNativeIntent,
  type IntentContext,
} from '@/mobile/chrome/native/native-chrome-intents.ts'
import type { FormattingToolbarCommands } from '@/editor/formatting-toolbar-store.ts'
import { parseNativeIntent } from '@/mobile/chrome/native/protocol.ts'

function makeIntentContext(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    entryId: 5,
    selectTab: vi.fn(),
    screen: { back: vi.fn(), onAction: vi.fn() },
    attachCommands: null,
    attachFiles: createAttachQueue(),
    toasts: { add: vi.fn(), close: vi.fn() },
    setCornersInHeaderRow: vi.fn(),
    setWindowControlsWidth: vi.fn(),
    setSidebarVisible: vi.fn(),
    runSidebar: vi.fn(),
    moveHistory: vi.fn(),
    ...overrides,
  }
}

describe('parseNativeIntent', () => {
  it('reads every intent and refuses anything else', () => {
    expect(parseNativeIntent({ type: 'tab', tab: 'all' })).toEqual({ type: 'tab', tab: 'all' })
    expect(parseNativeIntent({ type: 'back', entryId: 1 })).toEqual({ type: 'back', entryId: 1 })
    expect(parseNativeIntent({ type: 'tab', tab: 'chat' })).toBeNull()
    expect(parseNativeIntent({ type: 'command', id: 'bold' })).toBeNull()
    expect(parseNativeIntent('back')).toBeNull()
  })

  it('reads every intent the Swift shell encodes', () => {
    // `ChromeKitTests` checks that Swift encodes exactly this file.
    const path = join(
      import.meta.dirname,
      '../../../../../../apple/Tests/ChromeKitTests/Fixtures/intents.json',
    )
    const intents = JSON.parse(readFileSync(path, 'utf8')) as unknown[]
    expect(intents).toHaveLength(19)
    for (const intent of intents) {
      expect(parseNativeIntent(intent)).toEqual(intent)
    }
  })
})

describe('runNativeIntent', () => {
  it('goes back and runs actions for the entry on screen only', () => {
    const ctx = makeIntentContext()
    runNativeIntent({ type: 'back', entryId: 4 }, ctx)
    runNativeIntent({ type: 'action', entryId: 4, id: 'more' }, ctx)
    expect(ctx.screen?.back).not.toHaveBeenCalled()
    expect(ctx.screen?.onAction).not.toHaveBeenCalled()
    runNativeIntent({ type: 'back', entryId: 5 }, ctx)
    runNativeIntent({ type: 'action', entryId: 5, id: 'more' }, ctx)
    expect(ctx.screen?.back).toHaveBeenCalledOnce()
    expect(ctx.screen?.onAction).toHaveBeenCalledWith('more')
  })

  it('moves the history only from the screen on screen', () => {
    const ctx = makeIntentContext()
    runNativeIntent({ type: 'history', entryId: 4, direction: 'back' }, ctx)
    runNativeIntent({ type: 'history', entryId: 5, direction: 'forward' }, ctx)
    expect(ctx.moveHistory).toHaveBeenCalledExactlyOnceWith('forward')
  })

  it('passes the sidebar visibility and taps to the page', () => {
    const ctx = makeIntentContext()
    runNativeIntent({ type: 'sidebarVisible', visible: true }, ctx)
    runNativeIntent({ type: 'sidebar', command: { kind: 'unpin', path: 'a.md' } }, ctx)
    expect(ctx.setSidebarVisible).toHaveBeenCalledWith(true)
    expect(ctx.runSidebar).toHaveBeenCalledWith({ kind: 'unpin', path: 'a.md' })
  })

  it('runs the capture item or the action of the `+` on screen', () => {
    const plus = {
      kind: 'capture' as const,
      audio: null,
      onNote: vi.fn(),
      onTask: vi.fn(),
      onAudio: vi.fn(),
    }
    const ctx = makeIntentContext({ screen: { plus } })
    runNativeIntent({ type: 'plus', entryId: 4, command: 'note' }, ctx)
    expect(plus.onNote).not.toHaveBeenCalled()
    runNativeIntent({ type: 'plus', entryId: 5, command: 'note' }, ctx)
    runNativeIntent({ type: 'plus', entryId: 5, command: 'task' }, ctx)
    runNativeIntent({ type: 'plus', entryId: 5, command: 'audio' }, ctx)
    expect(plus.onNote).toHaveBeenCalledOnce()
    expect(plus.onTask).toHaveBeenCalledOnce()
    expect(plus.onAudio).toHaveBeenCalledOnce()

    const onTap = vi.fn()
    runNativeIntent(
      { type: 'plus', entryId: 5, command: 'tap' },
      makeIntentContext({ screen: { plus: { kind: 'action', label: 'New note', onTap } } }),
    )
    expect(onTap).toHaveBeenCalledOnce()
  })

  it('inserts the images of one pick in the picked order', async () => {
    const order: string[] = []
    let finishFirst: () => void = noop
    const attachFiles = vi.fn(async (files: File[]) => {
      const name = files[0]?.name ?? ''
      if (name === 'big.jpg') {
        await new Promise<void>((resolve) => {
          finishFirst = resolve
        })
      }
      order.push(name)
    })
    const ctx = makeIntentContext({
      attachCommands: { attachFiles } as unknown as FormattingToolbarCommands,
    })
    const file = (name: string) => ({ name, type: 'image/jpeg', data: 'AQID' })
    runNativeIntent({ type: 'files', files: [file('big.jpg')] }, ctx)
    runNativeIntent({ type: 'files', files: [file('small.jpg')] }, ctx)
    await vi.waitFor(() => expect(attachFiles).toHaveBeenCalledTimes(1))
    finishFirst()
    await vi.waitFor(() => expect(order).toEqual(['big.jpg', 'small.jpg']))
  })
})
