import { useCallback } from 'react'
import type { AiPrompt, AiPromptMode } from '@reflect/core'
import { useSettings } from '@/providers/settings-provider'

/**
 * The saved-AI-prompts surface (the editor AI menu's user library): CRUD over
 * the `aiPrompts` settings key. Prompts are global across graphs — they are
 * workflow, not note content — and every write goes through
 * `updateSettingsWith` so concurrent edits rebuild from the settings as they
 * are when the update applies, not from this render's snapshot.
 */

/** What the prompt editor collects; `id` is minted on add. */
export interface AiPromptDraft {
  label: string
  body: string
  mode: AiPromptMode
}

interface UseAiPromptsValue {
  prompts: AiPrompt[]
  addPrompt: (draft: AiPromptDraft) => void
  updatePrompt: (id: string, draft: AiPromptDraft) => void
  removePrompt: (id: string) => void
}

export function useAiPrompts(): UseAiPromptsValue {
  const { settings, updateSettingsWith } = useSettings()

  const addPrompt = useCallback(
    (draft: AiPromptDraft): void => {
      const prompt: AiPrompt = { id: crypto.randomUUID(), ...draft }
      updateSettingsWith((current) => ({ aiPrompts: [...current.aiPrompts, prompt] }))
    },
    [updateSettingsWith],
  )

  const updatePrompt = useCallback(
    (id: string, draft: AiPromptDraft): void => {
      updateSettingsWith((current) => ({
        aiPrompts: current.aiPrompts.map((prompt) =>
          prompt.id === id ? { id, ...draft } : prompt,
        ),
      }))
    },
    [updateSettingsWith],
  )

  const removePrompt = useCallback(
    (id: string): void => {
      updateSettingsWith((current) => ({
        aiPrompts: current.aiPrompts.filter((prompt) => prompt.id !== id),
      }))
    },
    [updateSettingsWith],
  )

  return { prompts: settings.aiPrompts, addPrompt, updatePrompt, removePrompt }
}
