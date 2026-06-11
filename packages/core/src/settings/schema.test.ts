import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, settingsSchema } from './schema'

describe('settingsSchema', () => {
  it('defaults every key on an empty document (fresh install)', () => {
    expect(settingsSchema.parse({})).toEqual({
      editorMarkdownSyntax: 'focus',
      editorSpellCheck: true,
      semanticSearchEnabled: false,
      theme: 'system',
      timeFormat: '12h',
      dateFormat: 'mdy',
      weekStartDay: 'monday',
      allNotesFilterTags: ['book', 'link', 'person'],
      graphColors: {},
      aiModels: [],
      defaultAiModelId: null,
    })
    expect(DEFAULT_SETTINGS.editorMarkdownSyntax).toBe('focus')
    expect(DEFAULT_SETTINGS.editorSpellCheck).toBe(true)
    expect(DEFAULT_SETTINGS.semanticSearchEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(DEFAULT_SETTINGS.timeFormat).toBe('12h')
    expect(DEFAULT_SETTINGS.dateFormat).toBe('mdy')
    expect(DEFAULT_SETTINGS.weekStartDay).toBe('monday')
    expect(DEFAULT_SETTINGS.allNotesFilterTags).toEqual(['book', 'link', 'person'])
    expect(DEFAULT_SETTINGS.graphColors).toEqual({})
    expect(DEFAULT_SETTINGS.aiModels).toEqual([])
    expect(DEFAULT_SETTINGS.defaultAiModelId).toBeNull()
  })

  it('accepts valid values', () => {
    expect(settingsSchema.parse({ editorMarkdownSyntax: 'show' }).editorMarkdownSyntax).toBe('show')
    expect(settingsSchema.parse({ editorMarkdownSyntax: 'focus' }).editorMarkdownSyntax).toBe('focus')
    expect(settingsSchema.parse({ editorSpellCheck: false }).editorSpellCheck).toBe(false)
    expect(settingsSchema.parse({ editorSpellCheck: true }).editorSpellCheck).toBe(true)
    expect(settingsSchema.parse({ theme: 'dark' }).theme).toBe('dark')
    expect(settingsSchema.parse({ theme: 'light' }).theme).toBe('light')
    expect(settingsSchema.parse({ theme: 'system' }).theme).toBe('system')
    expect(settingsSchema.parse({ timeFormat: '24h' }).timeFormat).toBe('24h')
    expect(settingsSchema.parse({ timeFormat: '12h' }).timeFormat).toBe('12h')
    expect(settingsSchema.parse({ dateFormat: 'dmy' }).dateFormat).toBe('dmy')
    expect(settingsSchema.parse({ dateFormat: 'mdy' }).dateFormat).toBe('mdy')
    expect(settingsSchema.parse({ weekStartDay: 'monday' }).weekStartDay).toBe('monday')
    expect(settingsSchema.parse({ weekStartDay: 'sunday' }).weekStartDay).toBe('sunday')
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
    expect(settingsSchema.parse({ editorSpellCheck: 'off' }).editorSpellCheck).toBe(true)
    expect(settingsSchema.parse({ editorSpellCheck: 0 }).editorSpellCheck).toBe(true)
    expect(settingsSchema.parse({ theme: 'sepia' }).theme).toBe('system')
    expect(settingsSchema.parse({ theme: 7 }).theme).toBe('system')
    expect(settingsSchema.parse({ timeFormat: '36h' }).timeFormat).toBe('12h')
    expect(settingsSchema.parse({ timeFormat: 24 }).timeFormat).toBe('12h')
    expect(settingsSchema.parse({ dateFormat: 'ymd' }).dateFormat).toBe('mdy')
    expect(settingsSchema.parse({ dateFormat: 10 }).dateFormat).toBe('mdy')
    expect(settingsSchema.parse({ weekStartDay: 'saturday' }).weekStartDay).toBe('monday')
    expect(settingsSchema.parse({ weekStartDay: 42 }).weekStartDay).toBe('monday')
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
      editorSpellCheck: true,
      semanticSearchEnabled: false,
      theme: 'system',
      timeFormat: '12h',
      dateFormat: 'mdy',
      weekStartDay: 'monday',
      allNotesFilterTags: ['book', 'link', 'person'],
      graphColors: {},
      aiModels: [],
      defaultAiModelId: null,
      futureKey: true,
    })
  })

  describe('graphColors', () => {
    it('passes valid entries through', () => {
      const colors = { '/graphs/work': 'teal', '/graphs/home': 'amber' }
      expect(settingsSchema.parse({ graphColors: colors }).graphColors).toEqual(colors)
    })

    it('drops a corrupt entry without losing the rest', () => {
      const parsed = settingsSchema.parse({
        graphColors: { '/graphs/work': 'teal', '/graphs/home': 'chartreuse', '/graphs/x': 42 },
      })
      expect(parsed.graphColors).toEqual({ '/graphs/work': 'teal' })
    })

    it('degrades a non-object value to the empty record', () => {
      expect(settingsSchema.parse({ graphColors: 'teal' }).graphColors).toEqual({})
      expect(settingsSchema.parse({ graphColors: ['teal'] }).graphColors).toEqual({})
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
