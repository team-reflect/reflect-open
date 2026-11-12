import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { noop } from '@ocavue/utils'
import { describe, expect, it, vi } from 'vitest'
import {
  runNativeIntent,
  type IntentContext,
} from '@/mobile/native-chrome/native-chrome-projection.tsx'
import type { FormattingToolbarCommands } from '@/editor/formatting-toolbar-store.ts'
import { FORMATTING_COMMANDS, parseNativeIntent } from '@/mobile/native-chrome/protocol.ts'

function makeIntentContext(overrides: Partial<IntentContext> = {}): IntentContext {
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

  it('names the formatting commands of the Swift shell', () => {
    // `ChromeKitTests` checks that `FormattingCommand` has exactly these.
    const path = join(
      import.meta.dirname,
      '../../../../../apple/Tests/ChromeKitTests/Fixtures/commands.json',
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
      '../../../../../apple/Tests/ChromeKitTests/Fixtures/intents.json',
    )
    const intents = JSON.parse(readFileSync(path, 'utf8')) as unknown[]
    expect(intents).toHaveLength(5)
    for (const intent of intents) {
      expect(parseNativeIntent(intent)).toEqual(intent)
    }
  })
})

describe('runNativeIntent', () => {
  it('goes back for the entry on screen', () => {
    const ctx = makeIntentContext()
    runNativeIntent({ type: 'back', entryId: 5 }, ctx)
    expect(ctx.back).toHaveBeenCalledOnce()
  })

  it('drops a back for another entry', () => {
    const ctx = makeIntentContext()
    runNativeIntent({ type: 'back', entryId: 4 }, ctx)
    expect(ctx.back).not.toHaveBeenCalled()
  })

  it('opens today when there is no history to go back to', () => {
    const ctx = makeIntentContext({ canBack: false })
    runNativeIntent({ type: 'back', entryId: 5 }, ctx)
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: 'today' })
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
