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
  postChromeState,
} from '@/mobile/native-chrome/native-chrome-state.ts'
import { parseNativeIntent, type NativeIntent } from '@/mobile/native-chrome/protocol.ts'
import {
  nativeBarHandlers,
  nativeBars,
  nativeMenuHandler,
  nativeModalCount,
} from '@/mobile/native-chrome/registrations.ts'
import { useThemeSetting } from '@/providers/settings-provider.tsx'
import { useRouterActions, useRouterState } from '@/routing/router.tsx'
import {
  hasAnyNativeChrome,
  listenNativeIntent,
  postNativeChrome,
} from '@/services/native-chrome-transport.ts'

/**
 * What an intent needs from the page when it runs.
 */
export interface IntentContext {
  entryId: number
  canBack: boolean
  back: () => void
  navigate: (route: Route, options?: NavigateOptions) => void
  selectTab: (tab: MobileTab) => void
  /** The commands of the last focused editor that can attach files. */
  attachCommands: FormattingToolbarCommands | null
}

/**
 * Run a formatting command on the focused editor.
 */
function runFormattingCommand(id: string): void {
  const commands = focusedEditorCommands()
  if (commands === null) {
    return
  }
  switch (id) {
    case 'slash':
      commands.insertTrigger('/')
      return
    case 'list':
      commands.cycleBulletOrderedList()
      return
    case 'todo':
      commands.cycleCheckableList()
      return
    case 'link':
      commands.insertTrigger('[[')
      return
    case 'tag':
      commands.insertTrigger('#')
      return
    case 'dedent':
      commands.dedent()
      return
    case 'indent':
      commands.indent()
      return
    case 'up':
      commands.moveUp()
      return
    case 'down':
      commands.moveDown()
      return
    case 'dismiss':
      commands.dismissKeyboard()
      return
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
    case 'menu':
      if (intent.entryId === context.entryId) {
        nativeMenuHandler(intent.menuId, intent.entryId)?.(intent.id)
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
  try {
    await previous
  } catch {
    // The failed insert surfaced as an unhandled rejection; this one goes on.
  }
  await commands.attachFiles(files)
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
  const enabled = hasAnyNativeChrome()

  useEffect(() => {
    if (!enabled) {
      return
    }
    postChromeState(
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
  }, [enabled, route, entryId, tab, bars, keyboardVisible, modalCount, toolbar, theme])

  const attachCommandsRef = useRef<FormattingToolbarCommands | null>(null)
  useLayoutEffect(() => {
    if (toolbar?.capabilities.canAttachFiles === true) {
      attachCommandsRef.current = toolbar.commands
    }
  }, [toolbar])

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
    const unlisten = listenNativeIntent((payload) => {
      const intent = parseNativeIntent(payload)
      if (intent !== null) {
        runNativeIntent(intent, {
          ...contextRef.current,
          attachCommands: attachCommandsRef.current,
        })
      }
    })
    postNativeChrome({ type: 'chromeReady' })
    return unlisten
  }, [enabled])

  return null
}

/**
 * Tells the Swift shell that the page shows a surface outside the shell, so
 * it shows no native bars.
 */
export function NativeChromeOff(): null {
  const theme = useThemeSetting()
  useEffect(() => {
    if (hasAnyNativeChrome()) {
      postChromeState(buildNoChromeState(theme))
    }
  }, [theme])
  return null
}
