import type { AiProviderId } from '../settings/schema'

/**
 * BYOK key validation (Plan 10): one cheap authenticated probe against the
 * provider's model-listing endpoint, so a typo'd or wrong-provider key is
 * caught at entry instead of failing later inside an AI call. Only the
 * response status is read — no body parsing, no data retained.
 */

/**
 * `'unreachable'` means the probe couldn't make an auth decision (offline,
 * provider outage, rate limit) — callers should let the user save anyway
 * rather than hard-blocking on connectivity.
 */
export type ApiKeyValidation = 'valid' | 'invalid' | 'unreachable'

interface KeyProbe {
  url: string
  headers: (key: string) => Record<string, string>
  /** Statuses that mean "the provider rejected this key" (vs. can't tell). */
  invalidStatuses: number[]
}

const PROBES: Record<AiProviderId, KeyProbe> = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    invalidStatuses: [401, 403],
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/models',
    headers: (key) => ({
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Required for direct-from-browser calls; harmless elsewhere.
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    invalidStatuses: [401, 403],
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    headers: (key) => ({ 'x-goog-api-key': key }),
    // Gemini reports a malformed key as 400 INVALID_ARGUMENT.
    invalidStatuses: [400, 401, 403],
  },
}

/**
 * Probe `provider` with `apiKey`. `fetchFn` lets hosts substitute a
 * CORS-free transport (the desktop app passes the Tauri HTTP plugin's fetch;
 * `@reflect/core` itself stays platform-agnostic).
 */
export async function validateApiKey(
  provider: AiProviderId,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<ApiKeyValidation> {
  const probe = PROBES[provider]
  let response: Response
  try {
    response = await fetchFn(probe.url, { method: 'GET', headers: probe.headers(apiKey) })
  } catch {
    return 'unreachable'
  }
  if (response.ok) {
    return 'valid'
  }
  return probe.invalidStatuses.includes(response.status) ? 'invalid' : 'unreachable'
}
