import { useEffect, useLayoutEffect, useRef } from 'react'
import type { NavigateOptions, Route } from '@reflect/app'
import {
  focusedEditorCommands,
  useFormattingToolbar,
  type FormattingToolbarCommands,
} from '@/editor/formatting-toolbar-store.ts'
import { useStore } from '@/lib/use-store.ts'
import type { MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import {
  buildNoChromeState,
  buildShellChromeState,
} from '@/mobile/native-chrome/native-chrome-state.ts'
import {
  parseNativeIntent,
  type FormattingCommandId,
  type NativeChromeMessage,
  type NativeIntent,
} from '@/mobile/native-chrome/protocol.ts'
import {
  nativeBarHandlers,
  nativeBars,
  nativeModalCount,
} from '@/mobile/native-chrome/registrations.ts'
import { useThemeSetting } from '@/providers/settings-provider.tsx'
import { useRouterActions, useRouterState } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * What an intent needs from the page when it runs.
 */
export interface IntentContext {
  entryId: number
  canBack: boolean
  back: () => void
  navigate: (route: Route, options?: NavigateOptions) => void
  selectTab: (tab: MobileTab) => void
  /**
   * The commands of the last focused editor that can attach files, while
   * the page still shows its entry.
   */
  attachCommands: FormattingToolbarCommands | null
}

const FORMATTING_RUNNERS: Record<
  FormattingCommandId,
  (commands: FormattingToolbarCommands) => void
> = {
  slash: (commands) => commands.insertTrigger('/'),
  list: (commands) => commands.cycleBulletOrderedList(),
  todo: (commands) => commands.cycleCheckableList(),
  link: (commands) => commands.insertTrigger('[['),
  tag: (commands) => commands.insertTrigger('#'),
  dedent: (commands) => commands.dedent(),
  indent: (commands) => commands.indent(),
  up: (commands) => commands.moveUp(),
  down: (commands) => commands.moveDown(),
  dismiss: (commands) => commands.dismissKeyboard(),
}

/**
 * Run a formatting command on the focused editor.
 */
function runFormattingCommand(id: FormattingCommandId): void {
  const commands = focusedEditorCommands()
  if (commands !== null) {
    FORMATTING_RUNNERS[id](commands)
  }
}

function decodeFile(file: { name: string; type: string; data: string }): File {
  const binary = atob(file.data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new File([bytes], file.name, { type: file.type })
}

/**
 * Run one intent of the shell. An intent for another history entry than the
 * one on screen is dropped, so a menu left open while the page changed never
 * acts on the new page.
 */
export function runNativeIntent(intent: NativeIntent, context: IntentContext): void {
  switch (intent.type) {
    case 'back': {
      if (intent.entryId !== context.entryId) {
        return
      }
      const onBack = nativeBarHandlers(intent.entryId)?.onBack
      if (onBack !== undefined) {
        onBack()
      } else if (context.canBack) {
        context.back()
      } else {
        context.navigate({ kind: 'today' })
      }
      return
    }
    case 'tab':
      context.selectTab(intent.tab)
      return
    case 'action':
      if (intent.entryId === context.entryId) {
        nativeBarHandlers(intent.entryId)?.onAction(intent.id)
      }
      return
    case 'command':
      runFormattingCommand(intent.id)
      return
    case 'files': {
      const commands = context.attachCommands
      if (commands !== null) {
        attachQueue = attachAfter(attachQueue, commands, intent.files.map(decodeFile))
      }
      return
    }
  }
}

/**
 * The inserts of earlier `files` intents. The shell sends one intent per
 * picked image, so each insert waits for the one before it and the images
 * land in the picked order.
 */
let attachQueue: Promise<void> = Promise.resolve()

async function attachAfter(
  previous: Promise<void>,
  commands: FormattingToolbarCommands,
  files: File[],
): Promise<void> {
  await previous
  try {
    await commands.attachFiles(files)
  } catch (cause) {
    // Reported like an uncaught error; the queue stays settled for the next insert.
    reportError(cause)
  }
}

interface NativeChromeProjectionProps {
  tab: MobileTab
  keyboardVisible: boolean
  onSelectTab: (tab: MobileTab) => void
}

/**
 * Posts the routed shell's chrome state to the Swift shell after every change
 * and runs the shell's intents. Renders nothing; a no-op when the shell draws
 * no chrome.
 */
export function NativeChromeProjection({
  tab,
  keyboardVisible,
  onSelectTab,
}: NativeChromeProjectionProps): null {
  const { route, entryId, canBack } = useRouterState()
  const { back, navigate } = useRouterActions()
  const bars = useStore(nativeBars)
  const modalCount = useStore(nativeModalCount)
  const toolbar = useFormattingToolbar()
  const theme = useThemeSetting()
  const { nativeChrome } = useAppServices()
  const enabled = nativeChrome.enabled

  useEffect(() => {
    if (!enabled) {
      return
    }
    nativeChrome.postState(
      buildShellChromeState({
        route,
        entryId,
        tab,
        // The store, not the render's `bars`: a new screen registers its bar
        // in a layout effect of this commit, after this component rendered.
        bar: nativeBars.get().get(entryId),
        keyboardVisible,
        modal: modalCount > 0,
        toolbar: toolbar?.capabilities ?? null,
        theme,
      }),
    )
  }, [
    enabled,
    nativeChrome,
    route,
    entryId,
    tab,
    bars,
    keyboardVisible,
    modalCount,
    toolbar,
    theme,
  ])

  // Kept while the photo picker holds focus, so the editor's toolbar is gone.
  const attachRef = useRef<{ commands: FormattingToolbarCommands; entryId: number } | null>(null)
  useLayoutEffect(() => {
    if (toolbar?.capabilities.canAttachFiles === true) {
      attachRef.current = { commands: toolbar.commands, entryId }
    }
  }, [toolbar, entryId])

  const contextRef = useRef<Omit<IntentContext, 'attachCommands'>>({
    entryId,
    canBack,
    back,
    navigate,
    selectTab: onSelectTab,
  })
  useLayoutEffect(() => {
    contextRef.current = { entryId, canBack, back, navigate, selectTab: onSelectTab }
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    const unlisten = nativeChrome.listenIntent((payload) => {
      const intent = parseNativeIntent(payload)
      if (intent !== null) {
        const attach = attachRef.current
        const context = contextRef.current
        runNativeIntent(intent, {
          ...context,
          attachCommands: attach?.entryId === context.entryId ? attach.commands : null,
        })
      }
    })
    nativeChrome.post({ type: 'chromeReady' } satisfies NativeChromeMessage)
    return unlisten
  }, [enabled, nativeChrome])

  return null
}

/**
 * Tells the Swift shell that the page shows a surface outside the shell, so
 * it shows no native bars.
 */
export function NativeChromeOff(): null {
  const theme = useThemeSetting()
  const { nativeChrome } = useAppServices()
  useEffect(() => {
    if (nativeChrome.enabled) {
      nativeChrome.postState(buildNoChromeState(theme))
    }
  }, [nativeChrome, theme])
  return null
}
