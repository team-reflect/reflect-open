import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { useToastController } from '@/lib/use-toasts.ts'
import type {
  PendingReplacementResolveHandler,
  SelectionMenuContext,
  SelectionMenuItem,
  SelectionMenuSearchHandler,
} from '@meowdown/react'
import {
  chatModelOptions,
  filterAiPrompts,
  type AiPrompt,
  type AiPromptMode,
  type ChatModelOption,
} from '@reflect/core'
import { AiPreviewActions } from '@/editor/ai-menu/ai-preview-actions.tsx'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import { useAiPrompts } from '@/hooks/use-ai-prompts.ts'
import { useAiProviders } from '@/hooks/use-ai-providers.ts'
import { useRouterActions } from '@/routing/router.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

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
  /** The note's `private: true` flag, as its session holds it. */
  isPrivate: boolean
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

/**
 * Runs `callback` for each value of `iterable` and stops when it returns
 * `false`. React Compiler cannot compile a `for await` loop and skips any
 * component or hook that contains one, so the loop lives in this module-level
 * function, which the compiler does not touch.
 */
async function forEachAsync<T>(
  iterable: AsyncIterable<T>,
  callback: (value: T) => boolean | void,
): Promise<void> {
  for await (const value of iterable) {
    if (callback(value) === false) return
  }
}

export function useEditorAiMenu({
  path,
  isPrivate,
  editorRef,
}: EditorAiMenuOptions): EditorAiMenuValue {
  const toastController = useToastController()
  const { providers } = useAiProviders()
  const { selectionTransform } = useCoreServices()
  const { prompts } = useAiPrompts()
  const { navigate } = useRouterActions()

  const runRef = useRef<ActiveRun | null>(null)
  // The staged placement of the current run — state (not just the ref) so the
  // preview's alternate-placement button can label itself.
  const [runMode, setRunMode] = useState<AiPromptMode | null>(null)

  // A run belongs to one editor: unmounting mid-stream (the pane mounts one
  // editor per session) aborts the provider call and drops the run, so a stale
  // stream can never append into — or Retry restage ranges against — a
  // different document.
  useEffect(() => {
    return () => {
      runRef.current?.controller.abort()
      runRef.current = null
    }
  }, [])

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
        toastController.add({ type: 'error', title: message })
      }

      // The service picks the provider, gates the selection against the
      // note's privacy flag, and reads the key; each refusal arrives as an
      // `error` event before any provider call.
      const events = selectionTransform.transform({
        note: { path, isPrivate },
        selectedText: context.selectedText,
        promptBody: prompt.body,
        model: modelOverride,
        signal: run.controller.signal,
      })
      await forEachAsync(events, (event) => {
        if (runRef.current !== run) return false
        if (event.type === 'text-delta') {
          editorRef.current?.appendPendingReplacementText(event.text)
        } else if (event.type === 'error') {
          fail(event.message)
          return false
        }
        // 'complete' and 'aborted' need no action: the preview holds the text
        // and the user decides with Accept/Discard.
      })
    },
    [selectionTransform, path, isPrivate, editorRef, toastController],
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
    if (isPrivate) return
    return (query: string): SelectionMenuItem[] => {
      if (providers.length === 0) {
        return [
          {
            id: 'configure-provider',
            label: 'Add an AI provider in Settings…',
            onSelect: () => navigate({ kind: 'settings', page: 'main' }),
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
          onSelect: (context) => {
            runPrompt({ id: 'ad-hoc-query', label: adHoc, body: adHoc, mode: 'replace' }, context)
          },
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
      if (
        !editor.startPendingReplacement({ from: context.from, to: context.to, mode: prompt.mode })
      ) {
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
