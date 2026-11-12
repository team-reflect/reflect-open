import { useEffect, useLayoutEffect, useRef } from 'react'
import type { NativeChromeService } from '@reflect/app'
import { WritableStore, type Unlisten } from '@reflect/core'
import {
  useFormattingToolbar,
  type FormattingToolbarCommands,
} from '@/editor/formatting-toolbar-store.ts'
import { useStore } from '@/lib/use-store.ts'
import {
  useChromeRenderer,
  type ChromeRenderer,
  type ShellBarsProps,
  type StackMotion,
} from '@/mobile/chrome/chrome-renderer.ts'
import { ScreenRegistry } from '@/mobile/chrome/native/screen-registry.ts'
import type { ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import {
  createAttachQueue,
  runNativeIntent,
  type IntentContext,
} from '@/mobile/native-chrome/native-chrome-intents.ts'
import {
  buildNoChromeState,
  buildShellChromeState,
} from '@/mobile/native-chrome/native-chrome-state.ts'
import { parseNativeIntent, type NativeChromeMessage } from '@/mobile/native-chrome/protocol.ts'
import { useThemeSetting } from '@/providers/settings-provider.tsx'
import { useRouterActions, useRouterState } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * The chrome the Swift shell draws: the page posts its state and runs the
 * shell's intents.
 */
class NativeChromeRenderer implements ChromeRenderer {
  readonly ShellBars = NativeShellBars
  readonly NoChrome = NativeNoChrome
  readonly screens = new ScreenRegistry()
  /**
   * How many web drawers are open. The shell hides its bars while one is.
   */
  readonly modalCount = new WritableStore(0)
  readonly attachFiles = createAttachQueue()
  readonly #nativeChrome: NativeChromeService

  constructor(nativeChrome: NativeChromeService) {
    this.#nativeChrome = nativeChrome
  }

  registerScreen(entryId: number, chrome: { readonly current: ScreenChrome }): Unlisten {
    return this.screens.register(entryId, chrome)
  }

  updateScreen(entryId: number): void {
    this.screens.update(entryId)
  }

  openModal(): Unlisten {
    this.modalCount.set(this.modalCount.get() + 1)
    return () => {
      this.modalCount.set(this.modalCount.get() - 1)
    }
  }

  reportStackMotion(motion: StackMotion): void {
    this.#nativeChrome.post(motion satisfies NativeChromeMessage)
  }
}

/**
 * The renderer for the shell that `nativeChrome` talks to.
 */
export function createNativeChromeRenderer(nativeChrome: NativeChromeService): ChromeRenderer {
  return new NativeChromeRenderer(nativeChrome)
}

function useNativeChromeRenderer(): NativeChromeRenderer {
  const renderer = useChromeRenderer()
  if (!(renderer instanceof NativeChromeRenderer)) {
    throw new TypeError('The native chrome renders only under its own renderer')
  }
  return renderer
}

/**
 * Posts the routed shell's chrome state to the Swift shell after every change
 * and runs the shell's intents. Renders nothing.
 */
function NativeShellBars({ tab, keyboardVisible, onSelectTab }: ShellBarsProps): null {
  const renderer = useNativeChromeRenderer()
  const { route, entryId, canBack } = useRouterState()
  const { back, navigate } = useRouterActions()
  const bars = useStore(renderer.screens.bars)
  const modalCount = useStore(renderer.modalCount)
  const toolbar = useFormattingToolbar()
  const theme = useThemeSetting()
  const { nativeChrome } = useAppServices()

  useEffect(() => {
    nativeChrome.postState(
      buildShellChromeState({
        route,
        entryId,
        tab,
        // The store, not the render's `bars`: a new screen registers its bar
        // in a layout effect of this commit, after this component rendered.
        bar: renderer.screens.bars.get().get(entryId),
        keyboardVisible,
        modal: modalCount > 0,
        toolbar: toolbar?.capabilities ?? null,
        theme,
      }),
    )
  }, [
    nativeChrome,
    renderer,
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

  const contextRef = useRef<
    Pick<IntentContext, 'entryId' | 'canBack' | 'back' | 'navigate' | 'selectTab'>
  >({
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
    const unlisten = nativeChrome.listenIntent((payload) => {
      const intent = parseNativeIntent(payload)
      if (intent !== null) {
        const attach = attachRef.current
        const context = contextRef.current
        runNativeIntent(intent, {
          ...context,
          screen: renderer.screens.chrome(context.entryId),
          attachCommands: attach?.entryId === context.entryId ? attach.commands : null,
          attachFiles: renderer.attachFiles,
        })
      }
    })
    nativeChrome.post({ type: 'chromeReady' } satisfies NativeChromeMessage)
    return unlisten
  }, [nativeChrome, renderer])

  return null
}

/**
 * Tells the Swift shell that the page shows a surface outside the shell, so
 * it shows no native bars.
 */
function NativeNoChrome(): null {
  const theme = useThemeSetting()
  const { nativeChrome } = useAppServices()
  useEffect(() => {
    nativeChrome.postState(buildNoChromeState(theme))
  }, [nativeChrome, theme])
  return null
}
