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
