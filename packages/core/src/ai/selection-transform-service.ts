import type { LanguageModel } from '@reflect/modules/ai'
import type { LoggerService } from '../ports/logger-service.ts'
import { errorMessage } from '../errors.ts'
import type { CloudSafe } from '../privacy/cloud-safe.ts'
import {
  isPrivateNoteError,
  type CloudSendable,
  type PrivacyService,
} from '../privacy/privacy-service.ts'
import type { AiCredentialService } from './ai-credential-service.ts'
import type { AiProviderConfigService } from './ai-provider-config-service.ts'
import type { ChatModelOption } from './chat/model-options.ts'
import type { LanguageModelService } from './language-model-service.ts'
import { renderSelectionPrompt } from './selection-prompts.ts'

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

export interface SelectionTransformRequest {
  /**
   * The note the selection comes from, with its live privacy flag (the privacy subject).
   */
  note: CloudSendable
  /**
   * The selected text. It reaches the provider only through the privacy gate.
   */
  selectedText: string
  /**
   * The prompt body (may contain `{{selectedText}}`).
   */
  promptBody: string
  /**
   * The entry and model to call instead of the default entry; `null` uses the default.
   */
  model: ChatModelOption | null
  /**
   * Aborts the provider call mid-stream (discard/retry while streaming).
   */
  signal?: AbortSignal
}

/**
 * One normalized event in a selection transform's stream.
 */
export type TransformStreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'complete'; text: string }
  | { type: 'aborted' }
  | { type: 'error'; message: string }

export interface SelectionTransformServiceDeps {
  readonly logger: LoggerService
  readonly languageModel: LanguageModelService
  readonly providerConfig: AiProviderConfigService
  readonly credentials: AiCredentialService
  readonly privacy: PrivacyService
}

/**
 * Runs a prompt on an editor selection and streams the replacement text.
 */
export interface SelectionTransformService {
  /**
   * Stream a selection transform from the user's configured provider, yielding
   * normalized {@link TransformStreamEvent}s. The stream terminates with exactly
   * one of `complete` (carrying the full accumulated text), `aborted`, or
   * `error`. A missing provider, a private note and a missing API key each
   * end the stream with an `error` before any provider call.
   */
  transform(request: SelectionTransformRequest): AsyncGenerator<TransformStreamEvent>
}

class SelectionTransformServiceImpl implements SelectionTransformService {
  readonly #deps: SelectionTransformServiceDeps

  constructor(deps: SelectionTransformServiceDeps) {
    this.#deps = deps
  }

  async *transform(request: SelectionTransformRequest): AsyncGenerator<TransformStreamEvent> {
    const { logger, languageModel, providerConfig, credentials, privacy } = this.#deps
    const { model: modelOverride, signal } = request
    const base =
      modelOverride === null
        ? providerConfig.defaultProvider()
        : (providerConfig.list().find((entry) => entry.id === modelOverride.configId) ?? null)
    if (base === null) {
      yield { type: 'error', message: 'Add an AI provider in Settings to use AI prompts.' }
      return
    }
    const config = modelOverride === null ? base : { ...base, model: modelOverride.modelId }

    // The privacy gate: the selection is note content, so it only leaves the
    // device as a CloudSafe value minted against the note's privacy flag.
    let selection: CloudSafe<string>
    try {
      selection = privacy.cloudSafeSelection(request.note, request.selectedText)
    } catch (cause) {
      if (isPrivateNoteError(cause)) {
        yield {
          type: 'error',
          message: 'This note is marked private, so its content is never sent to an AI provider.',
        }
        return
      }
      throw cause
    }

    const apiKey = await credentials.read(config).catch(() => null)
    if (apiKey === null) {
      yield {
        type: 'error',
        message: 'No API key found for this provider — re-add it in Settings → AI providers.',
      }
      return
    }

    try {
      signal?.throwIfAborted()
      const model = await languageModel.create(config, apiKey)
      signal?.throwIfAborted()
      yield* streamTransformTurn({ logger }, model, {
        prompt: renderSelectionPrompt(request.promptBody, selection),
        signal,
      })
    } catch (cause) {
      yield signal?.aborted ? { type: 'aborted' } : { type: 'error', message: errorMessage(cause) }
    }
  }
}

export function createSelectionTransformService(
  deps: SelectionTransformServiceDeps,
): SelectionTransformService {
  return new SelectionTransformServiceImpl(deps)
}

/**
 * {@link streamTransformTurn}'s options: the rendered prompt plus the abort signal.
 */
export interface TransformTurnOptions {
  /**
   * The fully rendered, model-facing prompt.
   */
  prompt: string
  /**
   * Aborts the provider call mid-stream.
   */
  signal?: AbortSignal | undefined
}

/**
 * The engine under {@link SelectionTransformService.transform}, taking a concrete model — the
 * seam tests drive with a mock model instead of a provider.
 */
export async function* streamTransformTurn(
  ctx: { logger: LoggerService },
  model: LanguageModel,
  options: TransformTurnOptions,
): AsyncGenerator<TransformStreamEvent> {
  let text = ''
  try {
    const { streamText } = await import('@reflect/modules/ai')
    options.signal?.throwIfAborted()
    const result = streamText({
      model,
      instructions: TRANSFORM_SYSTEM_PROMPT,
      prompt: options.prompt,
      ...(options.signal !== undefined ? { abortSignal: options.signal } : {}),
      // Without a handler the SDK prints the error to the console itself. The
      // error also arrives as an `error` part below.
      onError: ({ error }) => {
        ctx.logger.error('selection transform stream failed:', error)
      },
    })

    for await (const part of result.stream) {
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
