import { generateObject } from 'ai'
import { z } from 'zod'
import type { AiProvidersState } from './provider-config'
import type { AiProviderConfig } from '../settings/schema'
import { wikiLinkSafe } from '../markdown/edit'
import { languageModel } from './language-model'
import { clipAtWordBoundary } from './text'

const TITLE_TIMEOUT_MS = 30_000
const MAX_TRANSCRIPT_CHARS = 4_000
const MAX_TITLE_CHARS = 80
const MAX_FALLBACK_WORDS = 8
const OPENAI_AUDIO_MEMO_TITLE_MODEL = 'gpt-5.4-nano'
const ANTHROPIC_AUDIO_MEMO_TITLE_MODEL = 'claude-haiku-4-5'
const GOOGLE_AUDIO_MEMO_TITLE_MODEL = 'gemini-3.1-flash-lite'

const audioMemoTitleSchema = z.object({
  title: z.string(),
})

interface AudioMemoTitleCredentials {
  /** The provider entry whose provider selects the fixed small title model. */
  readonly config: AiProviderConfig
  /** The BYOK API key, or an empty string for no-key compatible endpoints. */
  readonly apiKey: string
}

export interface GenerateAudioMemoTitleRequest {
  /** Optional title-generation credentials; omitted means local fallback only. */
  readonly credentials?: AudioMemoTitleCredentials | undefined
  /** Host transport (the Tauri HTTP plugin's fetch; tests pass a stub). */
  readonly fetchFn?: typeof fetch | undefined
  /** The memo transcript to name. */
  readonly transcript: string
  /** Timestamp-derived fallback when the transcript cannot produce a title. */
  readonly fallbackTitle: string
}

function audioMemoTitleConfig(config: AiProviderConfig): AiProviderConfig | null {
  switch (config.provider) {
    case 'openai':
      return { ...config, model: OPENAI_AUDIO_MEMO_TITLE_MODEL }
    case 'anthropic':
      return { ...config, model: ANTHROPIC_AUDIO_MEMO_TITLE_MODEL }
    case 'google':
      return { ...config, model: GOOGLE_AUDIO_MEMO_TITLE_MODEL }
    case 'openrouter':
      return null
    case 'openai-compatible':
      return config
  }
}

/**
 * Pick the small-model provider for audio memo title generation. The user's
 * default provider wins when it has a fixed small title model; otherwise the
 * first supported configured provider is used. OpenRouter is skipped because
 * `openrouter/auto` is not a small-model guarantee; OpenAI-compatible entries
 * use the model the user configured for that endpoint.
 */
export function pickAudioMemoTitleConfig(state: AiProvidersState): AiProviderConfig | null {
  const preferred = state.providers.find((provider) => provider.id === state.defaultProviderId)
  const ordered =
    preferred === undefined
      ? state.providers
      : [preferred, ...state.providers.filter((provider) => provider.id !== preferred.id)]
  for (const provider of ordered) {
    const titleConfig = audioMemoTitleConfig(provider)
    if (titleConfig !== null) {
      return titleConfig
    }
  }
  return null
}

function firstContentLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''
}

function normalizedTitle(candidate: string): string | null {
  const safe = wikiLinkSafe(firstContentLine(candidate)).replace(/[.!?]+$/u, '').trim()
  const clipped = clipAtWordBoundary(safe, MAX_TITLE_CHARS)
  return clipped === '' ? null : clipped
}

function titleCaseFallback(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => word !== '')
    .slice(0, MAX_FALLBACK_WORDS)
    .map((word, index) => {
      const lower = word.toLocaleLowerCase()
      return index === 0 ? lower.charAt(0).toLocaleUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}

function transcriptFallbackTitle(transcript: string, fallbackTitle: string): string {
  const firstSentence = firstContentLine(transcript).split(/[.!?]/u)[0] ?? ''
  const normalized = normalizedTitle(titleCaseFallback(firstSentence))
  return normalized ?? fallbackTitle
}

function titlePrompt(transcript: string): string {
  return [
    'Name this audio memo from its transcript.',
    'Return a short human title, 3 to 7 words.',
    'Use the language of the transcript.',
    'Return only the title: no quotes, no markdown, no punctuation unless it is part of a name.',
    '',
    `Transcript:\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}`,
  ].join('\n')
}

/**
 * Generate a concise, content-derived memo title. Provider failures are
 * non-fatal because the transcript is already durable; callers still get a
 * deterministic title from the transcript before falling back to the timestamp.
 */
export async function generateAudioMemoTitle(
  request: GenerateAudioMemoTitleRequest,
): Promise<string> {
  const fallback = transcriptFallbackTitle(request.transcript, request.fallbackTitle)
  if (request.transcript.trim() === '') {
    return request.fallbackTitle
  }
  if (request.credentials === undefined) {
    return fallback
  }
  const titleConfig = audioMemoTitleConfig(request.credentials.config)
  if (titleConfig === null) {
    return fallback
  }
  try {
    const result = await generateObject({
      model: languageModel(
        titleConfig,
        request.credentials.apiKey,
        request.fetchFn ?? fetch,
      ),
      schema: audioMemoTitleSchema,
      prompt: titlePrompt(request.transcript),
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      maxRetries: 0,
    })
    return normalizedTitle(result.object.title) ?? fallback
  } catch {
    return fallback
  }
}
