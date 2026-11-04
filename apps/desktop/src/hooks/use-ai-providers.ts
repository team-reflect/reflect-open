import {
  defaultAiProvider,
  type AiProviderConfig,
  type AiProvidersState,
  type NewAiProvider,
} from '@reflect/core'
import { useSelector } from '@/lib/use-store.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

interface UseAiProvidersValue {
  providers: AiProviderConfig[]
  /**
   * The entry AI features use by default (null only when the list is empty).
   */
  defaultProvider: AiProviderConfig | null
  /**
   * Store the key in the keychain, then add the settings entry. Rejects (and
   * adds nothing) if the keychain write fails — so an entry can never point
   * at a key that was never stored — or if the settings store could not be
   * read this session, so a key can never be stored for an entry that won't
   * survive a restart.
   */
  addProvider: (draft: NewAiProvider) => Promise<void>
  /**
   * Delete the key from the keychain, then drop the settings entry.
   */
  removeProvider: (id: string) => Promise<void>
  /**
   * Make the entry with `id` the app-wide default.
   */
  makeDefault: (id: string) => void
  /**
   * Change the default model used by the configured provider entry.
   */
  setDefaultModel: (id: string, model: string) => void
}

function selectProviders(state: AiProvidersState): AiProviderConfig[] {
  return state.providers
}

/**
 * The configured-AI-providers surface (Plan 10), over the `AiProviderConfigService`.
 */
export function useAiProviders(): UseAiProvidersValue {
  const { aiProviderConfig: service } = useCoreServices()
  const providers = useSelector(service, selectProviders)
  const defaultProvider = useSelector(service, defaultAiProvider)
  return {
    providers,
    defaultProvider,
    addProvider: (draft) => service.add(draft),
    removeProvider: (id) => service.remove(id),
    makeDefault: (id) => service.makeDefault(id),
    setDefaultModel: (id, model) => service.setDefaultModel(id, model),
  }
}
