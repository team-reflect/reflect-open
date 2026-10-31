import type { MaybePromise } from '@reflect/utils'
import type { AiProviderId, HostedAiProviderId } from '../settings/schema.ts'
import { anthropicDirectBrowserAccessHeaders } from './anthropic-headers.ts'
import { APP_REVIEW_STUB_KEY } from './app-review-demo.ts'
import { isHttpBaseUrl, normalizeOpenAICompatibleBaseUrl } from '../lib/http-url.ts'
import { OPENROUTER_BASE_URL } from './openrouter.ts'
import type { HttpService } from '../ports/http-service.ts'

/**
 * BYOK key validation (Plan 10): one cheap authenticated probe against the
 * provider, so a typo'd or wrong-provider key is caught at entry instead of
 * failing later inside an AI call. Only the response status is read — no body
 * parsing, no data retained.
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
  /**
   * Statuses that mean "the provider rejected this key" (vs. can't tell).
   */
  invalidStatuses: number[]
}

export interface ApiKeyValidationInput {
  provider: AiProviderId
  apiKey: string
  baseUrl?: string | undefined
}

const PROBES: Record<HostedAiProviderId, KeyProbe> = {
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
      ...anthropicDirectBrowserAccessHeaders(),
    }),
    invalidStatuses: [401, 403],
  },
  google: {
    url: 'https://generativelanguage.googleapis.com/v1beta/models',
    headers: (key) => ({ 'x-goog-api-key': key }),
    // Gemini reports a malformed key as 400 INVALID_ARGUMENT.
    invalidStatuses: [400, 401, 403],
  },
  openrouter: {
    url: `${OPENROUTER_BASE_URL}/key`,
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    invalidStatuses: [401, 403],
  },
}

function openAiCompatibleProbe(input: ApiKeyValidationInput): KeyProbe | null {
  if (input.baseUrl === undefined || !isHttpBaseUrl(input.baseUrl)) {
    return null
  }
  const baseUrl = normalizeOpenAICompatibleBaseUrl(input.baseUrl)
  return {
    url: `${baseUrl}/models`,
    headers: (key) => (key.trim() === '' ? {} : { Authorization: `Bearer ${key}` }),
    invalidStatuses: [401, 403],
  }
}

function keyProbe(input: ApiKeyValidationInput): KeyProbe | null {
  if (input.provider === 'openai-compatible') {
    return openAiCompatibleProbe(input)
  }
  return PROBES[input.provider]
}

/**
 * Checks a BYOK key with one cheap authenticated probe before it is saved.
 */
export interface AiKeyValidationService {
  /**
   * Probe `input.provider` with `input.apiKey`. The App Review demo key is valid without a probe.
   */
  validate(input: ApiKeyValidationInput): MaybePromise<ApiKeyValidation>
}

export interface AiKeyValidationServiceDeps {
  readonly http: HttpService
}

class AiKeyValidationServiceImpl implements AiKeyValidationService {
  readonly #deps: AiKeyValidationServiceDeps

  constructor(deps: AiKeyValidationServiceDeps) {
    this.#deps = deps
  }

  async validate(input: ApiKeyValidationInput): Promise<ApiKeyValidation> {
    // Providers know nothing about the App Review demo key, so a probe would
    // reject it; accept it here so it can be saved and reach the canned
    // transcription path.
    if (input.apiKey === APP_REVIEW_STUB_KEY) {
      return 'valid'
    }
    const probe = keyProbe(input)
    if (probe === null) {
      return 'invalid'
    }
    let response: Response
    try {
      response = await this.#deps.http.fetch(probe.url, {
        method: 'GET',
        headers: probe.headers(input.apiKey),
      })
    } catch {
      return 'unreachable'
    }
    if (response.ok) {
      return 'valid'
    }
    return probe.invalidStatuses.includes(response.status) ? 'invalid' : 'unreachable'
  }
}

export function createAiKeyValidationService(
  deps: AiKeyValidationServiceDeps,
): AiKeyValidationService {
  return new AiKeyValidationServiceImpl(deps)
}
