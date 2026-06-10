import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, settingsSchema } from './schema'

describe('settingsSchema', () => {
  it('defaults every key on an empty document (fresh install)', () => {
    expect(settingsSchema.parse({})).toEqual({
      editorMarkdownSyntax: 'focus',
      semanticSearchEnabled: false,
      theme: 'system',
      allNotesFilterTags: ['book', 'link', 'person'],
      aiModels: [],
      defaultAiModelId: null,
    })
    expect(DEFAULT_SETTINGS.editorMarkdownSyntax).toBe('focus')
    expect(DEFAULT_SETTINGS.semanticSearchEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(DEFAULT_SETTINGS.allNotesFilterTags).toEqual(['book', 'link', 'person'])
    expect(DEFAULT_SETTINGS.aiModels).toEqual([])
    expect(DEFAULT_SETTINGS.defaultAiModelId).toBeNull()
  })

  it('accepts valid values', () => {
    expect(settingsSchema.parse({ editorMarkdownSyntax: 'show' }).editorMarkdownSyntax).toBe('show')
    expect(settingsSchema.parse({ editorMarkdownSyntax: 'focus' }).editorMarkdownSyntax).toBe('focus')
    expect(settingsSchema.parse({ theme: 'dark' }).theme).toBe('dark')
    expect(settingsSchema.parse({ theme: 'light' }).theme).toBe('light')
    expect(settingsSchema.parse({ theme: 'system' }).theme).toBe('system')
    expect(settingsSchema.parse({ semanticSearchEnabled: true }).semanticSearchEnabled).toBe(true)
    expect(settingsSchema.parse({ semanticSearchEnabled: false }).semanticSearchEnabled).toBe(false)
    expect(
      settingsSchema.parse({ allNotesFilterTags: ['meeting'] }).allNotesFilterTags,
    ).toEqual(['meeting'])
    expect(settingsSchema.parse({ allNotesFilterTags: [] }).allNotesFilterTags).toEqual([])
  })

  it('degrades an invalid value to its default instead of failing the load', () => {
    expect(settingsSchema.parse({ editorMarkdownSyntax: 'sideways' }).editorMarkdownSyntax).toBe('focus')
    expect(settingsSchema.parse({ editorMarkdownSyntax: 42 }).editorMarkdownSyntax).toBe('focus')
    expect(settingsSchema.parse({ theme: 'sepia' }).theme).toBe('system')
    expect(settingsSchema.parse({ theme: 7 }).theme).toBe('system')
    expect(settingsSchema.parse({ semanticSearchEnabled: 'yes' }).semanticSearchEnabled).toBe(false)
    expect(settingsSchema.parse({ semanticSearchEnabled: 1 }).semanticSearchEnabled).toBe(false)
    expect(settingsSchema.parse({ allNotesFilterTags: 'book' }).allNotesFilterTags).toEqual([
      'book',
      'link',
      'person',
    ])
    expect(settingsSchema.parse({ allNotesFilterTags: [7] }).allNotesFilterTags).toEqual([
      'book',
      'link',
      'person',
    ])
  })

  it('preserves unknown keys so newer-version settings survive a round trip', () => {
    const parsed = settingsSchema.parse({ editorMarkdownSyntax: 'show', futureKey: true })
    expect(parsed).toEqual({
      editorMarkdownSyntax: 'show',
      semanticSearchEnabled: false,
      theme: 'system',
      allNotesFilterTags: ['book', 'link', 'person'],
      aiModels: [],
      defaultAiModelId: null,
      futureKey: true,
    })
  })

  describe('aiModels', () => {
    const valid = {
      id: 'abc',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      keyHint: 'wxyz1',
    }

    it('passes valid entries through', () => {
      expect(settingsSchema.parse({ aiModels: [valid] }).aiModels).toEqual([valid])
    })

    it('defaults the per-entry display fields', () => {
      const entry = { id: 'abc', provider: 'openai', model: 'gpt-5.1' }
      expect(settingsSchema.parse({ aiModels: [entry] }).aiModels).toEqual([
        { ...entry, keyHint: '' },
      ])
    })

    it('drops a corrupt entry without losing the rest', () => {
      const parsed = settingsSchema.parse({
        aiModels: [valid, { provider: 'aliens' }, 42],
      })
      expect(parsed.aiModels).toEqual([valid])
    })

    it('degrades a non-array value to the empty list', () => {
      expect(settingsSchema.parse({ aiModels: 'nope' }).aiModels).toEqual([])
      expect(settingsSchema.parse({ aiModels: { id: 'x' } }).aiModels).toEqual([])
    })
  })

  describe('defaultAiModelId', () => {
    it('passes a string id through and defaults invalid values to null', () => {
      expect(settingsSchema.parse({ defaultAiModelId: 'abc' }).defaultAiModelId).toBe('abc')
      expect(settingsSchema.parse({ defaultAiModelId: null }).defaultAiModelId).toBeNull()
      expect(settingsSchema.parse({ defaultAiModelId: 42 }).defaultAiModelId).toBeNull()
    })
  })
})
