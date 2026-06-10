import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, settingsSchema } from './schema'

describe('settingsSchema', () => {
  it('defaults every key on an empty document (fresh install)', () => {
    expect(settingsSchema.parse({})).toEqual({ editorMarkMode: 'focus' })
    expect(DEFAULT_SETTINGS.editorMarkMode).toBe('focus')
  })

  it('accepts valid values', () => {
    expect(settingsSchema.parse({ editorMarkMode: 'show' }).editorMarkMode).toBe('show')
    expect(settingsSchema.parse({ editorMarkMode: 'focus' }).editorMarkMode).toBe('focus')
  })

  it('degrades an invalid value to its default instead of failing the load', () => {
    expect(settingsSchema.parse({ editorMarkMode: 'sideways' }).editorMarkMode).toBe('focus')
    expect(settingsSchema.parse({ editorMarkMode: 42 }).editorMarkMode).toBe('focus')
  })

  it('preserves unknown keys so newer-version settings survive a round trip', () => {
    const parsed = settingsSchema.parse({ editorMarkMode: 'show', futureKey: true })
    expect(parsed).toEqual({ editorMarkMode: 'show', futureKey: true })
  })
})
