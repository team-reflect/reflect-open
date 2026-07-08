import type { AiProviderConfig } from '../settings/schema'
import { getSecret } from '../secrets/keychain'
import { aiProviderRequiresApiKey } from './provider-catalog'

/**
 * The AI domain's keychain policy: which entries hold BYOK provider keys.
 * The storage primitive itself lives in `secrets/keychain` (shared with the
 * GitHub backup token, Plan 12).
 */

/**
 * The keychain account name holding the API key for a configured AI provider
 * (`AiProviderConfig.id` is the stable half of the address).
 */
export function aiKeySecretName(configId: string): string {
  return `ai-api-key:${configId}`
}

/**
 * Read the key for `config`, returning an empty string for providers that can
 * legitimately run without one (for example a local OpenAI-compatible server).
 * `null` still means "this provider is misconfigured and cannot be called."
 */
export async function aiApiKeyForConfig(config: AiProviderConfig): Promise<string | null> {
  const apiKey = await getSecret(aiKeySecretName(config.id)).catch(() => null)
  if (apiKey !== null) {
    return apiKey
  }
  if (!aiProviderRequiresApiKey(config.provider) && config.keyHint === '') {
    return ''
  }
  return null
}
