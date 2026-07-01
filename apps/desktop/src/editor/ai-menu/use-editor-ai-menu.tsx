import { useCallback, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { toast } from 'sonner'
import type {
  PendingReplacementResolveHandler,
  SelectionMenuContext,
  SelectionMenuItem,
  SelectionMenuSearchHandler,
} from '@meowdown/react'
import {
  aiKeySecretName,
  chatModelOptions,
  cloudSafeSelection,
  filterAiPrompts,
  getSecret,
  isPrivateNoteError,
  transformSelection,
  type AiPrompt,
  type ChatModelOption,
  type CloudSafe,
} from '@reflect/core'
import { AiRetryActions } from '@/editor/ai-menu/ai-retry-actions'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { useAiPrompts } from '@/hooks/use-ai-prompts'
import { useAiProviders } from '@/hooks/use-ai-providers'
import { useNoteRow } from '@/hooks/use-note-row'
import { providerFetch } from '@/lib/provider-fetch'
import { useRouter } from '@/routing/router'

/**
 * The editor AI menu (the "run a prompt on the selection" flow): meowdown owns
 * the selection menu and the pending-replacement preview; this hook owns
 * Reflect's policy — the prompt list (built-ins + saved), the privacy gate, the
 * provider call, and the retry control. Nothing is written to the note until
 * the user accepts the preview; a discarded run leaves the file byte-identical.
 */

interface EditorAiMenuOptions {
  /** Graph-relative path of the note being edited (the privacy subject). */
  path: string
  /** The mounted editor's handle (staging, streaming, and accept live there). */
  editorRef: RefObject<NoteEditorHandle | null>
}

export interface EditorAiMenuValue {
  /**
   * meowdown's menu source, or undefined for a `private: true` note — with no
   * handler meowdown renders neither the menu nor the selection affordance,
   * so a private note's selection has no AI entry point at all.
   */
  onSelectionMenuSearch: SelectionMenuSearchHandler | undefined
  /** The retry control rendered in the preview footer. */
  pendingReplacementActions: ReactNode
  /** Stops the in-flight stream when the preview is accepted or discarded. */
  onPendingReplacementResolve: PendingReplacementResolveHandler
  /** The ⌘⇧J trigger; returns whether it consumed the key. */
  openMenu: () => boolean
}

/** One in-flight (or previewed) transform, kept for retry. */
interface ActiveRun {
  controller: AbortController
  prompt: AiPrompt
  context: SelectionMenuContext
}

export function useEditorAiMenu({ path, editorRef }: EditorAiMenuOptions): EditorAiMenuValue {
  const noteRow = useNoteRow(path)
  const isPrivate = noteRow?.isPrivate ?? false
  const { providers, defaultProvider } = useAiProviders()
  const { prompts } = useAiPrompts()
  const { navigate } = useRouter()

  const runRef = useRef<ActiveRun | null>(null)

  const streamRun = useCallback(
    async (
      prompt: AiPrompt,
      context: SelectionMenuContext,
      modelOverride: ChatModelOption | null,
    ): Promise<void> => {
      runRef.current?.controller.abort()
      const run: ActiveRun = { controller: new AbortController(), prompt, context }
      runRef.current = run

      const fail = (message: string): void => {
        editorRef.current?.discardPendingReplacement()
        toast.error(message)
      }

      const base =
        modelOverride === null
          ? defaultProvider
          : providers.find((entry) => entry.id === modelOverride.configId) ?? null
      if (base === null) {
        fail('Add an AI provider in Settings to use AI prompts.')
        return
      }
      const config = modelOverride === null ? base : { ...base, model: modelOverride.modelId }

      // The privacy gate: the selection is note content, so it only leaves the
      // device as a CloudSafe value minted against the note's privacy flag.
      let selection: CloudSafe<string>
      try {
        selection = cloudSafeSelection({ path, isPrivate }, context.selectedText)
      } catch (cause) {
        if (isPrivateNoteError(cause)) {
          fail('This note is marked private, so its content is never sent to an AI provider.')
          return
        }
        throw cause
      }

      const apiKey = await getSecret(aiKeySecretName(config.id)).catch(() => null)
      if (runRef.current !== run) return
      if (apiKey === null) {
        fail('No API key found for this provider — re-add it in Settings → AI providers.')
        return
      }

      const events = transformSelection({
        config,
        apiKey,
        fetchFn: providerFetch,
        promptBody: prompt.body,
        selection,
        signal: run.controller.signal,
      })
      for await (const event of events) {
        if (runRef.current !== run) return
        if (event.type === 'text-delta') {
          editorRef.current?.appendPendingReplacementText(event.text)
        } else if (event.type === 'error') {
          fail(event.message)
        }
        // 'complete' and 'aborted' need no action: the preview holds the text
        // and the user decides with Accept/Discard.
      }
    },
    [providers, defaultProvider, path, isPrivate, editorRef],
  )

  const runPrompt = useCallback(
    (prompt: AiPrompt, context: SelectionMenuContext): void => {
      const editor = editorRef.current
      if (!editor) return
      const started = editor.startPendingReplacement({
        from: context.from,
        to: context.to,
        mode: prompt.mode,
      })
      if (!started) return
      void streamRun(prompt, context, null)
    },
    [editorRef, streamRun],
  )

  const onSelectionMenuSearch = useMemo<SelectionMenuSearchHandler | undefined>(() => {
    if (isPrivate) return undefined
    return (query: string): SelectionMenuItem[] => {
      if (providers.length === 0) {
        return [
          {
            id: 'configure-provider',
            label: 'Add an AI provider in Settings…',
            onSelect: () => navigate({ kind: 'settings' }),
          },
        ]
      }
      return filterAiPrompts(prompts, query).map((prompt) => ({
        id: prompt.id,
        label: prompt.label,
        onSelect: (context) => runPrompt(prompt, context),
      }))
    }
  }, [isPrivate, providers.length, prompts, navigate, runPrompt])

  const retry = useCallback(
    (option: ChatModelOption | null): void => {
      const run = runRef.current
      const editor = editorRef.current
      if (!run || !editor) return
      // Restaging the same range resets the accumulated text without ending
      // the stage, so the preview stays up while the new attempt streams.
      const { prompt, context } = run
      if (!editor.startPendingReplacement({ from: context.from, to: context.to, mode: prompt.mode })) {
        return
      }
      void streamRun(prompt, context, option)
    },
    [editorRef, streamRun],
  )

  const pendingReplacementActions = useMemo<ReactNode>(
    () => <AiRetryActions modelOptions={chatModelOptions(providers)} onRetry={retry} />,
    [providers, retry],
  )

  const onPendingReplacementResolve = useCallback<PendingReplacementResolveHandler>(() => {
    runRef.current?.controller.abort()
    runRef.current = null
  }, [])

  const openMenu = useCallback((): boolean => {
    if (isPrivate) return false
    editorRef.current?.openSelectionMenu()
    return true
  }, [isPrivate, editorRef])

  return { onSelectionMenuSearch, pendingReplacementActions, onPendingReplacementResolve, openMenu }
}
