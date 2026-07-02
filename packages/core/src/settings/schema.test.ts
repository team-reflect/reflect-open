import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, settingsSchema } from './schema'

describe('settingsSchema', () => {
  it('defaults every key on an empty document (fresh install)', () => {
    expect(settingsSchema.parse({})).toEqual({
      editorMarkdownSyntax: 'hide',
      editorSpellCheck: true,
      editorDefaultBullet: true,
      editorBulletAfterHeading: true,
      editorTextSize: 'small',
      semanticSearchEnabled: false,
      describeAssets: true,
      contactsEnabled: false,
      mobileOnboarded: false,
      theme: 'system',
      timeFormat: '12h',
      dateFormat: 'mdy',
      weekStartDay: 'monday',
      allNotesFilterTags: ['book', 'link', 'person'],
      calendarEnabled: false,
      calendarIds: [],
      graphColors: {},
      aiProviders: [],
      defaultAiProviderId: null,
      chatModelSelection: null,
      aiPrompts: [],
    })
    expect(DEFAULT_SETTINGS.editorMarkdownSyntax).toBe('hide')
    expect(DEFAULT_SETTINGS.editorSpellCheck).toBe(true)
    expect(DEFAULT_SETTINGS.editorDefaultBullet).toBe(true)
    expect(DEFAULT_SETTINGS.editorBulletAfterHeading).toBe(true)
    expect(DEFAULT_SETTINGS.editorTextSize).toBe('small')
    expect(DEFAULT_SETTINGS.semanticSearchEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.describeAssets).toBe(true)
    expect(DEFAULT_SETTINGS.contactsEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.mobileOnboarded).toBe(false)
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    expect(DEFAULT_SETTINGS.timeFormat).toBe('12h')
    expect(DEFAULT_SETTINGS.dateFormat).toBe('mdy')
    expect(DEFAULT_SETTINGS.weekStartDay).toBe('monday')
    expect(DEFAULT_SETTINGS.allNotesFilterTags).toEqual(['book', 'link', 'person'])
    expect(DEFAULT_SETTINGS.calendarEnabled).toBe(false)
    expect(DEFAULT_SETTINGS.calendarIds).toEqual([])
    expect(DEFAULT_SETTINGS.graphColors).toEqual({})
    expect(DEFAULT_SETTINGS.aiProviders).toEqual([])
    expect(DEFAULT_SETTINGS.defaultAiProviderId).toBeNull()
    expect(DEFAULT_SETTINGS.chatModelSelection).toBeNull()
    expect(DEFAULT_SETTINGS.aiPrompts).toEqual([])
  })

  it('accepts valid values', () => {
    expect(settingsSchema.parse({ editorMarkdownSyntax: 'show' }).editorMarkdownSyntax).toBe('show')
    expect(settingsSchema.parse({ editorMarkdownSyntax: 'hide' }).editorMarkdownSyntax).toBe('hide')
    expect(settingsSchema.parse({ editorMarkdownSyntax: 'hybrid' }).editorMarkdownSyntax).toBe('hybrid')
    expect(settingsSchema.parse({ editorSpellCheck: false }).editorSpellCheck).toBe(false)
    expect(settingsSchema.parse({ editorSpellCheck: true }).editorSpellCheck).toBe(true)
    expect(settingsSchema.parse({ editorDefaultBullet: false }).editorDefaultBullet).toBe(false)
    expect(settingsSchema.parse({ editorDefaultBullet: true }).editorDefaultBullet).toBe(true)
    expect(
      settingsSchema.parse({ editorBulletAfterHeading: false }).editorBulletAfterHeading,
    ).toBe(false)
    expect(
      settingsSchema.parse({ editorBulletAfterHeading: true }).editorBulletAfterHeading,
    ).toBe(true)
    expect(settingsSchema.parse({ editorTextSize: 'small' }).editorTextSize).toBe('small')
    expect(settingsSchema.parse({ editorTextSize: 'medium' }).editorTextSize).toBe('medium')
    expect(settingsSchema.parse({ editorTextSize: 'large' }).editorTextSize).toBe('large')
    expect(settingsSchema.parse({ theme: 'dark' }).theme).toBe('dark')
    expect(settingsSchema.parse({ theme: 'light' }).theme).toBe('light')
    expect(settingsSchema.parse({ theme: 'system' }).theme).toBe('system')
    expect(settingsSchema.parse({ timeFormat: '24h' }).timeFormat).toBe('24h')
    expect(settingsSchema.parse({ timeFormat: '12h' }).timeFormat).toBe('12h')
    expect(settingsSchema.parse({ dateFormat: 'iso' }).dateFormat).toBe('iso')
    expect(settingsSchema.parse({ dateFormat: 'dmy' }).dateFormat).toBe('dmy')
    expect(settingsSchema.parse({ dateFormat: 'mdy' }).dateFormat).toBe('mdy')
    expect(settingsSchema.parse({ weekStartDay: 'monday' }).weekStartDay).toBe('monday')
    expect(settingsSchema.parse({ weekStartDay: 'sunday' }).weekStartDay).toBe('sunday')
    expect(settingsSchema.parse({ semanticSearchEnabled: true }).semanticSearchEnabled).toBe(true)
    expect(settingsSchema.parse({ semanticSearchEnabled: false }).semanticSearchEnabled).toBe(false)
    expect(settingsSchema.parse({ describeAssets: true }).describeAssets).toBe(true)
    expect(settingsSchema.parse({ describeAssets: false }).describeAssets).toBe(false)
    expect(settingsSchema.parse({ contactsEnabled: true }).contactsEnabled).toBe(true)
    expect(settingsSchema.parse({ contactsEnabled: false }).contactsEnabled).toBe(false)
    expect(
      settingsSchema.parse({ allNotesFilterTags: ['meeting'] }).allNotesFilterTags,
    ).toEqual(['meeting'])
    expect(settingsSchema.parse({ allNotesFilterTags: [] }).allNotesFilterTags).toEqual([])
    expect(settingsSchema.parse({ calendarEnabled: true }).calendarEnabled).toBe(true)
    expect(settingsSchema.parse({ calendarEnabled: false }).calendarEnabled).toBe(false)
    expect(settingsSchema.parse({ calendarIds: ['cal-1', 'cal-2'] }).calendarIds).toEqual([
      'cal-1',
      'cal-2',
    ])
    expect(settingsSchema.parse({ calendarIds: [] }).calendarIds).toEqual([])
  })

  it('degrades an invalid value to its default instead of failing the load', () => {
    expect(settingsSchema.parse({ editorMarkdownSyntax: 'sideways' }).editorMarkdownSyntax).toBe('hide')
    expect(settingsSchema.parse({ editorMarkdownSyntax: 42 }).editorMarkdownSyntax).toBe('hide')
    expect(settingsSchema.parse({ editorSpellCheck: 'off' }).editorSpellCheck).toBe(true)
    expect(settingsSchema.parse({ editorSpellCheck: 0 }).editorSpellCheck).toBe(true)
    expect(settingsSchema.parse({ editorDefaultBullet: 'on' }).editorDefaultBullet).toBe(true)
    expect(settingsSchema.parse({ editorDefaultBullet: 0 }).editorDefaultBullet).toBe(true)
    expect(
      settingsSchema.parse({ editorBulletAfterHeading: 'on' }).editorBulletAfterHeading,
    ).toBe(true)
    expect(settingsSchema.parse({ editorBulletAfterHeading: 0 }).editorBulletAfterHeading).toBe(true)
    expect(settingsSchema.parse({ editorTextSize: 'huge' }).editorTextSize).toBe('small')
    expect(settingsSchema.parse({ editorTextSize: 3 }).editorTextSize).toBe('small')
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
    // `.catch(true)` keeps the resilient-degrade pattern: an invalid value falls
    // back to the default rather than failing the whole settings load.
    expect(settingsSchema.parse({ describeAssets: 'yes' }).describeAssets).toBe(true)
    expect(settingsSchema.parse({ describeAssets: 0 }).describeAssets).toBe(true)
    expect(settingsSchema.parse({ contactsEnabled: 'yes' }).contactsEnabled).toBe(false)
    expect(settingsSchema.parse({ contactsEnabled: 1 }).contactsEnabled).toBe(false)
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
    expect(settingsSchema.parse({ calendarEnabled: 'yes' }).calendarEnabled).toBe(false)
    expect(settingsSchema.parse({ calendarEnabled: 1 }).calendarEnabled).toBe(false)
    expect(settingsSchema.parse({ calendarIds: 'cal-1' }).calendarIds).toEqual([])
    expect(settingsSchema.parse({ calendarIds: [7] }).calendarIds).toEqual([])
  })

  it('preserves unknown keys so newer-version settings survive a round trip', () => {
    const parsed = settingsSchema.parse({ editorMarkdownSyntax: 'show', futureKey: true })
    expect(parsed).toEqual({
      editorMarkdownSyntax: 'show',
      editorSpellCheck: true,
      editorDefaultBullet: true,
      editorBulletAfterHeading: true,
      editorTextSize: 'small',
      semanticSearchEnabled: false,
      describeAssets: true,
      contactsEnabled: false,
      mobileOnboarded: false,
      theme: 'system',
      timeFormat: '12h',
      dateFormat: 'mdy',
      weekStartDay: 'monday',
      allNotesFilterTags: ['book', 'link', 'person'],
      calendarEnabled: false,
      calendarIds: [],
      graphColors: {},
      aiProviders: [],
      defaultAiProviderId: null,
      chatModelSelection: null,
      aiPrompts: [],
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

  describe('aiProviders', () => {
    const valid = {
      id: 'abc',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      keyHint: 'wxyz1',
    }

    it('passes valid entries through', () => {
      expect(settingsSchema.parse({ aiProviders: [valid] }).aiProviders).toEqual([valid])
    })

    it('defaults the per-entry display fields', () => {
      const entry = { id: 'abc', provider: 'openai', model: 'gpt-5.1' }
      expect(settingsSchema.parse({ aiProviders: [entry] }).aiProviders).toEqual([
        { ...entry, keyHint: '' },
      ])
    })

    it('drops a corrupt entry without losing the rest', () => {
      const parsed = settingsSchema.parse({
        aiProviders: [valid, { provider: 'aliens' }, 42],
      })
      expect(parsed.aiProviders).toEqual([valid])
    })

    it('degrades a non-array value to the empty list', () => {
      expect(settingsSchema.parse({ aiProviders: 'nope' }).aiProviders).toEqual([])
      expect(settingsSchema.parse({ aiProviders: { id: 'x' } }).aiProviders).toEqual([])
    })
  })

  describe('aiPrompts', () => {
    const valid = {
      id: 'prompt-1',
      label: 'Translate to French',
      body: 'Translate the following text to French.\n\n{{selectedText}}',
      mode: 'replace',
    }

    it('passes valid entries through', () => {
      expect(settingsSchema.parse({ aiPrompts: [valid] }).aiPrompts).toEqual([valid])
    })

    it('defaults an invalid mode to replace', () => {
      const entry = { ...valid, mode: 'sideways' }
      expect(settingsSchema.parse({ aiPrompts: [entry] }).aiPrompts).toEqual([
        { ...valid, mode: 'replace' },
      ])
    })

    it('drops a corrupt entry without losing the rest', () => {
      const parsed = settingsSchema.parse({
        aiPrompts: [valid, { label: 'no body' }, 42],
      })
      expect(parsed.aiPrompts).toEqual([valid])
    })

    it('degrades a non-array value to the empty list', () => {
      expect(settingsSchema.parse({ aiPrompts: 'nope' }).aiPrompts).toEqual([])
    })

    it('defaults to the empty list (built-ins live in code)', () => {
      expect(settingsSchema.parse({}).aiPrompts).toEqual([])
    })
  })

  describe('defaultAiProviderId', () => {
    it('passes a string id through and defaults invalid values to null', () => {
      expect(settingsSchema.parse({ defaultAiProviderId: 'abc' }).defaultAiProviderId).toBe('abc')
      expect(settingsSchema.parse({ defaultAiProviderId: null }).defaultAiProviderId).toBeNull()
      expect(settingsSchema.parse({ defaultAiProviderId: 42 }).defaultAiProviderId).toBeNull()
    })
  })

  describe('chatModelSelection', () => {
    it('passes a valid selection through', () => {
      const selection = { configId: 'abc', modelId: 'claude-opus-4-8' }
      expect(settingsSchema.parse({ chatModelSelection: selection }).chatModelSelection).toEqual(
        selection,
      )
      expect(settingsSchema.parse({ chatModelSelection: null }).chatModelSelection).toBeNull()
    })

    it('degrades an invalid value to null', () => {
      expect(settingsSchema.parse({ chatModelSelection: 'gpt-5.5' }).chatModelSelection).toBeNull()
      expect(
        settingsSchema.parse({ chatModelSelection: { configId: 'abc' } }).chatModelSelection,
      ).toBeNull()
      expect(
        settingsSchema.parse({ chatModelSelection: { configId: '', modelId: 'gpt-5.5' } })
          .chatModelSelection,
      ).toBeNull()
    })
  })
})
