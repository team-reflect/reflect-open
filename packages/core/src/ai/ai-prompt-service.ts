import type { IdService } from '../ports/id-service.ts'
import { deriveStore, type Store } from '../store.ts'
import type { Unlisten } from '../unlisten.ts'
import type { AiPrompt, AiPromptMode } from '../settings/schema.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import { isDeepEqual } from '@ocavue/utils'

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
 *
 * As a {@link Store}, its value is the saved prompts, in display order. It
 * notifies only when the list changes, not on other settings changes.
 */
export interface AiPromptService extends Store<AiPrompt[]> {
  add(draft: AiPromptDraft): void
  update(id: string, draft: AiPromptDraft): void
  remove(id: string): void
}

class AiPromptServiceImpl implements AiPromptService {
  readonly #deps: AiPromptServiceDeps
  readonly #store: Store<AiPrompt[]>

  constructor(deps: AiPromptServiceDeps) {
    this.#deps = deps
    this.#store = deriveStore(deps.settings, (settings) => settings.aiPrompts, isDeepEqual)
  }

  readonly get = (): AiPrompt[] => this.#store.get()
  readonly subscribe = (listener: () => void): Unlisten => this.#store.subscribe(listener)

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
