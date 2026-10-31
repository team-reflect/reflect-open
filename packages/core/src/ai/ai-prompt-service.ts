import type { IdService } from '../ports/id-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { AiPrompt, AiPromptMode } from '../settings/schema.ts'
import type { SettingsService } from '../settings/settings-service.ts'

/**
 * What the prompt editor collects; `id` is minted on add.
 */
export interface AiPromptDraft {
  label: string
  body: string
  mode: AiPromptMode
}

export interface AiPromptServiceDeps {
  readonly settings: SettingsService
  readonly id: IdService
}

/**
 * The saved AI prompts (the editor AI menu's user library): CRUD over the
 * `aiPrompts` settings key. Prompts are global across graphs (they are
 * workflow, not note content), and every write rebuilds from the settings as
 * they are when the update applies, so concurrent edits do not overwrite
 * each other.
 */
export interface AiPromptService {
  /**
   * The saved prompts, in display order. Stable until the list changes.
   */
  list: () => AiPrompt[]
  /**
   * Calls `listener` after any settings change.
   */
  subscribe: (listener: () => void) => Unlisten
  add(draft: AiPromptDraft): void
  update(id: string, draft: AiPromptDraft): void
  remove(id: string): void
}

class AiPromptServiceImpl implements AiPromptService {
  readonly #deps: AiPromptServiceDeps

  constructor(deps: AiPromptServiceDeps) {
    this.#deps = deps
  }

  readonly list = (): AiPrompt[] => this.#deps.settings.get().aiPrompts

  readonly subscribe = (listener: () => void): Unlisten => this.#deps.settings.subscribe(listener)

  add(draft: AiPromptDraft): void {
    const { settings, id: idService } = this.#deps
    const prompt: AiPrompt = { id: idService.uuid(), ...draft }
    settings.updateWith((current) => ({ aiPrompts: [...current.aiPrompts, prompt] }))
  }

  update(id: string, draft: AiPromptDraft): void {
    this.#deps.settings.updateWith((current) => ({
      aiPrompts: current.aiPrompts.map((prompt) => (prompt.id === id ? { id, ...draft } : prompt)),
    }))
  }

  remove(id: string): void {
    this.#deps.settings.updateWith((current) => ({
      aiPrompts: current.aiPrompts.filter((prompt) => prompt.id !== id),
    }))
  }
}

export function createAiPromptService(deps: AiPromptServiceDeps): AiPromptService {
  return new AiPromptServiceImpl(deps)
}
