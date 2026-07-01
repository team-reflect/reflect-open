import type { AiPrompt } from '../settings/schema'

/**
 * The editor AI menu's prompt library: a small curated built-in set (the
 * most-used transformations from old Reflect) followed by the user's saved
 * prompts (`settings.aiPrompts`). A prompt body references the selection with
 * the `{{selectedText}}` placeholder — old Reflect's syntax, so saved v1
 * prompts port over verbatim.
 */

/** The `{{selectedText}}` placeholder, matched with flexible inner spacing. */
const SELECTED_TEXT_PLACEHOLDER = /\{\{\s*selectedText\s*\}\}/g

/**
 * The curated built-in prompts, shown before the user's saved prompts.
 * Transformations of the selection use `replace`; prompts that produce new
 * text (a summary, action items, a continuation) use `append` so accepting
 * never destroys the source.
 */
export const BUILT_IN_AI_PROMPTS: readonly AiPrompt[] = [
  {
    id: 'built-in:fix-grammar',
    label: 'Fix spelling and grammar',
    body: 'Fix the spelling and grammar of the following text. Keep the original meaning, tone, and Markdown formatting; change nothing that is already correct.\n\n{{selectedText}}',
    mode: 'replace',
  },
  {
    id: 'built-in:rephrase',
    label: 'Rephrase',
    body: 'Rephrase the following text. Keep the meaning and Markdown formatting, but improve the flow and word choice.\n\n{{selectedText}}',
    mode: 'replace',
  },
  {
    id: 'built-in:simplify',
    label: 'Simplify',
    body: 'Rewrite the following text so it is simpler and easier to read. Prefer short sentences and plain words; keep the Markdown formatting.\n\n{{selectedText}}',
    mode: 'replace',
  },
  {
    id: 'built-in:summarize',
    label: 'Write a short summary',
    body: 'Write a short summary of the following text — a few sentences at most.\n\n{{selectedText}}',
    mode: 'append',
  },
  {
    id: 'built-in:action-items',
    label: 'List action items',
    body: 'List the action items from the following text as a Markdown task list (`- [ ]` items). Only include actions actually implied by the text.\n\n{{selectedText}}',
    mode: 'append',
  },
  {
    id: 'built-in:continue',
    label: 'Continue writing',
    body: 'Continue writing from where the following text leaves off, matching its tone, style, and Markdown formatting. Return only the continuation.\n\n{{selectedText}}',
    mode: 'append',
  },
]

/**
 * Render a prompt body against the selection: every `{{selectedText}}`
 * occurrence is substituted, and a body without the placeholder gets the
 * selection appended after a blank line (so a bare instruction like
 * "Translate to French" still works).
 */
export function renderSelectionPrompt(body: string, selectedText: string): string {
  if (SELECTED_TEXT_PLACEHOLDER.test(body)) {
    SELECTED_TEXT_PLACEHOLDER.lastIndex = 0
    return body.replaceAll(SELECTED_TEXT_PLACEHOLDER, selectedText)
  }
  return `${body}\n\n${selectedText}`
}

/**
 * The prompts the AI menu lists for a filter query: built-ins first, then the
 * user's saved prompts, case-insensitively filtered on the label. An empty
 * query returns everything. The menu does not re-rank — order here is display
 * order.
 */
export function filterAiPrompts(prompts: readonly AiPrompt[], query: string): AiPrompt[] {
  const all = [...BUILT_IN_AI_PROMPTS, ...prompts]
  const needle = query.trim().toLowerCase()
  if (!needle) return all
  return all.filter((prompt) => prompt.label.toLowerCase().includes(needle))
}
