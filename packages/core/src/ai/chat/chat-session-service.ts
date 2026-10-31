import type { ClockService } from '../../ports/clock-service.ts'
import type { IdService } from '../../ports/id-service.ts'
import type { ImageCodecService } from '../../ports/image-codec-service.ts'
import type { LoggerService } from '../../ports/logger-service.ts'
import type { EmbeddingRuntimeService } from '../../embeddings/embedding-runtime-service.ts'
import { errorMessage } from '../../errors.ts'
import type { GraphSession } from '../../graph/graph-session.ts'
import type { Unlisten } from '../../unlisten.ts'
import type { AiProviderConfig, ChatModelSelection, Settings } from '../../settings/schema.ts'
import type { SettingsService } from '../../settings/settings-service.ts'
import type { AiCredentialService } from '../ai-credential-service.ts'
import type { AiProviderConfigService } from '../ai-provider-config-service.ts'
import { readChatAttachment } from './chat-attachments.ts'
import type { ChatEngineService, ChatStreamEvent } from './chat-engine-service.ts'
import type { ChatGraphContextService } from './chat-graph-context-service.ts'
import type { ChatConversation, ChatHistoryService } from './chat-history-service.ts'
import type { ChatModelOption } from './model-options.ts'
import {
  appendEvent,
  buildHistory,
  userMessage,
  type ChatAttachment,
  type ChatTurn,
} from './transcript.ts'

/**
 * One chat session per open graph (Plan 10): the conversation lives here, not
 * in the screen, so navigating away and back keeps it. The state is just
 * {@link ChatTurn}s — what each turn renders and what it contributed to the
 * model history are one record, and the history a new turn resends is derived
 * from them.
 *
 * Conversations persist to the graph's index DB (the `ChatHistoryService`):
 * each turn is saved when sent (the user half) and again when it settles, so
 * a relaunch restores the conversation exactly. When the session attaches,
 * the latest conversation is resumed unless it has been idle past
 * {@link CHAT_IDLE_CUTOFF_MS} — then a fresh one starts and the old one stays
 * in the history. Persistence is best-effort: a failed save logs and the
 * in-memory conversation carries on.
 */

/**
 * Resume the latest conversation within this window; otherwise start fresh.
 */
export const CHAT_IDLE_CUTOFF_MS = 6 * 60 * 60 * 1000

const TITLE_MAX_CHARS = 60

/**
 * Title for a conversation row: its first message, cut to list length.
 */
export function conversationTitle(firstUserText: string): string {
  const trimmed = firstUserText.trim().replaceAll(/\s+/g, ' ')
  if (trimmed === '') {
    return 'New chat'
  }
  return trimmed.length > TITLE_MAX_CHARS ? `${trimmed.slice(0, TITLE_MAX_CHARS)}…` : trimmed
}

export type ChatStatus = 'idle' | 'streaming'

/**
 * What a {@link ChatSession} publishes. Replaced, never mutated, on every change.
 */
export interface ChatSessionState {
  turns: ChatTurn[]
  status: ChatStatus
  /**
   * Configured provider entries (empty → the add-a-provider CTA).
   */
  providers: AiProviderConfig[]
  /**
   * Every model the picker offers: each provider's full curated list.
   */
  modelOptions: ChatModelOption[]
  /**
   * The provider entry + model the next turn calls (`model` already carries
   * the picker's choice) — the persisted last pick or the settings default.
   */
  activeModel: AiProviderConfig | null
  /**
   * The composer's unsent text. Session state, not composer state, so it
   * survives the screen unmounting. Cleared by a send that goes through.
   */
  draft: string
  /**
   * Images queued for the next message (dropped or pasted onto the chat).
   */
  attachments: ChatAttachment[]
  /**
   * The persisted conversation the transcript belongs to.
   */
  activeConversationId: string
}

/**
 * The chat session of one open graph. Members are function properties so
 * surfaces can pass them around unbound.
 */
export interface ChatSession {
  getState: () => ChatSessionState
  subscribe: (listener: () => void) => Unlisten
  /**
   * Start the session's background work: resume the latest conversation of
   * the graph (when its index is open) and follow the
   * embedding runtime status. The returned function stops both and aborts
   * the in-flight turn — a turn must die with its graph, or its tools would
   * keep reading whichever graph is open *now* and ship that content to the
   * provider under the old conversation.
   */
  attach(): Unlisten
  /**
   * Pick the chat model. Persisted (`chatModelSelection` in the settings
   * document), so later sessions start on it; null returns to the app
   * default.
   */
  selectModel(selection: ChatModelSelection | null): void
  /**
   * Replace the composer draft.
   */
  setDraft(text: string): void
  /**
   * Queue image files for the next message.
   */
  attachImages(files: File[]): Promise<void>
  /**
   * Drop one queued image.
   */
  removeAttachment(id: string): void
  /**
   * Send one user message (text, queued images, or both) and stream the turn.
   */
  send(text: string): Promise<void>
  /**
   * Abort the in-flight turn (partial text stays in the transcript).
   */
  stop(): void
  /**
   * Leave the conversation in the history and start a fresh one.
   */
  newChat(): void
  /**
   * Load a past conversation from the history.
   */
  openConversation(id: string): Promise<void>
  /**
   * Delete a conversation; deleting the active one starts a fresh chat.
   */
  deleteConversation(id: string): Promise<void>
}

export interface ChatSessionOptions {
  /**
   * The graph session: `name` titles the prompt's overview block; chat writes pin to its index generation.
   */
  session: GraphSession
}

export interface ChatSessionServiceDeps {
  readonly chatEngine: ChatEngineService
  readonly chatHistory: ChatHistoryService
  readonly chatGraphContext: ChatGraphContextService
  readonly providerConfig: AiProviderConfigService
  readonly credentials: AiCredentialService
  readonly embeddingRuntime: EmbeddingRuntimeService
  readonly settings: SettingsService
  readonly clock: ClockService
  readonly id: IdService
  readonly imageCodec: ImageCodecService
  readonly logger: LoggerService
}

/**
 * Creates the chat session of an open graph and reports history changes.
 */
export interface ChatSessionService {
  /**
   * A fresh session for `options.session`. It does nothing until it is attached.
   */
  create(options: ChatSessionOptions): ChatSession
  /**
   * Calls `listener` after any session saved a turn or deleted a
   * conversation: the persisted conversation list may have changed.
   */
  onConversationsChanged(listener: () => void): Unlisten
}

interface LocalState {
  turns: ChatTurn[]
  draft: string
  attachments: ChatAttachment[]
  conversationId: string
}

interface ChatSessionImplDeps extends ChatSessionServiceDeps {
  readonly emitConversationsChanged: () => void
}

class ChatSessionImpl implements ChatSession {
  readonly #deps: ChatSessionImplDeps
  readonly #graph: GraphSession
  readonly #listeners = new Set<() => void>()
  // The graph's index session generation, echoed by every chat write: a
  // session winding down after its graph was replaced keeps it, so its late
  // saves no-op in Rust instead of landing in the graph that is open now.
  readonly #generation: number | null
  // Conversations deleted this session: a settle-time save landing after its
  // conversation was deleted would re-create the row via the upsert.
  readonly #deletedConversations = new Set<string>()
  // The tail of each conversation's save chain. Saves are serialized per
  // conversation so a delete can wait for in-flight saves to land first —
  // two independent IPC commands carry no ordering guarantee in Rust.
  readonly #pendingSaves = new Map<string, Promise<void>>()
  #local: LocalState
  #stopSettings: Unlisten | null = null
  // The published state, rebuilt lazily: `null` after a local change, and
  // stale once the settings document it was derived from is replaced.
  #snapshot: { state: ChatSessionState; settings: Settings } | null = null
  #modelOptions: { providers: AiProviderConfig[]; options: ChatModelOption[] } | null = null
  // The in-flight send, tracked synchronously — the no-concurrent-sends
  // guard can't ride on published state. `session` ties a send to its
  // conversation: New chat bumps the counter, so a detached send winding
  // down no longer counts as "this conversation is busy" and never clears a
  // successor's slot.
  #sessionCounter = 0
  #activeSend: { controller: AbortController; session: number } | null = null
  // The session of the most recent send — unlike `activeSend` this is not
  // cleared when the turn settles, so a pending conversation switch can tell
  // that the on-screen conversation received a message even after the stream
  // finished.
  #lastSendSession = -1

  constructor(deps: ChatSessionImplDeps, options: ChatSessionOptions) {
    this.#deps = deps
    this.#graph = options.session
    this.#generation = options.session.indexGeneration
    this.#local = {
      turns: [],
      draft: '',
      attachments: [],
      conversationId: deps.id.uuid(),
    }
  }

  readonly getState = (): ChatSessionState => {
    const { settings, providerConfig } = this.#deps
    const currentSettings = settings.get()
    if (this.#snapshot?.settings !== currentSettings) {
      const providers = providerConfig.list()
      if (this.#modelOptions?.providers !== providers) {
        this.#modelOptions = { providers, options: providerConfig.chatModelOptions() }
      }
      const local = this.#local
      this.#snapshot = {
        settings: currentSettings,
        state: {
          turns: local.turns,
          status: local.turns.at(-1)?.status === 'streaming' ? 'streaming' : 'idle',
          providers,
          modelOptions: this.#modelOptions.options,
          // The picker's choice lives in the settings document, not session
          // state, so the model used last is the one the next session starts on.
          activeModel: providerConfig.chatModel(),
          draft: local.draft,
          attachments: local.attachments,
          activeConversationId: local.conversationId,
        },
      }
    }
    return this.#snapshot.state
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    this.#stopSettings ??= this.#deps.settings.subscribe(() => {
      this.#notify()
    })
    return () => {
      this.#listeners.delete(deliver)
      if (this.#listeners.size === 0) {
        this.#stopSettings?.()
        this.#stopSettings = null
      }
    }
  }

  attach(): Unlisten {
    const { embeddingRuntime } = this.#deps
    const attempt = { active: true }
    if (this.#generation !== null) {
      void this.#resume(attempt)
    }
    // Without a loaded embedding model the search tool must *say* it is
    // lexical, so the runtime status is kept fresh while the session lives.
    const stopEmbed = embeddingRuntime.subscribe(() => {})
    void embeddingRuntime.status()
    return () => {
      stopEmbed()
      attempt.active = false
      this.#activeSend?.controller.abort()
    }
  }

  selectModel(selection: ChatModelSelection | null): void {
    this.#deps.providerConfig.selectChatModel(selection)
  }

  setDraft(text: string): void {
    this.#update({ draft: text })
  }

  async attachImages(files: File[]): Promise<void> {
    const { imageCodec, id } = this.#deps
    // Reading files is async: a drop still in flight when New chat clears
    // the session must not land in the fresh composer afterwards.
    const session = this.#sessionCounter
    const queued = await Promise.all(
      files.map((file) => readChatAttachment({ imageCodec, id }, file)),
    )
    if (session !== this.#sessionCounter) {
      return
    }
    this.#update({ attachments: [...this.#local.attachments, ...queued] })
  }

  removeAttachment(attachmentId: string): void {
    this.#update({
      attachments: this.#local.attachments.filter((attachment) => attachment.id !== attachmentId),
    })
  }

  async send(text: string): Promise<void> {
    const { chatEngine, chatGraphContext, providerConfig, credentials, embeddingRuntime } =
      this.#deps
    const { settings, clock, id, logger } = this.#deps
    const trimmed = text.trim()
    const attached = this.#local.attachments
    const config = providerConfig.chatModel()
    if (
      (trimmed === '' && attached.length === 0) ||
      config === null ||
      this.#activeSend?.session === this.#sessionCounter
    ) {
      return
    }
    const turnsBefore = this.#local.turns
    this.#update({ draft: '', attachments: [] })

    const turnId = id.uuid()
    const messages = [...buildHistory(turnsBefore), userMessage(trimmed, attached)]
    const customSystemPrompt = settings.get().chatSystemPrompt
    // Everything the settle-time save needs, captured now: a turn detached
    // by New chat (or a conversation switch) still persists into the
    // conversation it was sent under.
    const sendConversationId = this.#local.conversationId
    const turnCreatedMs = clock.now()
    const title = conversationTitle(turnsBefore[0]?.userText ?? trimmed)
    const conversationMeta = (): ChatConversation => ({
      id: sendConversationId,
      title,
      createdMs: turnCreatedMs,
      updatedMs: clock.now(),
    })
    // The turn is folded locally alongside the published state — the settle
    // save must not depend on the turn still being part of `turns`.
    let localTurn: ChatTurn = {
      id: turnId,
      userText: trimmed,
      attachments: attached,
      parts: [],
      responseMessages: [],
      status: 'streaming',
    }

    const updateTurn = (updater: (turn: ChatTurn) => ChatTurn) => {
      localTurn = updater(localTurn)
      this.#setTurns((current) => {
        return current.map((turn) => (turn.id === turnId ? updater(turn) : turn))
      })
    }
    const applyEvent = (event: ChatStreamEvent) => {
      updateTurn((turn) => ({ ...turn, parts: appendEvent(turn.parts, event) }))
    }

    const initialTurn = localTurn
    this.#setTurns((current) => [...current, initialTurn])
    // The user half lands immediately, so a crash mid-stream keeps the
    // question (restored with an empty response, which the model history
    // derivation already omits).
    this.#persistTurn(conversationMeta(), localTurn, turnCreatedMs)

    const controller = new AbortController()
    const sending = { controller, session: this.#sessionCounter }
    this.#activeSend = sending
    this.#lastSendSession = sending.session

    try {
      // The graph overview degrades to null (prompt without the block)
      // rather than blocking the turn — a cold index shouldn't kill chat.
      const [apiKey, context] = await Promise.all([
        credentials.read(config),
        chatGraphContext.load(this.#graph.name).catch((cause: unknown) => {
          logger.error('chat graph context failed:', errorMessage(cause))
          return null
        }),
      ])
      if (apiKey === null) {
        applyEvent({
          type: 'error',
          message: 'No API key found for this provider — re-add it in Settings → AI providers.',
          messages: [],
        })
        return
      }
      const events = chatEngine.streamTurn({
        config,
        apiKey,
        messages,
        today: clock.today(),
        // A stray enabled flag must lose to the runtime here.
        semanticSearchEnabled:
          settings.get().semanticSearchEnabled && embeddingRuntime.lastStatus().status === 'ready',
        generation: this.#graph.generation,
        customSystemPrompt,
        context,
        signal: controller.signal,
      })
      for await (const event of events) {
        // Every terminal event carries the turn's messages — for a stopped or
        // failed turn that's the completed steps plus partial text, so the
        // derived history matches what stayed on screen.
        if (event.type === 'complete' || event.type === 'aborted' || event.type === 'error') {
          updateTurn((turn) => ({ ...turn, responseMessages: event.messages }))
        }
        // `complete` is folded too: appendEvent backstops a reply-less turn
        // with a notice, so the chips never settle into silence.
        applyEvent(event)
      }
    } catch (cause) {
      // The engine normalizes its own failures; this guards the seams around
      // it (keychain read, event application) so the UI never sticks.
      applyEvent({ type: 'error', message: errorMessage(cause), messages: [] })
    } finally {
      updateTurn((turn) => ({ ...turn, status: 'done' }))
      this.#persistTurn(conversationMeta(), localTurn, turnCreatedMs)
      // Only release the slot if it's still ours: a turn detached by New
      // chat must not, while winding down, unhook the controller a newer
      // turn has since registered — Stop and the detach abort always have
      // to target the live stream.
      if (this.#activeSend === sending) {
        this.#activeSend = null
      }
    }
  }

  stop(): void {
    this.#activeSend?.controller.abort()
  }

  newChat(): void {
    this.#activeSend?.controller.abort()
    this.#sessionCounter += 1
    this.#update({ turns: [], attachments: [], conversationId: this.#deps.id.uuid() })
  }

  async openConversation(conversationId: string): Promise<void> {
    const { chatHistory, logger } = this.#deps
    if (conversationId === this.#local.conversationId) {
      return
    }
    this.#activeSend?.controller.abort()
    this.#sessionCounter += 1
    const session = this.#sessionCounter
    this.#update({ attachments: [] })
    try {
      const restored = await chatHistory.loadConversation(conversationId)
      // Superseded by another switch or New chat — or by a send: a message
      // composed while the rows loaded belongs to the conversation that was
      // on screen, so the user's turn must not be swapped out from under it.
      // Checked via the last send's session (not the in-flight slot, which
      // is cleared on settle) — a turn that finished streaming before the
      // rows arrived still anchors the switch to the conversation it's in.
      if (session !== this.#sessionCounter || this.#lastSendSession === session) {
        return
      }
      this.#update({ conversationId, turns: restored })
    } catch (cause) {
      logger.error('chat: opening the conversation failed:', errorMessage(cause))
    }
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const { chatHistory, logger, emitConversationsChanged } = this.#deps
    this.#deletedConversations.add(conversationId)
    const deleteGeneration = this.#generation
    if (deleteGeneration !== null) {
      // Let any in-flight save for this conversation land first — the
      // delete and a dispatched save are independent commands, so issuing
      // the delete now could be overtaken in Rust and the save's upsert
      // would resurrect the row. (The chain never rejects.)
      await this.#pendingSaves.get(conversationId)
      try {
        await chatHistory.deleteConversation(conversationId, deleteGeneration)
      } catch (cause) {
        logger.error('chat: deleting the conversation failed:', errorMessage(cause))
      }
      emitConversationsChanged()
    }
    if (conversationId === this.#local.conversationId) {
      this.newChat()
    }
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #update(patch: Partial<LocalState>): void {
    this.#local = { ...this.#local, ...patch }
    this.#snapshot = null
    this.#notify()
  }

  #setTurns(updater: (current: ChatTurn[]) => ChatTurn[]): void {
    this.#update({ turns: updater(this.#local.turns) })
  }

  /**
   * Persist one turn into its conversation, best-effort: the generation it
   * was issued under gates the write in Rust (a stale save no-ops), deleted
   * conversations are never resurrected — the guard runs again when the
   * save's turn in the chain comes up, not just at enqueue time — and a
   * failure logs without touching the in-memory conversation.
   */
  #persistTurn(conversation: ChatConversation, turn: ChatTurn, createdMs: number): void {
    const { chatHistory, logger, emitConversationsChanged } = this.#deps
    const saveGeneration = this.#generation
    if (saveGeneration === null || this.#deletedConversations.has(conversation.id)) {
      return
    }
    const chained = (this.#pendingSaves.get(conversation.id) ?? Promise.resolve())
      .then(async () => {
        if (this.#deletedConversations.has(conversation.id)) {
          return
        }
        await chatHistory.saveTurn({ conversation, turn, createdMs, generation: saveGeneration })
        emitConversationsChanged()
      })
      .catch((cause: unknown) => {
        logger.error('chat: saving the turn failed:', errorMessage(cause))
      })
    this.#pendingSaves.set(conversation.id, chained)
  }

  // Resume the latest conversation — unless it has been idle past the
  // cutoff (then the next message starts a fresh one and the old chat stays
  // in the history). Guarded against races: by the time the rows arrive the
  // user may have started typing into the fresh conversation.
  async #resume(attempt: { active: boolean }): Promise<void> {
    const { chatHistory, clock, logger } = this.#deps
    const session = this.#sessionCounter
    try {
      const [latest] = await chatHistory.listRecent(1)
      if (latest === undefined || clock.now() - latest.updatedMs > CHAT_IDLE_CUTOFF_MS) {
        return
      }
      const restored = await chatHistory.loadConversation(latest.id)
      if (!attempt.active || session !== this.#sessionCounter || this.#local.turns.length > 0) {
        return
      }
      this.#update({ conversationId: latest.id, turns: restored })
    } catch (cause) {
      logger.error('chat: restoring the last conversation failed:', errorMessage(cause))
    }
  }
}

class ChatSessionServiceImpl implements ChatSessionService {
  readonly #deps: ChatSessionServiceDeps
  readonly #conversationListeners = new Set<() => void>()

  constructor(deps: ChatSessionServiceDeps) {
    this.#deps = deps
  }

  create(options: ChatSessionOptions): ChatSession {
    return new ChatSessionImpl(
      { ...this.#deps, emitConversationsChanged: () => this.#emitConversationsChanged() },
      options,
    )
  }

  onConversationsChanged(listener: () => void): Unlisten {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#conversationListeners.add(deliver)
    return () => {
      this.#conversationListeners.delete(deliver)
    }
  }

  #emitConversationsChanged(): void {
    for (const listener of this.#conversationListeners) {
      listener()
    }
  }
}

export function createChatSessionService(deps: ChatSessionServiceDeps): ChatSessionService {
  return new ChatSessionServiceImpl(deps)
}
