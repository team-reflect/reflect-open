import type { AiProviderConfig, NewAiProvider } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

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

/**
 * The configured-AI-providers surface (Plan 10), over the `AiProviderConfigService`.
 */
export function useAiProviders(): UseAiProvidersValue {
  const { aiProviderConfig: service } = useCoreServices()
  const providers = useServiceState(service, service.list)
  const defaultProvider = useServiceState(service, service.defaultProvider)
  return {
    providers,
    defaultProvider,
    addProvider: (draft) => service.add(draft),
    removeProvider: (id) => service.remove(id),
    makeDefault: (id) => service.makeDefault(id),
    setDefaultModel: (id, model) => service.setDefaultModel(id, model),
  }
}
