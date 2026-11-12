import type { AiPrompt, AiPromptDraft } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useStore } from '@/lib/use-store.ts'

interface UseAiPromptsValue {
  prompts: AiPrompt[]
  addPrompt: (draft: AiPromptDraft) => void
  updatePrompt: (id: string, draft: AiPromptDraft) => void
  removePrompt: (id: string) => void
}

/**
 * The saved-AI-prompts surface (the editor AI menu's user library), over the `AiPromptService`.
 */
export function useAiPrompts(): UseAiPromptsValue {
  const { aiPrompts: service } = useCoreServices()
  const prompts = useStore(service)
  return {
    prompts,
    addPrompt: (draft) => service.add(draft),
    updatePrompt: (id, draft) => service.update(id, draft),
    removePrompt: (id) => service.remove(id),
  }
}
