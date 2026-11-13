import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  type CSSProperties,
  type ReactElement,
} from 'react'
import { isDeepEqual, returnNull } from '@ocavue/utils'
import type { NativeChromeService } from '@reflect/app'
import { deriveStore, WritableStore, type Unlisten } from '@reflect/core'
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
import type { ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import { WebTopBarCorner } from '@/mobile/chrome/web/web-top-bar-corner.tsx'
import {
  createAttachQueue,
  runNativeIntent,
  type IntentContext,
} from '@/mobile/chrome/native/native-chrome-intents.ts'
import {
  buildNoChromeState,
  buildShellChromeState,
  toWirePlus,
  type ScreenBar,
} from '@/mobile/chrome/native/native-chrome-state.ts'
import { toWireMenu } from '@/mobile/chrome/native/sf-symbols.ts'
import {
  parseNativeIntent,
  type NativeChromeMessage,
  type NativeSidebarState,
} from '@/mobile/chrome/native/protocol.ts'
import { sidebarVisible, useSidebar } from '@/mobile/sidebar.ts'
import { useThemeSetting } from '@/providers/settings-provider.tsx'
import { useRouterState } from '@/routing/router.tsx'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * The chrome the Swift shell draws: the page posts its state and runs the
 * shell's intents.
 */
class NativeChromeRenderer implements ChromeRenderer {
  readonly #nativeChrome: NativeChromeService
  readonly #screens = new Map<number, { readonly current: ScreenChrome }>()
  /**
   * How many web drawers are open.
   */
  readonly #modalCount = new WritableStore(0)
  readonly TopBarCorner = NativeTopBarCorner
  readonly ShellBars = NativeShellBars
  // The shell draws the `+` that `registerScreen` snapshots.
  readonly Plus = returnNull
  readonly NoChrome = NativeNoChrome
  /**
   * A snapshot of the bar of every registered screen, keyed by the history
   * entry the screen shows. A screen kept mounted under a stacked card keeps
   * its own entry, so the shell always gets the bar of the entry on screen.
   */
  readonly bars = new WritableStore<ReadonlyMap<number, ScreenBar>>(new Map(), isDeepEqual)
  /**
   * Whether a web drawer is open. The shell hides its bars while one is.
   */
  readonly modal = deriveStore(this.#modalCount, (count) => count > 0)
  /**
   * Whether the shell draws the corner buttons in the page's header row. On
   * an iPad with the tab bar at the top, they sit in the tab bar's row.
   */
  readonly cornersInHeaderRow = new WritableStore(true)
  readonly attachFiles = createAttachQueue()

  constructor(nativeChrome: NativeChromeService) {
    this.#nativeChrome = nativeChrome
  }

  registerScreen(entryId: number, chrome: { readonly current: ScreenChrome }): Unlisten {
    this.#screens.set(entryId, chrome)
    const { back, leading, trailing, plus } = chrome.current
    // A copy, so an in-place change of the screen's buttons is a change.
    const bar = structuredClone({
      canBack: back !== undefined,
      leading: leading ?? [],
      trailing: trailing ?? [],
      plus: plus === undefined ? null : toWirePlus(plus),
    })
    this.#updateBars((bars) => {
      bars.set(entryId, bar)
    })
    return () => {
      if (this.#screens.get(entryId) !== chrome) {
        return
      }
      this.#screens.delete(entryId)
      this.#updateBars((bars) => {
        bars.delete(entryId)
      })
    }
  }

  // The native bars sit in the safe area, so the page clears it in every form.
  shellStyle(): CSSProperties {
    return { '--chrome-safe-bottom': 'var(--twsa-safe-area-inset-bottom)' } as CSSProperties
  }

  /**
   * The chrome registered for `entryId`.
   */
  screenChrome(entryId: number): ScreenChrome | undefined {
    return this.#screens.get(entryId)?.current
  }

  openModal(): Unlisten {
    this.#modalCount.set(this.#modalCount.get() + 1)
    return () => {
      this.#modalCount.set(this.#modalCount.get() - 1)
    }
  }

  reportStackMotion(motion: StackMotion): void {
    this.#nativeChrome.post(motion satisfies NativeChromeMessage)
  }

  #updateBars(update: (bars: Map<number, ScreenBar>) => void): void {
    const next = new Map(this.bars.get())
    update(next)
    this.bars.set(next)
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
 * over the header row, or nothing when the shell draws them in another row.
 * The shell's back button is wider than the web one, so a spacer moves a
 * title that starts after it clear.
 */
function NativeTopBarCorner(props: TopBarCornerProps): ReactElement | null {
  const renderer = useNativeChromeRenderer()
  const cornersInHeaderRow = useStore(renderer.cornersInHeaderRow)
  if (!cornersInHeaderRow) {
    return null
  }
  const clearsBack =
    props.edge === 'leading' && props.align === 'start' && props.chrome.back !== undefined
  return (
    <div className="invisible contents" inert aria-hidden>
      <WebTopBarCorner {...props} />
      {clearsBack ? <div className="w-1 shrink-0" /> : null}
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
  const bars = useStore(renderer.bars)
  const modal = useStore(renderer.modal)
  const toolbar = useFormattingToolbar()
  const theme = useThemeSetting()
  const { nativeChrome } = useAppServices()
  const toasts = useToastController()
  const sidebar = useSidebar(tab)
  const nextSidebarState: NativeSidebarState = {
    ...sidebar.state,
    graphMenu: toWireMenu(sidebar.state.graphMenu),
  }
  // A new object on every render: keep the last one while it is equal, so an
  // equal sidebar posts no state.
  const [sidebarState, setSidebarState] = useState(nextSidebarState)
  if (!isDeepEqual(sidebarState, nextSidebarState)) {
    setSidebarState(nextSidebarState)
  }

  useEffect(() => {
    nativeChrome.postState(
      buildShellChromeState({
        route,
        entryId,
        tab,
        // The store, not the render's `bars`: a new screen registers its bar
        // in a layout effect of this commit, after this component rendered.
        bar: renderer.bars.get().get(entryId),
        keyboardVisible,
        modal,
        toolbar: toolbar?.capabilities ?? null,
        sidebar: sidebarState,
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
    modal,
    toolbar,
    sidebarState,
    theme,
  ])

  // Kept while the photo picker holds focus, so the editor's toolbar is gone.
  const attachRef = useRef<{ commands: FormattingToolbarCommands; entryId: number } | null>(null)
  useLayoutEffect(() => {
    if (toolbar?.capabilities.canAttachFiles === true) {
      attachRef.current = { commands: toolbar.commands, entryId }
    }
  }, [toolbar, entryId])

  const contextRef = useRef<Pick<IntentContext, 'entryId' | 'selectTab' | 'runSidebar'>>({
    entryId,
    selectTab: onSelectTab,
    runSidebar: sidebar.run,
  })
  useLayoutEffect(() => {
    contextRef.current = { entryId, selectTab: onSelectTab, runSidebar: sidebar.run }
  })

  useEffect(() => {
    const unlisten = nativeChrome.listenIntent((payload) => {
      const intent = parseNativeIntent(payload)
      if (intent !== null) {
        const attach = attachRef.current
        const context = contextRef.current
        runNativeIntent(intent, {
          ...context,
          screen: renderer.screenChrome(context.entryId),
          attachCommands: attach?.entryId === context.entryId ? attach.commands : null,
          attachFiles: renderer.attachFiles,
          toasts,
          setCornersInHeaderRow: (value) => renderer.cornersInHeaderRow.set(value),
          setSidebarVisible: (value) => sidebarVisible.set(value),
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
