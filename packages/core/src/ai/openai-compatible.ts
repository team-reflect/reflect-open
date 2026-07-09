export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible'

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:1234/v1'

export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'local-model'

export function normalizeOpenAICompatibleBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '')
}

export function isHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(normalizeOpenAICompatibleBaseUrl(value))
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}
