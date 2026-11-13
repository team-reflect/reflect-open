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

export interface TopBarCornerProps {
  edge: 'leading' | 'trailing'
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
 * A move of the mobile stack: a slide between screens, or a user back swipe.
 */
export type StackMotion =
  | { type: 'transition'; phase: 'start' | 'end' }
  | { type: 'backSwipe'; phase: 'start' | 'cancel' }

/**
 * Draws the mobile chrome. The app picks one renderer at its root; screens
 * declare their chrome and never ask which renderer runs.
 */
export interface ChromeRenderer {
  /**
   * One corner of a top bar: the back button (leading only) and the buttons,
   * or the space they take when something else draws them.
   */
  readonly TopBarCorner: ComponentType<TopBarCornerProps>
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
   * Tell the renderer that the stack slides or a back swipe moves it.
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
 * be a new object on every render: only a change of its buttons, of its `+`,
 * or of whether it has `back`, reaches the renderer.
 */
export function useScreenChrome(chrome: ScreenChrome): void {
  const renderer = useChromeRenderer()
  const { entryId } = useRouterState()
  const onTop = use(ChromeLayerContext)
  const chromeRef = useRef(chrome)
  useLayoutEffect(() => {
    chromeRef.current = chrome
  })
  // `JSON.stringify` leaves out the `+` handlers.
  const key = JSON.stringify([
    chrome.leading,
    chrome.trailing,
    chrome.back !== undefined,
    chrome.plus,
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
