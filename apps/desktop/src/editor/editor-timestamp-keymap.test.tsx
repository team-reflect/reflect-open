import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TIMESTAMP_BINDING } from '@/editor/keymap'
import { EditorTimestampKeymap } from './editor-timestamp-keymap'

type TimestampHandler = () => boolean

const harness = vi.hoisted(() => ({
  handler: null as TimestampHandler | null,
  insertText: vi.fn(() => true),
}))

vi.mock('@meowdown/react', () => ({
  useEditor: () => ({ commands: { insertText: harness.insertText } }),
  useKeymap: (keymap: Record<string, TimestampHandler>) => {
    harness.handler = keymap[TIMESTAMP_BINDING] ?? null
  },
}))

function pressTimestampShortcut(): boolean {
  if (harness.handler === null) {
    throw new Error('Timestamp keymap was not mounted')
  }
  return harness.handler()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 6, 15, 11, 34))
  harness.handler = null
  harness.insertText.mockClear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('EditorTimestampKeymap', () => {
  it('inserts the current time with a trailing space in 12-hour format', () => {
    render(<EditorTimestampKeymap timeFormat="12h" />)

    expect(pressTimestampShortcut()).toBe(true)
    expect(harness.insertText).toHaveBeenCalledWith({ text: '11:34am ' })
  })

  it('honors the 24-hour time preference', () => {
    render(<EditorTimestampKeymap timeFormat="24h" />)

    expect(pressTimestampShortcut()).toBe(true)
    expect(harness.insertText).toHaveBeenCalledWith({ text: '11:34 ' })
  })
})
