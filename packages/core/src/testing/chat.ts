import type { MaybePromise } from '@reflect/utils'
import type {
  ChatEngineService,
  ChatStreamEvent,
  ChatTurnRequest,
} from '../ai/chat/chat-engine-service.ts'
import type { ChatGraphContextService } from '../ai/chat/chat-graph-context-service.ts'
import type {
  ChatConversation,
  ChatHistoryService,
  SaveChatTurnInput,
} from '../ai/chat/chat-history-service.ts'
import type { ChatTurn } from '../ai/chat/transcript.ts'
import {
  cloudSafeGraphContext,
  type CloudGraphContext,
  type CloudSafe,
} from '../privacy/privacy-service.ts'

export interface TestChatConversation {
  conversation: ChatConversation
  /**
   * The persisted turns, in order.
   */
  turns: readonly ChatTurn[]
}

export interface TestChatHistoryServiceOptions {
  conversations?: readonly TestChatConversation[]
}

export interface TestChatHistoryService extends ChatHistoryService {
  /**
   * Every `saveTurn` input, in order.
   */
  getSaves(): readonly SaveChatTurnInput[]
  /**
   * Every deleted conversation id, in order.
   */
  getDeletes(): readonly string[]
}

interface StoredConversation {
  conversation: ChatConversation
  turns: ChatTurn[]
}

class TestChatHistoryServiceImpl implements TestChatHistoryService {
  readonly #stored = new Map<string, StoredConversation>()
  readonly #saves: SaveChatTurnInput[] = []
  readonly #deletes: string[] = []

  constructor(options: TestChatHistoryServiceOptions | undefined) {
    for (const seed of options?.conversations ?? []) {
      this.#stored.set(seed.conversation.id, {
        conversation: { ...seed.conversation },
        turns: seed.turns.map((turn) => structuredClone(turn)),
      })
    }
  }

  async saveTurn(input: SaveChatTurnInput): Promise<void> {
    this.#saves.push(structuredClone(input))
    let entry = this.#stored.get(input.conversation.id)
    if (entry === undefined) {
      entry = { conversation: { ...input.conversation }, turns: [] }
      this.#stored.set(input.conversation.id, entry)
    } else {
      entry.conversation = { ...entry.conversation, updatedMs: input.conversation.updatedMs }
    }
    const turn = structuredClone(input.turn)
    const index = entry.turns.findIndex((existing) => existing.id === turn.id)
    if (index === -1) {
      entry.turns.push(turn)
    } else {
      entry.turns[index] = turn
    }
  }

  deleteConversation(id: string): void {
    this.#deletes.push(id)
    this.#stored.delete(id)
  }

  async listRecent(limit = 50): Promise<ChatConversation[]> {
    return [...this.#stored.values()]
      .map((entry) => ({ ...entry.conversation }))
      .sort((a, b) => b.updatedMs - a.updatedMs)
      .slice(0, limit)
  }

  async loadConversation(conversationId: string): Promise<ChatTurn[]> {
    const entry = this.#stored.get(conversationId)
    return (entry?.turns ?? []).map((turn) => ({ ...structuredClone(turn), status: 'done' }))
  }

  getSaves(): readonly SaveChatTurnInput[] {
    return [...this.#saves]
  }

  getDeletes(): readonly string[] {
    return [...this.#deletes]
  }
}

/**
 * An in-memory {@link ChatHistoryService} with the native write rules: a
 * save keeps the conversation's title and `createdMs` and bumps its
 * `updatedMs`, and a turn saved again keeps its position. Loaded turns are
 * copies restored as `done`.
 */
export function createTestChatHistoryService(
  options?: TestChatHistoryServiceOptions,
): TestChatHistoryService {
  return new TestChatHistoryServiceImpl(options)
}

/**
 * The events of a turn, or a function that answers each `streamTurn` call.
 */
export type TestChatTurnScript =
  | readonly ChatStreamEvent[]
  | ((request: ChatTurnRequest) => Iterable<ChatStreamEvent> | AsyncIterable<ChatStreamEvent>)

export interface TestChatEngineService extends ChatEngineService {
  /**
   * Every `streamTurn` request, in order.
   */
  calls(): readonly ChatTurnRequest[]
  /**
   * Replaces the script that later `streamTurn` calls play.
   */
  setScript(script: TestChatTurnScript): void
}

class TestChatEngineServiceImpl implements TestChatEngineService {
  #current: TestChatTurnScript
  readonly #log: ChatTurnRequest[] = []

  constructor(script: TestChatTurnScript) {
    this.#current = script
  }

  calls(): readonly ChatTurnRequest[] {
    return [...this.#log]
  }

  setScript(script: TestChatTurnScript): void {
    this.#current = script
  }

  async *streamTurn(request: ChatTurnRequest): AsyncGenerator<ChatStreamEvent> {
    this.#log.push(request)
    const script = this.#current
    yield* typeof script === 'function' ? script(request) : script
  }
}

/**
 * A {@link ChatEngineService} that plays `script` for every turn, without a
 * model or tools. By default a turn completes with no messages.
 */
export function createTestChatEngineService(
  script: TestChatTurnScript = [{ type: 'complete', messages: [] }],
): TestChatEngineService {
  return new TestChatEngineServiceImpl(script)
}

/**
 * A graph overview, or a function that answers each `load` call.
 */
export type TestChatGraphContextSource =
  | CloudGraphContext
  | ((graphName: string) => MaybePromise<CloudGraphContext>)

export interface TestChatGraphContextService extends ChatGraphContextService {
  /**
   * The graph name of every `load` call, in order.
   */
  calls(): readonly string[]
  /**
   * Replaces the overview that later `load` calls answer with.
   */
  setResult(result: TestChatGraphContextSource): void
}

class TestChatGraphContextServiceImpl implements TestChatGraphContextService {
  #source: TestChatGraphContextSource
  readonly #log: string[] = []

  constructor(result: TestChatGraphContextSource | undefined) {
    this.#source =
      result ??
      ((graphName) => ({
        graphName,
        noteCount: 0,
        dailyNoteCount: 0,
        earliestDailyDate: null,
        latestDailyDate: null,
        tags: [],
        tagsTruncated: false,
      }))
  }

  async load(graphName: string): Promise<CloudSafe<CloudGraphContext>> {
    this.#log.push(graphName)
    const source = this.#source
    return cloudSafeGraphContext(typeof source === 'function' ? await source(graphName) : source)
  }

  calls(): readonly string[] {
    return [...this.#log]
  }

  setResult(result: TestChatGraphContextSource): void {
    this.#source = result
  }
}

/**
 * A {@link ChatGraphContextService} that answers `result` without reading an
 * index: by default the overview of an empty graph with the requested name.
 */
export function createTestChatGraphContextService(
  result?: TestChatGraphContextSource,
): TestChatGraphContextService {
  return new TestChatGraphContextServiceImpl(result)
}
