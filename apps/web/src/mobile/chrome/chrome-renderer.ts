import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentType,
  type CSSProperties,
} from 'react'
import type { Unlisten } from '@reflect/core'
import type { ChromePlus, ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import type { MobileForm } from '@/mobile/mobile-form.ts'
import type { MobileTab } from '@/mobile/mobile-tab-bar.tsx'
import { useRouterState } from '@/routing/router.tsx'

export interface TopBarRowProps {
  /**
   * The layout of the bar: corners of equal width around a centered title,
   * or corners at the edges of a title that fills the row.
   */
  align: 'center' | 'start'
  chrome: ScreenChrome
}

export interface ShellBarsProps {
  tab: MobileTab
  onSelectTab: (tab: MobileTab) => void
  keyboardVisible: boolean
  form: MobileForm
}

/**
 * A user back swipe of the mobile stack.
 */
export type StackMotion = { type: 'backSwipe'; phase: 'start' | 'cancel' }

/**
 * Draws the mobile chrome. The app picks one renderer at its root; screens
 * declare their chrome and never ask which renderer runs.
 */
export interface ChromeRenderer {
  /**
   * The main row of a top bar: corners, title and search, or nothing when
   * the shell draws that row.
   */
  readonly TopBarRow: ComponentType<TopBarRowProps>
  /**
   * Whether `TopBarRow` draws anything.
   */
  readonly drawsTopBarRow: boolean
  /**
   * The bars of the routed shell in `form`. While the keyboard is up the
   * formatting toolbar replaces the `bar` row; the rail and the pad's top
   * capsule stay on screen.
   */
  readonly ShellBars: ComponentType<ShellBarsProps>
  /**
   * The `+` of a screen, which its top bar renders.
   */
  readonly Plus: ComponentType<{ plus: ChromePlus }>
  /**
   * Marks a surface outside the routed shell, which shows no shell bars.
   */
  readonly NoChrome: ComponentType
  /**
   * The `--chrome-*` variables of the shell root, for content that clears
   * the bars (`styles/index.css`).
   */
  shellStyle(form: MobileForm): CSSProperties
  /**
   * Register the chrome of the screen on top for `entryId` and take a
   * snapshot of its corners; returns the unregister, which keeps a
   * registration that a later screen made.
   */
  registerScreen(entryId: number, chrome: { readonly current: ScreenChrome }): Unlisten
  /**
   * Count one open drawer; returns the release.
   */
  openModal(): Unlisten
  /**
   * Count one surface that covers the whole screen; returns the release.
   */
  openFullscreen(): Unlisten
  /**
   * Tell the renderer that a back swipe moves the stack.
   */
  reportStackMotion(motion: StackMotion): void
}

export const ChromeRendererContext = createContext<ChromeRenderer | null>(null)

/**
 * Whether the subtree is the screen on top of the mobile stack. Only that
 * screen registers its chrome: a hidden layer can mount with the router state
 * of the screen on top, so it would register under the wrong entry.
 */
export const ChromeLayerContext = createContext(true)

/**
 * The chrome renderer of the app.
 */
export function useChromeRenderer(): ChromeRenderer {
  const renderer = use(ChromeRendererContext)
  if (renderer === null) {
    throw new Error('useChromeRenderer() must be called inside a <ChromeRendererProvider>')
  }
  return renderer
}

/**
 * Declare this screen's chrome for the history entry it shows. `chrome` may
 * be a new object on every render: only a change of its buttons, its `+`,
 * its title, the words of its search field, or whether it has `back`,
 * reaches the renderer.
 */
export function useScreenChrome(chrome: ScreenChrome): void {
  const renderer = useChromeRenderer()
  const { entryId } = useRouterState()
  const onTop = use(ChromeLayerContext)
  const chromeRef = useRef(chrome)
  useLayoutEffect(() => {
    chromeRef.current = chrome
  })
  // `JSON.stringify` leaves out the handlers. The search field's ref holds
  // a focus handle, so only its words count.
  const { title, search } = chrome
  const key = JSON.stringify([
    chrome.leading,
    chrome.trailing,
    chrome.back !== undefined,
    chrome.hidesTabBar,
    chrome.plus,
    title,
    search === undefined
      ? null
      : { value: search.value, placeholder: search.placeholder, label: search.label },
  ])

  // A layout effect, so the chrome is registered before the passive effects
  // of the same commit run. A change of `key` registers a new snapshot.
  useLayoutEffect(() => {
    if (onTop) {
      return renderer.registerScreen(entryId, chromeRef)
    }
  }, [renderer, onTop, entryId, key])
}

/**
 * Count an open drawer while `open` is true.
 */
export function useChromeModal(open: boolean): void {
  const renderer = useChromeRenderer()
  useEffect(() => {
    if (open) {
      return renderer.openModal()
    }
  }, [renderer, open])
}

/**
 * Hide the shell's bars while `open` is true. Outside a chrome renderer (the
 * desktop app) it does nothing.
 */
export function useChromeFullscreen(open: boolean): void {
  const renderer = use(ChromeRendererContext)
  useEffect(() => {
    if (open && renderer !== null) {
      return renderer.openFullscreen()
    }
  }, [renderer, open])
}
