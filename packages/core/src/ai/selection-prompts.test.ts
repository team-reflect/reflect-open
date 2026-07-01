import { describe, expect, it } from 'vitest'
import type { AiPrompt } from '../settings/schema'
import { BUILT_IN_AI_PROMPTS, filterAiPrompts, renderSelectionPrompt } from './selection-prompts'

describe('renderSelectionPrompt', () => {
  it('substitutes the {{selectedText}} placeholder', () => {
    expect(renderSelectionPrompt('Fix this:\n\n{{selectedText}}', 'teh text')).toBe(
      'Fix this:\n\nteh text',
    )
  })

  it('substitutes every occurrence and tolerates inner spacing', () => {
    expect(renderSelectionPrompt('{{selectedText}} and {{ selectedText }}', 'x')).toBe('x and x')
  })

  it('appends the selection when the body has no placeholder', () => {
    expect(renderSelectionPrompt('Translate to French', 'hello')).toBe(
      'Translate to French\n\nhello',
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

  it('lists built-ins first, then saved prompts, for an empty query', () => {
    const prompts = filterAiPrompts(saved, '')
    expect(prompts.slice(0, BUILT_IN_AI_PROMPTS.length)).toEqual(BUILT_IN_AI_PROMPTS)
    expect(prompts.at(-1)?.id).toBe('saved-1')
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
