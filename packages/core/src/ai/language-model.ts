import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { AiProviderConfig } from '../settings/schema'
import { anthropicDirectBrowserAccessHeaders } from './anthropic-headers'

/**
 * Endpoints pinned to each SDK's documented default. Passing them explicitly
 * is load-bearing: left unset, the SDK factories read `ANTHROPIC_BASE_URL` /
 * `OPENAI_BASE_URL` from the environment, and a stray variable in whatever
 * shell launched the app would silently reroute BYOK traffic — against the
 * principle that LLM calls go directly to the user-approved provider, and a
 * quiet way for every call to start failing (a bare `https://api.anthropic.com`
 * without the `/v1` 404s). Pinning keeps the app hermetic to ambient env.
 */
const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

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
      return createOpenAI({ apiKey, baseURL: OPENAI_BASE_URL, fetch: fetchFn })(config.model)
    case 'anthropic':
      return createAnthropic({
        apiKey,
        baseURL: ANTHROPIC_BASE_URL,
        fetch: fetchFn,
        headers: anthropicDirectBrowserAccessHeaders(),
      })(config.model)
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL: GOOGLE_BASE_URL, fetch: fetchFn })(
        config.model,
      )
  }
}
