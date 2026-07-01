import { streamText, type LanguageModel } from 'ai'
import { errorMessage } from '../errors'
import type { AiProviderConfig } from '../settings/schema'
import type { CloudSafe } from './checkers'
import { languageModel } from './language-model'
import { renderSelectionPrompt } from './selection-prompts'

/**
 * The editor AI menu's provider call: one BYOK streaming completion that
 * transforms a text selection with a chosen prompt. Unlike the chat engine
 * there is no history and no tools — the model sees the rendered prompt and
 * nothing else (broader context is the copilot's job). The selection only
 * enters the payload as a {@link CloudSafe} value, so a private note's
 * content cannot typecheck its way here.
 */

/**
 * Keeps the model's output a drop-in replacement: the result is inserted into
 * the note verbatim, so any preamble or fencing would corrupt it.
 */
const TRANSFORM_SYSTEM_PROMPT = [
  'You transform a text selection from the user’s Markdown note.',
  'Reply with only the resulting Markdown text — no preamble, no explanation,',
  'and no wrapping code fence. Match the language of the selection unless the',
  'prompt says otherwise.',
].join(' ')

export interface TransformSelectionOptions {
  /** The provider entry to call, with `model` set to the model id to use. */
  config: AiProviderConfig
  /** The BYOK API key, read from the OS keychain by the caller. */
  apiKey: string
  /**
   * Transport for the provider call — the desktop passes its shell fetch
   * (CORS-free, host-allowlisted); tests pass a stub.
   */
  fetchFn: typeof fetch
  /** The prompt body (may contain `{{selectedText}}`). */
  promptBody: string
  /** The selection, minted through `cloudSafeSelection` (the privacy gate). */
  selection: CloudSafe<string>
  /** Aborts the provider call mid-stream (discard/retry while streaming). */
  signal?: AbortSignal
}

/** One normalized event in a selection transform's stream. */
export type TransformStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'complete'; text: string }
  | { type: 'aborted' }
  | { type: 'error'; message: string }

/**
 * Stream a selection transform from the user's configured provider, yielding
 * normalized {@link TransformStreamEvent}s. The stream terminates with exactly
 * one of `complete` (carrying the full accumulated text), `aborted`, or
 * `error`.
 */
export function transformSelection(
  options: TransformSelectionOptions,
): AsyncGenerator<TransformStreamEvent> {
  return streamTransformTurn(languageModel(options.config, options.apiKey, options.fetchFn), {
    prompt: renderSelectionPrompt(options.promptBody, options.selection),
    signal: options.signal,
  })
}

/** {@link streamTransformTurn}'s options: the rendered prompt plus the abort signal. */
export interface TransformTurnOptions {
  /** The fully rendered, model-facing prompt. */
  prompt: string
  /** Aborts the provider call mid-stream. */
  signal?: AbortSignal | undefined
}

/**
 * The engine under {@link transformSelection}, taking a concrete model — the
 * seam tests drive with a mock model instead of a provider.
 */
export async function* streamTransformTurn(
  model: LanguageModel,
  options: TransformTurnOptions,
): AsyncGenerator<TransformStreamEvent> {
  let text = ''
  try {
    const result = streamText({
      model,
      system: TRANSFORM_SYSTEM_PROMPT,
      prompt: options.prompt,
      ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
    })

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta':
          text += part.text
          yield { type: 'text-delta', text: part.text }
          break
        case 'abort':
          yield { type: 'aborted' }
          return
        case 'error':
          yield { type: 'error', message: errorMessage(part.error) }
          return
        default:
          break
      }
    }

    yield { type: 'complete', text }
  } catch (cause) {
    // Belt and braces: most failures surface as `error` parts above, but a
    // synchronous throw (bad config, aborted before first byte) lands here.
    if (options.signal?.aborted === true) {
      yield { type: 'aborted' }
      return
    }
    yield { type: 'error', message: errorMessage(cause) }
  }
}
