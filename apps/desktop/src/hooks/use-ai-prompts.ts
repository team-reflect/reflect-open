import type { AiPrompt, AiPromptDraft } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

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
  const prompts = useServiceState(service, service.list)
  return {
    prompts,
    addPrompt: (draft) => service.add(draft),
    updatePrompt: (id, draft) => service.update(id, draft),
    removePrompt: (id) => service.remove(id),
  }
}
