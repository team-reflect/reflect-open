import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { noop } from '@ocavue/utils'
import { describe, expect, it, vi } from 'vitest'
import {
  createAttachQueue,
  runNativeIntent,
  type IntentContext,
} from '@/mobile/chrome/native/native-chrome-intents.ts'
import type { FormattingToolbarCommands } from '@/editor/formatting-toolbar-store.ts'
import { FORMATTING_COMMANDS, parseNativeIntent } from '@/mobile/chrome/native/protocol.ts'

function makeIntentContext(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    entryId: 5,
    selectTab: vi.fn(),
    screen: { back: vi.fn(), onAction: vi.fn() },
    attachCommands: null,
    attachFiles: createAttachQueue(),
    toasts: { add: vi.fn(), close: vi.fn() },
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

  it('names the formatting commands of the Swift shell', () => {
    // `ChromeKitTests` checks that `FormattingCommand` has exactly these.
    const path = join(
      import.meta.dirname,
      '../../../../../../apple/Tests/ChromeKitTests/Fixtures/commands.json',
    )
    if (process.env.UPDATE_CHROME_FIXTURES === '1') {
      writeFileSync(path, `${JSON.stringify(FORMATTING_COMMANDS)}\n`)
    }
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(FORMATTING_COMMANDS)
    expect(parseNativeIntent({ type: 'command', id: 'bold' })).toBeNull()
  })

  it('reads every intent the Swift shell encodes', () => {
    // `ChromeKitTests` checks that Swift encodes exactly this file.
    const path = join(
      import.meta.dirname,
      '../../../../../../apple/Tests/ChromeKitTests/Fixtures/intents.json',
    )
    const intents = JSON.parse(readFileSync(path, 'utf8')) as unknown[]
    expect(intents).toHaveLength(5)
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

  it('selects a tab', () => {
    const ctx = makeIntentContext()
    runNativeIntent({ type: 'tab', tab: 'tasks' }, ctx)
    expect(ctx.selectTab).toHaveBeenCalledWith('tasks')
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
