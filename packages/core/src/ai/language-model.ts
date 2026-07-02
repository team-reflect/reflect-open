import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { AiProviderConfig } from '../settings/schema'
import { anthropicDirectBrowserAccessHeaders } from './anthropic-headers'
import { OPENROUTER_BASE_URL, openRouterAttributionHeaders } from './openrouter'

/**
 * Build the AI SDK model instance for a configured BYOK entry — the one place
 * provider ids map to SDK factories. Shared by the chat engine
 * (`chat/stream-chat`) and one-shot calls like the link-capture page
 * description (`describe-page`).
 */
export function languageModel(
  config: AiProviderConfig,
  apiKey: string,
  fetchFn: typeof fetch,
): LanguageModel {
  switch (config.provider) {
    case 'openai':
      return createOpenAI({ apiKey, fetch: fetchFn })(config.model)
    case 'anthropic':
      return createAnthropic({
        apiKey,
        fetch: fetchFn,
        headers: anthropicDirectBrowserAccessHeaders(),
      })(config.model)
    case 'google':
      return createGoogleGenerativeAI({ apiKey, fetch: fetchFn })(config.model)
    case 'openrouter':
      return createOpenAI({
        apiKey,
        fetch: fetchFn,
        baseURL: OPENROUTER_BASE_URL,
        headers: openRouterAttributionHeaders(),
        name: 'openrouter',
      }).chat(config.model)
  }
}
