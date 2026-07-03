import { generateText } from 'ai'
import type { AiProviderConfig } from '../settings/schema'
import { wikiLinkSafe } from '../markdown/edit'
import { languageModel } from './language-model'

const TITLE_TIMEOUT_MS = 30_000
const MAX_TRANSCRIPT_CHARS = 4_000
const MAX_TITLE_CHARS = 80
const MAX_FALLBACK_WORDS = 8

export interface GenerateAudioMemoTitleRequest {
  /** The provider entry used for the memo's transcription pass. */
  config: AiProviderConfig
  /** The BYOK API key, read from the OS keychain by the caller. */
  apiKey: string
  /** Host transport (the Tauri HTTP plugin's fetch; tests pass a stub). */
  fetchFn?: typeof fetch | undefined
  /** The memo transcript to name. */
  transcript: string
  /** Timestamp-derived fallback when the transcript cannot produce a title. */
  fallbackTitle: string
}

function clipTitle(title: string): string {
  if (title.length <= MAX_TITLE_CHARS) {
    return title
  }
  const clipped = title.slice(0, MAX_TITLE_CHARS).replace(/\s+\S*$/, '').trim()
  return clipped === '' ? title.slice(0, MAX_TITLE_CHARS).trim() : clipped
}

function firstContentLine(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? ''
}

function normalizedTitle(candidate: string): string | null {
  const line = firstContentLine(candidate)
    .replace(/^```[a-z0-9_-]*\s*/i, '')
    .replace(/```$/u, '')
    .replace(/^(?:[-*#]\s*|\d+[.)]\s*)/u, '')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, '$2')
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/^["'`]+|["'`]+$/gu, '')
  const safe = wikiLinkSafe(line).replace(/[.!?]+$/u, '').trim()
  const clipped = clipTitle(safe)
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
  try {
    const result = await generateText({
      model: languageModel(request.config, request.apiKey, request.fetchFn ?? fetch),
      prompt: titlePrompt(request.transcript),
      abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      maxRetries: 0,
    })
    return normalizedTitle(result.text) ?? fallback
  } catch {
    return fallback
  }
}
