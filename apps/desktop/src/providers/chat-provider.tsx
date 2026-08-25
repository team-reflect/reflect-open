import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  aiApiKeyForConfig,
  appendEvent,
  buildPrivacySafeHistory,
  chatNoteChangesForTurn,
  chatModelOptions,
  deleteChatConversation,
  errorMessage,
  hasBridge,
  listChatConversations,
  loadChatGraphContext,
  loadChatMessages,
  mergeSourceProvenance,
  resolveChatModel,
  saveChatMessage,
  streamChat,
  userMessage,
  validateChatSource,
  type AiProviderConfig,
  type ChatConversation,
  type ChatModelSelection,
  type ChatNoteChange,
  type ChatPermissionMode,
  type ChatSourceRef,
  type ChatStreamEvent,
  type ChatTurn,
  type GraphInfo,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready'
import { toChatAttachment, type ChatAttachment } from '@/lib/chat-attachments'
import { todayIso } from '@/lib/dates'
import { isMobileSurface } from '@/lib/platform-surface'
import { providerFetch } from '@/lib/provider-fetch'
import { invalidateChatQueries } from '@/lib/query-client'
import {
  createDesktopChatNoteChangeService,
  createDesktopChatNoteToolHost,
  type DesktopChatNoteToolHost,
} from '@/lib/ai-note-tool-host'
import { ChatContext, type ChatContextValue, type ChatStatus } from '@/providers/chat-context'
import { conversationTitle } from '@/providers/chat-title'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'

/**
 * One chat session per open graph (Plan 10): the conversation lives here, not
 * in the screen, so navigating away and back keeps it. The state is just
 * {@link ChatTurn}s — what each turn renders and what it contributed to the
 * model history are one record, and the history a new turn resends is derived
 * from them.
 *
 * Conversations persist to the graph's index DB (`@reflect/core`'s chat
 * store): each turn is saved when sent (the user half) and again when it
 * settles, so a relaunch restores the conversation exactly. On mount the
 * latest conversation is resumed unless it has been idle past
 * {@link CHAT_IDLE_CUTOFF_MS} — then a fresh one starts and the old one stays
 * in the history. Persistence is best-effort: a failed save logs and the
 * in-memory conversation carries on.
 */

export { useChatSession, type ChatStatus } from '@/providers/chat-context'

/** Resume the latest conversation within this window; otherwise start fresh. */
const CHAT_IDLE_CUTOFF_MS = 6 * 60 * 60 * 1000

interface ChatProviderProps {
  /** The open graph — names the prompt's overview block. */
  graph: GraphInfo
  children: ReactNode
}

export function ChatProvider({ graph, children }: ChatProviderProps): ReactElement {
  const { settings, updateSettings } = useSettings()
  const { indexGeneration } = useGraph()
  const bridgeReady = useBridgeReady()
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID())
  const [permissionMode, setPermissionMode] = useState<ChatPermissionMode>('read')
  const [changesByTurn, setChangesByTurn] = useState<Record<string, ChatNoteChange[]>>({})
  const [changeBusy, setChangeBusy] = useState(false)

  const status: ChatStatus =
    turns.at(-1)?.status === 'streaming' ? 'streaming' : changeBusy ? 'mutating' : 'idle'
  const changeService = useMemo(
    () =>
      indexGeneration === null
        ? null
        : createDesktopChatNoteChangeService({
            graphGeneration: graph.generation,
            indexGeneration,
          }),
    [graph.generation, indexGeneration],
  )

  const providers = settings.aiProviders
  const modelOptions = useMemo(() => chatModelOptions(providers), [providers])
  // The picker's choice lives in the settings document, not session state, so
  // the model used last is the one the next session starts on.
  const activeModel = resolveChatModel(
    { providers, defaultProviderId: settings.defaultAiProviderId },
    settings.chatModelSelection,
  )

  // Read at call time, not captured: send() can fire long after the render
  // that created it.
  const turnsRef = useRef(turns)
  const attachmentsRef = useRef(attachments)
  const activeModelRef = useRef<AiProviderConfig | null>(activeModel)
  const conversationIdRef = useRef(conversationId)
  const permissionModeRef = useRef<ChatPermissionMode>(permissionMode)
  const changesByTurnRef = useRef(changesByTurn)
  const changeBusyRef = useRef(changeBusy)
  const generationRef = useRef<number | null>(indexGeneration)
  // Semantic search never runs on the mobile surface — the embed runtime is
  // desktop-only (Plan 23, contract 3) — and the tool must *say* it is
  // lexical, not lean on hybrid's degrade-on-error to absorb the missing
  // runtime. The settings document syncs no further than the device, but a
  // stray enabled flag must still lose to the platform here.
  const semanticSearchEnabled = settings.semanticSearchEnabled && !isMobileSurface()
  const semanticSearchEnabledRef = useRef(semanticSearchEnabled)
  const chatSystemPromptRef = useRef(settings.chatSystemPrompt)
  useEffect(() => {
    turnsRef.current = turns
    attachmentsRef.current = attachments
    activeModelRef.current = activeModel
    conversationIdRef.current = conversationId
    permissionModeRef.current = permissionMode
    changesByTurnRef.current = changesByTurn
    changeBusyRef.current = changeBusy
    generationRef.current = indexGeneration
    semanticSearchEnabledRef.current = semanticSearchEnabled
    chatSystemPromptRef.current = settings.chatSystemPrompt
  })

  const updatePermissionMode = useCallback((mode: ChatPermissionMode): void => {
    // Permission is checked from the ref at Send time. Update it in the same
    // event as the visible control so a fast Read & write → Read only
    // revocation cannot send one last write-enabled turn before React's effect.
    permissionModeRef.current = mode
    setPermissionMode(mode)
  }, [])

  // The in-flight send, tracked synchronously — the no-concurrent-sends
  // guard can't ride on rendered state, which only reflects a send after
  // the next render. `session` ties a send to its conversation: New chat
  // bumps the counter, so a detached send winding down no longer counts as
  // "this conversation is busy" and never clears a successor's slot.
  const sessionRef = useRef(0)
  const activeSendRef = useRef<{ controller: AbortController; session: number } | null>(null)
  // The session of the most recent send — unlike `activeSendRef` this is not
  // cleared when the turn settles, so a pending conversation switch can tell
  // that the on-screen conversation received a message even after the stream
  // finished.
  const lastSendSessionRef = useRef(-1)

  // Conversations deleted this session: a settle-time save landing after its
  // conversation was deleted would re-create the row via the upsert.
  const deletedConversationsRef = useRef(new Set<string>())
  // The tail of each conversation's save chain. Saves are serialized per
  // conversation so a delete can wait for in-flight saves to land first —
  // two independent IPC commands carry no ordering guarantee in Rust.
  const pendingSavesRef = useRef(new Map<string, Promise<void>>())
  // Local note effects deliberately outlive provider cancellation once their
  // durable checkpoint exists. Conversation deletion waits for these hosts.
  const mutationHostsRef = useRef(new Map<string, Set<DesktopChatNoteToolHost>>())
  // New chat can detach a still-settling send before another turn starts, so
  // keep every controller addressable by the conversation it belongs to.
  const conversationControllersRef = useRef(new Map<string, Set<AbortController>>())
  const pendingChangeOperationsRef = useRef(new Map<string, Set<Promise<unknown>>>())

  // The workspace tree is keyed by graph root, so switching graphs unmounts
  // this provider — an in-flight turn must die with it, or its tools would
  // keep reading whichever graph Rust has open *now* and ship that content
  // to the provider under the old conversation.
  useEffect(() => {
    return () => {
      for (const controllers of conversationControllersRef.current.values()) {
        for (const controller of controllers) {
          controller.abort()
        }
      }
      for (const hosts of mutationHostsRef.current.values()) {
        for (const host of hosts) {
          host.seal()
        }
      }
    }
  }, [])

  /**
   * Persist one turn into its conversation, best-effort: the generation it
   * was issued under gates the write in Rust (a stale save no-ops), deleted
   * conversations are never resurrected — the guard runs again when the
   * save's turn in the chain comes up, not just at enqueue time — and a
   * failure logs without touching the in-memory conversation.
   */
  const persistTurn = useCallback(
    (
      conversation: ChatConversation,
      turn: ChatTurn,
      createdMs: number,
      required = false,
    ): Promise<void> => {
      const generation = generationRef.current
      // Call-time check on purpose — saves fire from user actions, so they
      // read the live bridge state instead of a captured render value.
      if (
        !hasBridge() ||
        generation === null ||
        deletedConversationsRef.current.has(conversation.id)
      ) {
        return required
          ? Promise.reject(new Error('Chat history is unavailable, so note changes are disabled.'))
          : Promise.resolve()
      }
      const queue = pendingSavesRef.current
      const save = (queue.get(conversation.id) ?? Promise.resolve()).then(() => {
        if (deletedConversationsRef.current.has(conversation.id)) {
          if (required) {
            throw new Error('This conversation was deleted before its note change could start.')
          }
          return
        }
        return saveChatMessage({ conversation, turn, createdMs, generation }).then(
          invalidateChatQueries,
        )
      })
      const chained = save.catch((cause) => {
        console.error('chat: saving the turn failed:', errorMessage(cause))
      })
      queue.set(conversation.id, chained)
      return required ? save : chained
    },
    [],
  )

  const refreshTurnChanges = useCallback(async (turnId: string): Promise<void> => {
    const generation = generationRef.current
    if (!hasBridge() || generation === null) {
      return
    }
    try {
      const changes = await chatNoteChangesForTurn(turnId, generation)
      setChangesByTurn((current) => ({ ...current, [turnId]: changes }))
    } catch (cause) {
      console.error('chat: loading note changes failed:', errorMessage(cause))
    }
  }, [])

  const fetchChangesForTurns = useCallback(
    async (
      loadedTurns: readonly ChatTurn[],
      generation: number,
    ): Promise<Record<string, ChatNoteChange[]>> => {
      const entries = await Promise.all(
        loadedTurns.map(async (turn) => {
          try {
            return { turnId: turn.id, changes: await chatNoteChangesForTurn(turn.id, generation) }
          } catch (cause) {
            console.error('chat: loading note changes failed:', errorMessage(cause))
            return { turnId: turn.id, changes: [] }
          }
        }),
      )
      const next: Record<string, ChatNoteChange[]> = {}
      for (const entry of entries) {
        next[entry.turnId] = entry.changes
      }
      return next
    },
    [],
  )

  // Resume the latest conversation on mount — unless it has been idle past
  // the cutoff (then the next message starts a fresh one and the old chat
  // stays in the history). Guarded against races: by the time the rows
  // arrive the user may have started typing into the fresh conversation.
  useEffect(() => {
    if (!bridgeReady || indexGeneration === null) {
      return
    }
    const session = sessionRef.current
    let active = true
    void (async () => {
      try {
        try {
          await changeService?.reconcilePendingChanges()
        } catch (cause) {
          console.error('chat: reconciling note changes failed:', errorMessage(cause))
        }
        const [latest] = await listChatConversations(1)
        if (latest === undefined || Date.now() - latest.updatedMs > CHAT_IDLE_CUTOFF_MS) {
          return
        }
        const restored = await loadChatMessages(latest.id)
        const restoredChanges = await fetchChangesForTurns(restored, indexGeneration)
        if (!active || session !== sessionRef.current || turnsRef.current.length > 0) {
          return
        }
        setConversationId(latest.id)
        setTurns(restored)
        setChangesByTurn(restoredChanges)
        updatePermissionMode('read')
      } catch (cause) {
        console.error('chat: restoring the last conversation failed:', errorMessage(cause))
      }
    })()
    return () => {
      active = false
    }
  }, [bridgeReady, changeService, fetchChangesForTurns, indexGeneration, updatePermissionMode])

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim()
      const attached = attachmentsRef.current
      const config = activeModelRef.current
      if (
        (trimmed === '' && attached.length === 0) ||
        config === null ||
        changeBusyRef.current ||
        deletedConversationsRef.current.has(conversationIdRef.current) ||
        activeSendRef.current?.session === sessionRef.current
      ) {
        return
      }
      setDraft('')
      setAttachments([])

      const turnId = crypto.randomUUID()
      const sendPermissionMode = permissionModeRef.current
      const customSystemPrompt = chatSystemPromptRef.current
      const priorTurns = [...turnsRef.current]
      const currentUserMessage = userMessage(trimmed, attached)
      // Everything the settle-time save needs, captured now: a turn detached
      // by New chat (or a conversation switch) still persists into the
      // conversation it was sent under.
      const sendConversationId = conversationIdRef.current
      const turnCreatedMs = Date.now()
      const title = conversationTitle(turnsRef.current[0]?.userText ?? trimmed)
      const conversationMeta = (): ChatConversation => ({
        id: sendConversationId,
        title,
        createdMs: turnCreatedMs,
        updatedMs: Date.now(),
      })
      // The turn is folded locally alongside the rendered state — the settle
      // save must not depend on the turn still being mounted in `turns`.
      let localTurn: ChatTurn = {
        id: turnId,
        userText: trimmed,
        attachments: attached,
        parts: [],
        responseMessages: [],
        permissionMode: sendPermissionMode,
        sourceProvenance: [],
        status: 'streaming',
      }

      const updateTurn = (updater: (turn: ChatTurn) => ChatTurn) => {
        localTurn = updater(localTurn)
        setTurns((current) => current.map((turn) => (turn.id === turnId ? updater(turn) : turn)))
      }
      const applyEvent = (event: ChatStreamEvent) => {
        updateTurn((turn) => ({
          ...turn,
          parts: appendEvent(turn.parts, event),
          sourceProvenance:
            event.type === 'tool-result'
              ? mergeSourceProvenance(turn.sourceProvenance, event.result)
              : turn.sourceProvenance,
        }))
      }

      // Snapshot the turn as first rendered. This add runs at React's next
      // flush, by which point `localTurn` may already point at folded state;
      // closing over the mutable binding would add that folded turn and then
      // re-fold it through updateTurn, duplicating appended parts.
      const initialTurn = localTurn
      setTurns((current) => [...current, initialTurn])
      // The user half lands immediately, so a crash mid-stream keeps the
      // question (restored with an empty response, which the model history
      // derivation already omits).
      const controller = new AbortController()
      const activeSend = { controller, session: sessionRef.current }
      activeSendRef.current = activeSend
      lastSendSessionRef.current = activeSend.session
      const conversationControllers =
        conversationControllersRef.current.get(sendConversationId) ?? new Set<AbortController>()
      conversationControllers.add(controller)
      conversationControllersRef.current.set(sendConversationId, conversationControllers)
      const noteHost = createDesktopChatNoteToolHost({
        conversationId: sendConversationId,
        turnId,
        graphGeneration: graph.generation,
        indexGeneration: generationRef.current,
      })
      const conversationHosts = mutationHostsRef.current.get(sendConversationId) ?? new Set()
      conversationHosts.add(noteHost)
      mutationHostsRef.current.set(sendConversationId, conversationHosts)

      try {
        // A write-enabled turn may not expose mutation tools until the durable
        // parent message exists: every change journal row references it. Read
        // turns keep the existing best-effort persistence behavior.
        if (sendPermissionMode === 'readWrite') {
          await persistTurn(conversationMeta(), localTurn, turnCreatedMs, true)
        } else {
          void persistTurn(conversationMeta(), localTurn, turnCreatedMs)
        }
        // The graph overview degrades to null (prompt without the block)
        // rather than blocking the turn — a cold index shouldn't kill chat.
        const [apiKey, context, history] = await Promise.all([
          aiApiKeyForConfig(config),
          loadChatGraphContext(graph.name).catch((cause: unknown) => {
            console.error('chat graph context failed:', errorMessage(cause))
            return null
          }),
          buildPrivacySafeHistory(
            priorTurns,
            async (source) => await validateChatSource(source, { readNote: noteHost.readNote }),
          ),
        ])
        if (apiKey === null) {
          applyEvent({
            type: 'error',
            message: 'No API key found for this provider — re-add it in Settings → AI providers.',
            messages: [],
          })
          return
        }
        const admittedHistoryLength = history.length
        const validateSource = async (source: ChatSourceRef): Promise<boolean> =>
          await validateChatSource(source, { readNote: noteHost.readNote })
        const events = streamChat({
          config,
          apiKey,
          fetchFn: providerFetch,
          today: todayIso(),
          semanticSearchEnabled: semanticSearchEnabledRef.current,
          customSystemPrompt,
          context,
          permissionMode: sendPermissionMode,
          noteHost,
          messages: [...history, currentUserMessage],
          revalidateHistory: async () => {
            const revalidated = await buildPrivacySafeHistory(priorTurns, validateSource)
            return [...revalidated.slice(0, admittedHistoryLength), currentUserMessage]
          },
          validateSource,
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
        // streamChat normalizes its own failures; this guards the seams around
        // it (keychain read, event application) so the UI never sticks.
        applyEvent({ type: 'error', message: errorMessage(cause), messages: [] })
      } finally {
        noteHost.seal()
        await noteHost.settled()
        conversationHosts.delete(noteHost)
        if (conversationHosts.size === 0) {
          mutationHostsRef.current.delete(sendConversationId)
        }
        conversationControllers.delete(controller)
        if (conversationControllers.size === 0) {
          conversationControllersRef.current.delete(sendConversationId)
        }
        await refreshTurnChanges(turnId)
        updateTurn((turn) => ({ ...turn, status: 'done' }))
        void persistTurn(conversationMeta(), localTurn, turnCreatedMs)
        // Only release the slot if it's still ours: a turn detached by New
        // chat must not, while winding down, unhook the controller a newer
        // turn has since registered — Stop and the unmount abort always have
        // to target the live stream.
        if (activeSendRef.current === activeSend) {
          activeSendRef.current = null
        }
      }
    },
    [graph.generation, graph.name, persistTurn, refreshTurnChanges],
  )

  const stop = useCallback(() => {
    activeSendRef.current?.controller.abort()
  }, [])

  const newChat = useCallback(() => {
    activeSendRef.current?.controller.abort()
    sessionRef.current += 1
    setTurns([])
    setChangesByTurn({})
    setAttachments([])
    setConversationId(crypto.randomUUID())
    updatePermissionMode('read')
  }, [updatePermissionMode])

  const openConversation = useCallback(
    async (id: string): Promise<void> => {
      if (id === conversationIdRef.current) {
        return
      }
      activeSendRef.current?.controller.abort()
      sessionRef.current += 1
      const session = sessionRef.current
      setAttachments([])
      updatePermissionMode('read')
      try {
        const restored = await loadChatMessages(id)
        const generation = generationRef.current
        const restoredChanges =
          generation === null ? {} : await fetchChangesForTurns(restored, generation)
        // Superseded by another switch or New chat — or by a send: a message
        // composed while the rows loaded belongs to the conversation that was
        // on screen, so the user's turn must not be swapped out from under it.
        // Checked via the last send's session (not the in-flight slot, which
        // is cleared on settle) — a turn that finished streaming before the
        // rows arrived still anchors the switch to the conversation it's in.
        if (session !== sessionRef.current || lastSendSessionRef.current === session) {
          return
        }
        setConversationId(id)
        setTurns(restored)
        setChangesByTurn(restoredChanges)
      } catch (cause) {
        console.error('chat: opening the conversation failed:', errorMessage(cause))
      }
    },
    [fetchChangesForTurns, updatePermissionMode],
  )

  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      deletedConversationsRef.current.add(id)
      for (const controller of conversationControllersRef.current.get(id) ?? []) {
        controller.abort()
      }
      const mutationHosts = [...(mutationHostsRef.current.get(id) ?? [])]
      for (const host of mutationHosts) {
        host.seal()
      }
      const generation = generationRef.current
      if (hasBridge() && generation !== null) {
        // Let any in-flight save for this conversation land first — the
        // delete and a dispatched save are independent commands, so issuing
        // the delete now could be overtaken in Rust and the save's upsert
        // would resurrect the row. (The chain never rejects.)
        await pendingSavesRef.current.get(id)
        await Promise.all(mutationHosts.map(async (host) => await host.settled()))
        const pendingChangeOperations = pendingChangeOperationsRef.current.get(id)
        if (pendingChangeOperations) {
          await Promise.allSettled(pendingChangeOperations)
        }
        try {
          await deleteChatConversation(id, generation)
        } catch (cause) {
          console.error('chat: deleting the conversation failed:', errorMessage(cause))
        }
        invalidateChatQueries()
      }
      if (id === conversationIdRef.current) {
        newChat()
      }
    },
    [newChat],
  )

  const selectModel = useCallback(
    (next: ChatModelSelection | null) => {
      updateSettings({ chatModelSelection: next })
    },
    [updateSettings],
  )

  const attachImages = useCallback(async (files: File[]): Promise<void> => {
    // Reading files is async: a drop still in flight when New chat clears
    // the session must not land in the fresh composer afterwards.
    const session = sessionRef.current
    const queued = await Promise.all(files.map(toChatAttachment))
    if (session !== sessionRef.current) {
      return
    }
    setAttachments((current) => [...current, ...queued])
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }, [])

  const runUndo = useCallback(
    async (turnId: string, path: string | null): Promise<void> => {
      if (changeService === null) {
        throw new Error('Durable note change history is unavailable for this graph.')
      }
      if (changeBusyRef.current) {
        throw new Error('Another note change is still in progress.')
      }
      const changes = changesByTurnRef.current[turnId] ?? []
      const operation =
        path === null ? changeService.undoTurn(changes) : changeService.undoPath(changes, path)
      const conversation = conversationIdRef.current
      const pending = pendingChangeOperationsRef.current.get(conversation) ?? new Set()
      pending.add(operation)
      pendingChangeOperationsRef.current.set(conversation, pending)
      changeBusyRef.current = true
      setChangeBusy(true)
      try {
        const result = await operation
        await refreshTurnChanges(turnId)
        if (!result.ok) {
          throw new Error(
            result.failures
              .map((failure) =>
                failure.path === '' ? failure.message : `${failure.path}: ${failure.message}`,
              )
              .join(' ') || 'The note changes could not be undone.',
          )
        }
      } finally {
        pending.delete(operation)
        if (pending.size === 0) {
          pendingChangeOperationsRef.current.delete(conversation)
        }
        changeBusyRef.current = false
        setChangeBusy(false)
      }
    },
    [changeService, refreshTurnChanges],
  )

  const undoTurnChanges = useCallback(
    async (turnId: string): Promise<void> => await runUndo(turnId, null),
    [runUndo],
  )

  const undoNoteChanges = useCallback(
    async (turnId: string, path: string): Promise<void> => await runUndo(turnId, path),
    [runUndo],
  )

  const value = useMemo<ChatContextValue>(
    () => ({
      turns,
      status,
      providers,
      modelOptions,
      activeModel,
      selectModel,
      permissionMode,
      setPermissionMode: updatePermissionMode,
      changesByTurn,
      undoTurnChanges,
      undoNoteChanges,
      draft,
      setDraft,
      attachments,
      attachImages,
      removeAttachment,
      send,
      stop,
      newChat,
      activeConversationId: conversationId,
      openConversation,
      deleteConversation,
    }),
    [
      turns,
      status,
      providers,
      modelOptions,
      activeModel,
      selectModel,
      permissionMode,
      updatePermissionMode,
      changesByTurn,
      undoTurnChanges,
      undoNoteChanges,
      draft,
      attachments,
      attachImages,
      removeAttachment,
      send,
      stop,
      newChat,
      conversationId,
      openConversation,
      deleteConversation,
    ],
  )
  return <ChatContext value={value}>{children}</ChatContext>
}
