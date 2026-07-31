export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible'

export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:1234/v1'

export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'local-model'

/**
 * Sentinel model id for OpenAI-compatible entries: setting a slot (`model`
 * or `transcriptionModel`) to `disabled` opts the entry out of that feature
 * — a chat-disabled entry never appears in the model picker and is skipped
 * by default resolution, a transcription-disabled entry is treated like the
 * legacy unset value (`''`). The id is offered as a catalog option, so it
 * round-trips through the settings schema like any real model id.
 */
export const DISABLED_OPENAI_COMPATIBLE_MODEL = 'disabled'

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

/**
 * Whether a plain-http base URL still stays on this machine. Anything else
 * over `http:` crosses the network unencrypted, so the add-provider forms
 * show a warning (without blocking — LAN and homelab endpoints are a
 * legitimate setup).
 */
export function isPlainHttpRemoteBaseUrl(value: string): boolean {
  try {
    const url = new URL(normalizeOpenAICompatibleBaseUrl(value))
    if (url.protocol !== 'http:') {
      return false
    }
    return url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]'
  } catch {
    return false
  }
}
