import type { ModelMessage } from 'ai'

/**
 * The moving context window: fit a conversation's model-facing history into
 * a model's context budget before each turn. Two degradation stages, both
 * deterministic and free (no summarization calls on the user's BYOK dime):
 *
 * 1. **Elide** old tool results — a single `read_note` result can be 24k
 *    chars, so dropping whole turns first would evict real conversation to
 *    keep note dumps the model has already digested.
 * 2. **Drop** the oldest turns whole. Trimming happens only at turn
 *    boundaries (a segment starts at each `user` message), so a tool call
 *    can never be split from its result — providers reject dangling pairs.
 *
 * Token counts are estimates (~4 chars/token); every constant errs toward
 * sending less, never toward blowing the window.
 */

/** Rough chars-per-token for prose and JSON; the headroom factor covers it. */
const CHARS_PER_TOKEN = 4

/**
 * Flat per-image estimate. Providers downscale and bill far below the data
 * URL's size, so estimating from `image.length` would wildly overshoot
 * (a 1 MB photo is ~340k chars of base64 but ~1.6k tokens).
 */
const IMAGE_TOKENS = 1_600

/** Per-message framing overhead (role markers etc.). */
const MESSAGE_OVERHEAD_TOKENS = 4

/**
 * History budget ceiling even on 1M-token models: beyond this the marginal
 * recall is not worth the per-turn BYOK cost (OpenAI bills long-context
 * requests at 2×, and a 1M-token Claude turn costs whole dollars).
 */
const PRACTICAL_WINDOW_CEILING = 200_000

/**
 * Window share reserved for what the turn itself adds *after* trimming: up
 * to `MAX_STEPS` (8) tool round-trips, each returning up to
 * `MAX_NOTE_CONTENT_CHARS` (24k chars ≈ 6k tokens), plus the streamed
 * reply. A reply-only reserve would trim to "fits" and still blow the
 * window mid-turn.
 */
const TURN_RESERVE_TOKENS = 60_000

/** Spend at most this share of the budget — absorbs estimation error. */
const ESTIMATE_HEADROOM = 0.8

/** The newest turns keep their tool results verbatim during elision. */
const KEEP_INTACT_SEGMENTS = 2

/** What an elided tool result is replaced with (the model still sees that a call happened). */
const ELIDED_TOOL_RESULT = '[Old tool result elided to fit the context window.]'

export interface ContextWindowOptions {
  /** The model's context window in tokens (`modelContextWindow`). */
  contextWindow: number
  /** The system prompt the turn will send — counted against the window. */
  systemPrompt: string
}

/** Every content-part shape any {@link ModelMessage} role can carry. */
type ContentPart = Exclude<ModelMessage['content'], string>[number]

/** Estimated token cost of one model message. */
export function estimateTokens(message: ModelMessage): number {
  const content: string | readonly ContentPart[] = message.content
  if (typeof content === 'string') {
    return MESSAGE_OVERHEAD_TOKENS + textTokens(content)
  }
  return content.reduce((total, part) => total + partTokens(part), MESSAGE_OVERHEAD_TOKENS)
}

function partTokens(part: ContentPart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return textTokens(part.text)
    case 'image':
      return IMAGE_TOKENS
    default:
      // Tool calls, tool results, files: the JSON encoding is what travels.
      return textTokens(JSON.stringify(part))
  }
}

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

function totalTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0)
}

/**
 * Fit `messages` into the model's context budget. Under budget the history
 * passes through untouched; over budget, old tool results are elided first,
 * then the oldest turns dropped whole. The newest turn always survives —
 * if even that alone overruns the budget, the provider's own limit is the
 * backstop.
 */
export function fitToContextWindow(
  messages: ModelMessage[],
  options: ContextWindowOptions,
): ModelMessage[] {
  const window = Math.min(options.contextWindow, PRACTICAL_WINDOW_CEILING)
  const budget = Math.floor(
    (window - textTokens(options.systemPrompt) - TURN_RESERVE_TOKENS) * ESTIMATE_HEADROOM,
  )
  if (totalTokens(messages) <= budget) {
    return messages
  }

  const segments = splitIntoTurnSegments(messages)
  const elided = segments.map((segment, index) =>
    index < segments.length - KEEP_INTACT_SEGMENTS ? segment.map(elideToolResults) : segment,
  )

  // Keep the longest newest-first run of whole segments that fits.
  const kept: ModelMessage[][] = []
  let used = 0
  for (let index = elided.length - 1; index >= 0; index -= 1) {
    const segment = elided[index]
    if (segment === undefined) {
      continue
    }
    const cost = totalTokens(segment)
    if (kept.length > 0 && used + cost > budget) {
      break
    }
    kept.unshift(segment)
    used += cost
  }
  return kept.flat()
}

/**
 * Group messages into turn segments: each starts at a `user` message and
 * carries everything the assistant did in response (assistant messages, tool
 * results). Trimming whole segments is what keeps tool pairs intact.
 */
function splitIntoTurnSegments(messages: ModelMessage[]): ModelMessage[][] {
  const segments: ModelMessage[][] = []
  for (const message of messages) {
    const current = segments.at(-1)
    if (message.role === 'user' || current === undefined) {
      segments.push([message])
    } else {
      current.push(message)
    }
  }
  return segments
}

/**
 * Replace a tool message's result payloads with a short placeholder. The
 * call/result pairing survives (providers require it); only the bulk goes.
 */
function elideToolResults(message: ModelMessage): ModelMessage {
  if (message.role !== 'tool') {
    return message
  }
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === 'tool-result'
        ? { ...part, output: { type: 'text' as const, value: ELIDED_TOOL_RESULT } }
        : part,
    ),
  }
}
