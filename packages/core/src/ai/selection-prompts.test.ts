import { describe, expect, it } from 'vitest'
import type { AiPrompt } from '../settings/schema.ts'
import { BUILT_IN_AI_PROMPTS, filterAiPrompts, renderSelectionPrompt } from './selection-prompts.ts'

describe('renderSelectionPrompt', () => {
  it('substitutes the {{selectedText}} placeholder', () => {
    expect(renderSelectionPrompt('Fix this:\n\n{{selectedText}}', 'teh text')).toBe(
      'Fix this:\n\nteh text',
    )
  })

  it('substitutes every occurrence and tolerates inner spacing', () => {
    expect(renderSelectionPrompt('{{selectedText}} and {{ selectedText }}', 'x')).toBe('x and x')
  })

  it('appends the selection as fenced context when the body has no placeholder', () => {
    expect(renderSelectionPrompt('Translate to French', 'hello')).toBe(
      'Translate to French\n\nUse the following text in triple quotes as context for your response:\n"""\nhello\n"""',
    )
  })

  it('keeps dollar sequences in the selection verbatim', () => {
    expect(renderSelectionPrompt('Fix: {{selectedText}}', 'costs $$40 and $& more')).toBe(
      'Fix: costs $$40 and $& more',
    )
  })

  it('is stateful-regex safe: consecutive calls behave identically', () => {
    const body = 'Fix: {{selectedText}}'
    expect(renderSelectionPrompt(body, 'a')).toBe('Fix: a')
    expect(renderSelectionPrompt(body, 'b')).toBe('Fix: b')
  })
})

describe('filterAiPrompts', () => {
  const saved: AiPrompt[] = [
    { id: 'saved-1', label: 'Translate to French', body: '{{selectedText}}', mode: 'replace' },
  ]

  it('lists saved prompts first, then built-ins, for an empty query (v1 order)', () => {
    const prompts = filterAiPrompts(saved, '')
    expect(prompts[0]?.id).toBe('saved-1')
    expect(prompts.slice(1)).toEqual(BUILT_IN_AI_PROMPTS)
  })

  it('filters case-insensitively on the label', () => {
    const prompts = filterAiPrompts(saved, 'french')
    expect(prompts.map((prompt) => prompt.id)).toEqual(['saved-1'])
    expect(filterAiPrompts(saved, 'GRAMMAR').map((prompt) => prompt.id)).toEqual([
      'built-in:fix-grammar',
    ])
  })

  it('every built-in prompt references the selection via the placeholder', () => {
    for (const prompt of BUILT_IN_AI_PROMPTS) {
      expect(prompt.body).toContain('{{selectedText}}')
    }
  })
})
