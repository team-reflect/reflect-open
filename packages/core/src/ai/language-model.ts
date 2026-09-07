import { loadAiModule } from './load-ai-module'
import type { LanguageModel } from 'ai'
import type { AiProviderConfig } from '../settings/schema'
import { anthropicDirectBrowserAccessHeaders } from './anthropic-headers'
import { APP_REVIEW_STUB_KEY, createDemoModel } from './app-review-demo'
import { OPENAI_COMPATIBLE_PROVIDER_ID } from './openai-compatible'
import { OPENROUTER_BASE_URL, openRouterAttributionHeaders } from './openrouter'

/**
 * Load only the selected provider SDK and build its model for a BYOK entry.
 * This is the one place provider ids map to SDK factories. Shared by the chat engine
 * (`chat/stream-chat`) and one-shot calls like the link-capture page
 * description (`describe-page`).
 */
export async function languageModel(
  config: AiProviderConfig,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<LanguageModel> {
  // App Review demo mode: a local model regardless of the configured
  // provider, since the reviewer may have picked any of them.
  if (apiKey === APP_REVIEW_STUB_KEY) {
    return createDemoModel()
  }
  switch (config.provider) {
    case 'openai': {
      const { createOpenAI } = await loadAiModule(() => import('@ai-sdk/openai'))
      return createOpenAI({ apiKey, fetch: fetchFn })(config.model)
    }
    case 'anthropic': {
      const { createAnthropic } = await loadAiModule(() => import('@ai-sdk/anthropic'))
      return createAnthropic({
        apiKey,
        fetch: fetchFn,
        headers: anthropicDirectBrowserAccessHeaders(),
      })(config.model)
    }
    case 'google': {
      const { createGoogle } = await loadAiModule(() => import('@ai-sdk/google'))
      return createGoogle({ apiKey, fetch: fetchFn })(config.model)
    }
    case 'openrouter': {
      const { createOpenAI } = await loadAiModule(() => import('@ai-sdk/openai'))
      return createOpenAI({
        apiKey,
        fetch: fetchFn,
        baseURL: OPENROUTER_BASE_URL,
        headers: openRouterAttributionHeaders(),
        name: 'openrouter',
      }).chat(config.model)
    }
    case 'openai-compatible': {
      const { createOpenAICompatible } = await loadAiModule(
        () => import('@ai-sdk/openai-compatible'),
      )
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
