import type { LanguageModel } from '@reflect/modules/ai'
import type { HttpService } from '../ports/http-service.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import { anthropicDirectBrowserAccessHeaders } from './anthropic-headers.ts'
import { APP_REVIEW_STUB_KEY, createDemoModel } from './app-review-demo.ts'
import { OPENAI_COMPATIBLE_PROVIDER_ID } from './openai-compatible.ts'
import { OPENROUTER_BASE_URL, openRouterAttributionHeaders } from './openrouter.ts'

/**
 * Loads each provider SDK on first use, so no SDK is in the startup bundle.
 */
export interface AiSdkLoader {
  openai: () => Promise<typeof import('@reflect/modules/ai-sdk/openai')>
  anthropic: () => Promise<typeof import('@reflect/modules/ai-sdk/anthropic')>
  google: () => Promise<typeof import('@reflect/modules/ai-sdk/google')>
  openaiCompatible: () => Promise<typeof import('@reflect/modules/ai-sdk/openai-compatible')>
}

/**
 * An {@link AiSdkLoader} over dynamic imports.
 */
export function createLazyAiSdkLoader(): AiSdkLoader {
  return {
    openai: () => import('@reflect/modules/ai-sdk/openai'),
    anthropic: () => import('@reflect/modules/ai-sdk/anthropic'),
    google: () => import('@reflect/modules/ai-sdk/google'),
    openaiCompatible: () => import('@reflect/modules/ai-sdk/openai-compatible'),
  }
}

/**
 * Turns a configured BYOK entry and its key into a callable language model.
 */
export interface LanguageModelService {
  /**
   * Build the AI SDK model instance for a configured BYOK entry: the one place
   * provider ids map to SDK factories. Shared by the chat engine
   * (`chat/stream-chat`) and one-shot calls like the link-capture page
   * description (`describe-page`). The App Review demo key gets the local
   * demo model regardless of the configured provider, since the reviewer may
   * have picked any of them.
   */
  create(config: AiProviderConfig, apiKey: string): Promise<LanguageModel>
}

export interface LanguageModelServiceDeps {
  readonly http: HttpService
  readonly sdk: AiSdkLoader
}

class LanguageModelServiceImpl implements LanguageModelService {
  readonly #deps: LanguageModelServiceDeps
  readonly #fetch: typeof fetch

  constructor(deps: LanguageModelServiceDeps) {
    this.#deps = deps
    this.#fetch = (input, init) => deps.http.fetch(input, init)
  }

  async create(config: AiProviderConfig, apiKey: string): Promise<LanguageModel> {
    const { sdk } = this.#deps
    const fetchFn = this.#fetch
    if (apiKey === APP_REVIEW_STUB_KEY) {
      return createDemoModel()
    }
    switch (config.provider) {
      case 'openai': {
        const { createOpenAI } = await sdk.openai()
        return createOpenAI({ apiKey, fetch: fetchFn })(config.model)
      }
      case 'anthropic': {
        const { createAnthropic } = await sdk.anthropic()
        return createAnthropic({
          apiKey,
          fetch: fetchFn,
          headers: anthropicDirectBrowserAccessHeaders(),
        })(config.model)
      }
      case 'google': {
        const { createGoogle } = await sdk.google()
        return createGoogle({ apiKey, fetch: fetchFn })(config.model)
      }
      case 'openrouter': {
        const { createOpenAI } = await sdk.openai()
        return createOpenAI({
          apiKey,
          fetch: fetchFn,
          baseURL: OPENROUTER_BASE_URL,
          headers: openRouterAttributionHeaders(),
          name: 'openrouter',
        }).chat(config.model)
      }
      case 'openai-compatible': {
        const { createOpenAICompatible } = await sdk.openaiCompatible()
        return createOpenAICompatible({
          name: OPENAI_COMPATIBLE_PROVIDER_ID,
          baseURL: config.baseUrl,
          fetch: fetchFn,
          includeUsage: true,
          ...(apiKey.trim() === '' ? {} : { apiKey }),
        }).chatModel(config.model)
      }
    }
  }
}

export function createLanguageModelService(deps: LanguageModelServiceDeps): LanguageModelService {
  return new LanguageModelServiceImpl(deps)
}
