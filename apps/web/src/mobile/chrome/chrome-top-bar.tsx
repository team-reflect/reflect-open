import { use, type ReactElement, type ReactNode } from 'react'
import {
  ChromeLayerContext,
  useChromeRenderer,
  useScreenChrome,
} from '@/mobile/chrome/chrome-renderer.ts'
import type { ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'

interface ChromeTopBarProps extends ScreenChrome {
  /**
   * `center` puts the title at the center between equal corners.
   */
  align?: 'center' | 'start' | undefined
  /**
   * Rows under the main row.
   */
  children?: ReactNode | undefined
}

/**
 * The top bar of a mobile screen. It declares the screen's chrome; the
 * renderer draws the main row and the `+`, and the bar draws the rows under
 * the main row.
 */
export function ChromeTopBar({
  align = 'start',
  children,
  ...chrome
}: ChromeTopBarProps): ReactElement {
  const chromeRenderer = useChromeRenderer()
  const onTop = use(ChromeLayerContext)
  useScreenChrome(chrome)
  const row = <chromeRenderer.TopBarRow align={align} chrome={chrome} />
  return (
    <>
      {chromeRenderer.drawsTopBarRow || children !== undefined ? (
        <header className="shrink-0 border-b border-border px-safe">
          {row}
          {children}
        </header>
      ) : (
        row
      )}
      {chrome.plus === undefined || !onTop ? null : <chromeRenderer.Plus plus={chrome.plus} />}
    </>
  )
}
