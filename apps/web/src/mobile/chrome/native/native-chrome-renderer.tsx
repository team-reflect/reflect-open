import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useState,
  useRef,
  type CSSProperties,
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
  type TopBarRowProps,
} from '@/mobile/chrome/chrome-renderer.ts'
import type { ChromeSearch, ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import {
  createAttachQueue,
  runNativeIntent,
  type IntentContext,
} from '@/mobile/chrome/native/native-chrome-intents.ts'
import {
  buildNoChromeState,
  buildShellChromeState,
  toWirePlus,
  toWireTitle,
  type ScreenBar,
} from '@/mobile/chrome/native/native-chrome-state.ts'
import { toWireMenu } from '@/mobile/chrome/native/sf-symbols.ts'
import {
  parseNativeIntent,
  type NativeChromeMessage,
  type NativeSearchState,
  type NativeSidebarState,
} from '@/mobile/chrome/native/protocol.ts'
import { sidebarVisible, useSidebar } from '@/mobile/sidebar.ts'
import { useThemeSetting } from '@/providers/settings-provider.tsx'
import { useRouterActions, useRouterState } from '@/routing/router.tsx'
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
  /**
   * How many surfaces cover the whole screen.
   */
  readonly #fullscreenCount = new WritableStore(0)
  readonly TopBarRow = NativeTopBarRow
  // The shell draws the main row in its navigation bar.
  readonly drawsTopBarRow = false
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
   * Whether a surface covers the whole screen. The shell hides every bar
   * while one does.
   */
  readonly fullscreen = deriveStore(this.#fullscreenCount, (count) => count > 0)
  /**
   * How far the iPadOS window controls reach into the top row from its
   * leading edge, in pixels. A surface over the bars (the lightbox) leaves
   * this space.
   */
  readonly windowControlsWidth = new WritableStore(0)
  readonly attachFiles = createAttachQueue()
  /**
   * The search text of every entry with a search field, its revision, and
   * the last text the shell sent for it.
   */
  readonly #search = new Map<number, { text: string; revision: number; fromShell: string | null }>()

  constructor(nativeChrome: NativeChromeService) {
    this.#nativeChrome = nativeChrome
  }

  registerScreen(entryId: number, chrome: { readonly current: ScreenChrome }): Unlisten {
    this.#screens.set(entryId, chrome)
    const { back, hidesTabBar, leading, trailing, plus, title, search } = chrome.current
    // A copy, so an in-place change of the screen's buttons is a change.
    const bar = structuredClone({
      canBack: back !== undefined,
      hidesTabBar: hidesTabBar ?? false,
      leading: leading ?? [],
      trailing: trailing ?? [],
      plus: plus === undefined ? null : toWirePlus(plus),
      title: title === undefined ? null : toWireTitle(title),
      search: this.#wireSearch(entryId, search),
    })
    this.#updateBars((bars) => {
      bars.set(entryId, bar)
    })
    return () => {
      if (this.#screens.get(entryId) !== chrome) {
        return
      }
      this.#screens.delete(entryId)
      // A change of the screen's chrome registers again right after, and
      // the revision must carry over: forget the search only if nothing did.
      queueMicrotask(() => {
        if (!this.#screens.has(entryId)) {
          this.#search.delete(entryId)
        }
      })
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

  /**
   * The shell's search field of `entryId` changed to `text`. The screen's
   * value that follows is an echo, so it keeps the revision.
   */
  noteShellSearch(entryId: number, text: string): void {
    const entry = this.#search.get(entryId)
    if (entry !== undefined) {
      entry.fromShell = text
    }
  }

  /**
   * Ask the shell to focus the search field of `entryId`.
   */
  focusSearch(entryId: number): void {
    this.#nativeChrome.post({ type: 'focusSearch', entryId } satisfies NativeChromeMessage)
  }

  /**
   * The search field without its handlers. The revision grows only when the
   * screen changes the text itself, so the shell never writes back an echo
   * of what the user typed.
   */
  #wireSearch(entryId: number, search: ChromeSearch | undefined): NativeSearchState | null {
    if (search === undefined) {
      this.#search.delete(entryId)
      return null
    }
    const entry = this.#search.get(entryId)
    let next = { text: search.value, revision: 0, fromShell: null as string | null }
    if (entry !== undefined && search.value === entry.text) {
      next = entry
    } else if (entry !== undefined) {
      // The echo of the shell's last text counts once.
      const echo = search.value === entry.fromShell
      next.revision = echo ? entry.revision : entry.revision + 1
    }
    this.#search.set(entryId, next)
    const { revision } = next
    return { placeholder: search.placeholder, label: search.label, text: search.value, revision }
  }

  openModal(): Unlisten {
    this.#modalCount.set(this.#modalCount.get() + 1)
    return () => {
      this.#modalCount.set(this.#modalCount.get() - 1)
    }
  }

  openFullscreen(): Unlisten {
    this.#fullscreenCount.set(this.#fullscreenCount.get() + 1)
    return () => {
      this.#fullscreenCount.set(this.#fullscreenCount.get() - 1)
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
 * The shell draws the main row. This only hands the screen's search ref the
 * shell's search field.
 */
function NativeTopBarRow({ chrome }: TopBarRowProps): null {
  const renderer = useNativeChromeRenderer()
  const { entryId } = useRouterState()
  useImperativeHandle(chrome.search?.ref, () => ({ focus: () => renderer.focusSearch(entryId) }), [
    renderer,
    entryId,
  ])
  return null
}

/**
 * Posts the routed shell's chrome state to the Swift shell after every change
 * and runs the shell's intents. Renders nothing.
 */
function NativeShellBars({ tab, keyboardVisible, onSelectTab }: ShellBarsProps): null {
  const renderer = useNativeChromeRenderer()
  const { route, entryId, canBack, canForward } = useRouterState()
  const { back, forward } = useRouterActions()
  const showsSidebar = useStore(sidebarVisible) !== null
  const bars = useStore(renderer.bars)
  const windowControlsWidth = useStore(renderer.windowControlsWidth)
  const modal = useStore(renderer.modal)
  const fullscreen = useStore(renderer.fullscreen)
  const toolbar = useFormattingToolbar()
  const theme = useThemeSetting()
  const { nativeChrome } = useAppServices()
  const toasts = useToastController()
  const sidebar = useSidebar()
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
        history: showsSidebar ? { back: canBack, forward: canForward } : null,
        fullscreen,
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
    fullscreen,
    toolbar,
    sidebarState,
    showsSidebar,
    canBack,
    canForward,
    theme,
  ])

  useEffect(() => {
    document.documentElement.style.setProperty(
      '--window-controls-width',
      `${windowControlsWidth}px`,
    )
  }, [windowControlsWidth])

  // Kept while the photo picker holds focus, so the editor's toolbar is gone.
  const attachRef = useRef<{ commands: FormattingToolbarCommands; entryId: number } | null>(null)
  useLayoutEffect(() => {
    if (toolbar?.capabilities.canAttachFiles === true) {
      attachRef.current = { commands: toolbar.commands, entryId }
    }
  }, [toolbar, entryId])

  const moveHistory = (direction: 'back' | 'forward'): void => {
    if (direction === 'back') {
      back()
    } else {
      forward()
    }
  }
  const contextRef = useRef<
    Pick<IntentContext, 'entryId' | 'selectTab' | 'runSidebar' | 'moveHistory'>
  >({ entryId, selectTab: onSelectTab, runSidebar: sidebar.run, moveHistory })
  useLayoutEffect(() => {
    contextRef.current = { entryId, selectTab: onSelectTab, runSidebar: sidebar.run, moveHistory }
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
          noteShellSearch: (id, text) => renderer.noteShellSearch(id, text),
          setWindowControlsWidth: (value) => renderer.windowControlsWidth.set(value),
          setSidebarVisible: (value) => sidebarVisible.set(value),
        })
      }
    })
    nativeChrome.post({ type: 'chromeReady' } satisfies NativeChromeMessage)
    return () => {
      unlisten()
      // Back to the start value: the next `chromeReady` gets only a sidebar
      // that shows or hides.
      sidebarVisible.set(null)
    }
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
