import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { toast } from 'sonner'
import type {
  PendingReplacementResolveHandler,
  SelectionMenuContext,
  SelectionMenuItem,
  SelectionMenuSearchHandler,
} from '@meowdown/react'
import {
  aiApiKeyForConfig,
  chatModelOptions,
  cloudSafeSelection,
  filterAiPrompts,
  isPrivateNoteError,
  transformSelection,
  type AiPrompt,
  type AiPromptMode,
  type ChatModelOption,
  type CloudSafe,
} from '@reflect/core'
import { AiPreviewActions } from '@/editor/ai-menu/ai-preview-actions'
import type { NoteEditorHandle } from '@/editor/note-editor'
import { useAiPrompts } from '@/hooks/use-ai-prompts'
import { useAiProviders } from '@/hooks/use-ai-providers'
import { useNoteRow } from '@/hooks/use-note-row'
import { providerFetch } from '@/lib/provider-fetch'
import { useRouter } from '@/routing/router'

/**
 * The editor AI menu (the "run a prompt on the selection" flow): meowdown owns
 * the selection menu and the pending-replacement preview; this hook owns
 * Reflect's policy — the prompt list (saved + built-ins), the privacy gate, the
 * provider call, and the preview controls. Nothing is written to the note until
 * the user accepts the preview; a discarded run leaves the file byte-identical.
 */

interface EditorAiMenuOptions {
  /** Graph-relative path of the note being edited (the privacy subject). */
  path: string
  /**
   * The editor-session identity (`useNoteDocument().sessionEpoch`) — bumps
   * when a new session is created, not when a rename retargets one, so a
   * title-driven rename never tears down a run under its live preview.
   */
  sessionEpoch: number
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

export function useEditorAiMenu({
  path,
  sessionEpoch,
  editorRef,
}: EditorAiMenuOptions): EditorAiMenuValue {
  const noteRow = useNoteRow(path)
  // The last privacy flag this session resolved, adjusted during render (the
  // note-pane seed pattern). A title-driven rename retargets the same note
  // under a new path (Plan 17), and the new path's row query starts empty —
  // the previous flag stays authoritative for that beat, so a Retry mid-
  // rename doesn't misreport a public note as private.
  const [resolvedPrivacy, setResolvedPrivacy] = useState<{
    epoch: number
    isPrivate: boolean
  } | null>(null)
  if (
    noteRow !== null &&
    (resolvedPrivacy?.epoch !== sessionEpoch || resolvedPrivacy.isPrivate !== noteRow.isPrivate)
  ) {
    setResolvedPrivacy({ epoch: sessionEpoch, isPrivate: noteRow.isPrivate })
  }
  // Fail closed: with no row resolved in this session yet, the note counts as
  // private, so the menu (and the CloudSafe mint below) never treats a
  // not-yet-loaded note as sendable. The row is overlay-backed, so an in-app
  // "Mark as private" flips this immediately; only an external edit waits on
  // the watcher's re-index.
  const isPrivate =
    noteRow?.isPrivate ??
    (resolvedPrivacy?.epoch === sessionEpoch ? resolvedPrivacy.isPrivate : true)
  const { providers, defaultProvider } = useAiProviders()
  const { prompts } = useAiPrompts()
  const { navigate } = useRouter()

  const runRef = useRef<ActiveRun | null>(null)
  // The staged placement of the current run — state (not just the ref) so the
  // preview's alternate-placement button can label itself.
  const [runMode, setRunMode] = useState<AiPromptMode | null>(null)

  // A run belongs to one editor session: switching notes (or unmounting)
  // mid-stream aborts the provider call and drops the run, so a stale stream
  // can never append into — or Retry restage ranges against — a different
  // document. Keyed on the session, not the path: a title-driven rename
  // retargets the live session (Plan 17) and must keep the run alive under
  // its still-visible preview.
  useEffect(() => {
    return () => {
      runRef.current?.controller.abort()
      runRef.current = null
      setRunMode(null)
    }
  }, [sessionEpoch])

  const streamRun = useCallback(
    async (
      prompt: AiPrompt,
      context: SelectionMenuContext,
      modelOverride: ChatModelOption | null,
    ): Promise<void> => {
      runRef.current?.controller.abort()
      const run: ActiveRun = { controller: new AbortController(), prompt, context }
      runRef.current = run

      // Failing tears the whole run down, not just the preview: the discard
      // usually triggers the resolve callback's cleanup, but when the stage is
      // already gone (or never staged) this path must not leave a live run.
      const fail = (message: string): void => {
        run.controller.abort()
        if (runRef.current === run) {
          runRef.current = null
          setRunMode(null)
        }
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

      const apiKey = await aiApiKeyForConfig(config)
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
          return
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
      setRunMode(prompt.mode)
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
      const items: SelectionMenuItem[] = filterAiPrompts(prompts, query).map((prompt) => ({
        id: prompt.id,
        label: prompt.label,
        onSelect: (context) => runPrompt(prompt, context),
      }))
      // Old Reflect's "Ask anything to AI": the typed text itself runs as a
      // one-off prompt, with the selection appended as fenced context.
      const adHoc = query.trim()
      if (adHoc) {
        items.push({
          id: 'ad-hoc-query',
          label: adHoc,
          detail: 'Run as a prompt',
          onSelect: (context) =>
            runPrompt({ id: 'ad-hoc-query', label: adHoc, body: adHoc, mode: 'replace' }, context),
        })
      }
      return items
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

  const acceptAs = useCallback(
    (mode: AiPromptMode): void => {
      editorRef.current?.acceptPendingReplacement({ mode })
      editorRef.current?.focus()
    },
    [editorRef],
  )

  const pendingReplacementActions = useMemo<ReactNode>(
    () => (
      <AiPreviewActions
        mode={runMode}
        modelOptions={chatModelOptions(providers)}
        onRetry={retry}
        onAcceptAs={acceptAs}
      />
    ),
    [runMode, providers, retry, acceptAs],
  )

  const onPendingReplacementResolve = useCallback<PendingReplacementResolveHandler>(() => {
    runRef.current?.controller.abort()
    runRef.current = null
    setRunMode(null)
  }, [])

  const openMenu = useCallback((): boolean => {
    const editor = editorRef.current
    // Only consume the key when the menu can actually open — a private note
    // or an empty selection lets ⌘⇧J fall through.
    if (isPrivate || !editor || editor.getSelectedText() === '') return false
    editor.openSelectionMenu()
    return true
  }, [isPrivate, editorRef])

  return { onSelectionMenuSearch, pendingReplacementActions, onPendingReplacementResolve, openMenu }
}
