import { useLayoutEffect, useRef, type CSSProperties, type ReactElement } from 'react'
import { noop, returnNull } from '@ocavue/utils'
import type { ChromeRenderer, ShellBarsProps } from '@/mobile/chrome/chrome-renderer.ts'
import { WebPlus } from '@/mobile/chrome/web/web-plus.tsx'
import { WebTopBarCorner } from '@/mobile/chrome/web/web-top-bar-corner.tsx'
import { MobileFormattingToolbar } from '@/mobile/formatting-toolbar.tsx'
import type { MobileForm } from '@/mobile/mobile-form.ts'
import { TabCapsule } from '@/mobile/mobile-tab-bar.tsx'

/**
 * The shell's bottom chrome in each form. While the keyboard is up the
 * formatting toolbar takes the bottom of the shell root, which ends at the
 * keyboard's top. The rail and the pad's top capsule stay on screen with the
 * keyboard.
 */
function WebShellBars({ form, tab, onSelectTab, keyboardVisible }: ShellBarsProps): ReactElement {
  const toolbar = keyboardVisible ? <MobileFormattingToolbar /> : null
  switch (form) {
    case 'bar':
      return toolbar ?? <BarRow tab={tab} onSelectTab={onSelectTab} />
    case 'rail':
      return (
        <>
          <aside className="fixed right-safe-offset-2 bottom-safe-offset-2 z-30">
            <TabCapsule tab={tab} onSelect={onSelectTab} orientation="vertical" />
          </aside>
          {toolbar}
        </>
      )
    case 'pad':
      return (
        <>
          <div className="pointer-events-none fixed inset-x-0 top-safe-offset-2 z-30 flex justify-center *:pointer-events-auto">
            <TabCapsule tab={tab} onSelect={onSelectTab} orientation="horizontal" />
          </div>
          {toolbar}
        </>
      )
  }
}

/**
 * The iPhone bar: the capsule at the leading edge of a row at the bottom of
 * the shell, with the page's `+` on the row's center line at the trailing
 * edge. The row publishes its height as `--mobile-tab-bar-height` on the
 * document root, so viewport-anchored elements (the sync status pill) sit
 * above it. The variable clears on unmount, leaving consumers their fallback.
 */
function BarRow({ tab, onSelectTab }: Pick<ShellBarsProps, 'tab' | 'onSelectTab'>): ReactElement {
  const rowRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const row = rowRef.current
    const root = document.documentElement
    if (row === null) {
      return
    }
    const publish = (): void => {
      root.style.setProperty('--mobile-tab-bar-height', `${row.offsetHeight}px`)
    }
    publish()
    // Content-sized: the height moves with rotation (safe-area padding).
    const observer = new ResizeObserver(publish)
    observer.observe(row)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--mobile-tab-bar-height')
    }
  }, [])

  return (
    <div ref={rowRef} className="flex shrink-0 pt-2 pb-safe-offset-2 pl-safe-offset-3">
      <TabCapsule tab={tab} onSelect={onSelectTab} orientation="horizontal" />
    </div>
  )
}

/**
 * The bar row is in the shell's flow. The rail and the top capsule float, so
 * the shell pads for them and the page clears the bottom safe area itself.
 */
function webShellStyle(form: MobileForm): CSSProperties {
  switch (form) {
    case 'bar':
      // The row pads the bottom safe area itself.
      return { '--chrome-safe-bottom': '0px' } as CSSProperties
    case 'rail':
      return {
        '--chrome-safe-bottom': 'var(--twsa-safe-area-inset-bottom)',
        paddingRight: 'calc(var(--spacing) * 16)',
      } as CSSProperties
    case 'pad':
      return {
        '--chrome-safe-bottom': 'var(--twsa-safe-area-inset-bottom)',
        paddingTop: 'calc(var(--spacing) * 20)',
      } as CSSProperties
  }
}

/**
 * The chrome the web page draws itself.
 */
export const WEB_CHROME_RENDERER: ChromeRenderer = {
  TopBarCorner: WebTopBarCorner,
  ShellBars: WebShellBars,
  Plus: WebPlus,
  NoChrome: returnNull,
  shellStyle: webShellStyle,
  registerScreen: () => noop,
  openModal: () => noop,
  reportStackMotion: noop,
}
