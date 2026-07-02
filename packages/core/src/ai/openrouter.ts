/** The OpenAI-compatible OpenRouter API root. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** Optional attribution headers OpenRouter uses for app identification. */
export function openRouterAttributionHeaders(): Record<string, string> {
  return {
    'HTTP-Referer': 'https://reflect.app',
    'X-OpenRouter-Title': 'Reflect',
  }
}
