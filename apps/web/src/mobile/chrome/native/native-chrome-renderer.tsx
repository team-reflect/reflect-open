import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactElement } from 'react'
import type { NativeChromeService } from '@reflect/app'
import { WritableStore, type Unlisten } from '@reflect/core'
import {
  useFormattingToolbar,
  type FormattingToolbarCommands,
} from '@/editor/formatting-toolbar-store.ts'
import { useStore } from '@/lib/use-store.ts'
import { useToastController } from '@/lib/use-toasts.ts'
import {
  useChromeRenderer,
  type ChromeRenderer,
  type ShellBarsProps,
  type StackMotion,
  type TopBarCornerProps,
} from '@/mobile/chrome/chrome-renderer.ts'
import { ScreenRegistry } from '@/mobile/chrome/native/screen-registry.ts'
import type { ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import { WebTopBarCorner } from '@/mobile/chrome/web/web-top-bar-corner.tsx'
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
import { useRouterState } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * The chrome the Swift shell draws: the page posts its state and runs the
 * shell's intents.
 */
class NativeChromeRenderer implements ChromeRenderer {
  readonly TopBarCorner = NativeTopBarCorner
  readonly ShellBars = NativeShellBars
  readonly NoChrome = NativeNoChrome
  // The native bars sit in the safe area, so the page clears it.
  readonly shellStyle = {
    '--chrome-bottom-bar': '0px',
    '--chrome-safe-bottom': 'var(--twsa-safe-area-inset-bottom)',
  } as CSSProperties
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
 * The space of the corner buttons and the back button that the shell draws
 * over the bar. The shell's back button is wider than the web one, so a
 * title that starts after it moves clear.
 */
function NativeTopBarCorner(props: TopBarCornerProps): ReactElement {
  return (
    <div className="invisible contents" inert aria-hidden>
      <WebTopBarCorner {...props} backClassName={props.align === 'start' ? 'mr-2' : undefined} />
    </div>
  )
}

/**
 * Posts the routed shell's chrome state to the Swift shell after every change
 * and runs the shell's intents. Renders nothing.
 */
function NativeShellBars({ tab, keyboardVisible, onSelectTab }: ShellBarsProps): null {
  const renderer = useNativeChromeRenderer()
  const { route, entryId } = useRouterState()
  const bars = useStore(renderer.screens.bars)
  const modalCount = useStore(renderer.modalCount)
  const toolbar = useFormattingToolbar()
  const theme = useThemeSetting()
  const { nativeChrome } = useAppServices()
  const toasts = useToastController()

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
        modal: modalCount > 0, // FIXME: If we have models come in, like two or four, we would call this useEffect multiple times, right? Maybe we can use a variable like 'hasModel', which is true or false. We only monitor this 'hasModel' variable in this useEffect, and we can avoid some kind of re-rendering.
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

  const contextRef = useRef<Pick<IntentContext, 'entryId' | 'selectTab'>>({
    entryId,
    selectTab: onSelectTab,
  })
  useLayoutEffect(() => {
    contextRef.current = { entryId, selectTab: onSelectTab }
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
          toasts,
        })
      }
    })
    nativeChrome.post({ type: 'chromeReady' } satisfies NativeChromeMessage)
    return unlisten
  }, [nativeChrome, renderer, toasts])

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
