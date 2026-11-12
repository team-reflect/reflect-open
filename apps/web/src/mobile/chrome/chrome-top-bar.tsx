import type { ReactElement, ReactNode } from 'react'
import { useChromeRenderer, useScreenChrome } from '@/mobile/chrome/chrome-renderer.ts'
import type { ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'

interface ChromeTopBarProps extends ScreenChrome {
  /**
   * The middle of the main row: a heading, or a search field with its
   * controls.
   */
  title: ReactNode
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
 * renderer draws the corners, and the bar draws the title.
 */
export function ChromeTopBar({
  title,
  align = 'start',
  children,
  ...chrome
}: ChromeTopBarProps): ReactElement {
  const chromeRenderer = useChromeRenderer()
  useScreenChrome(chrome)
  const corner = (edge: 'leading' | 'trailing'): ReactElement => (
    <chromeRenderer.TopBarCorner edge={edge} align={align} chrome={chrome} />
  )
  return (
    <header className="shrink-0 border-b border-border px-safe">
      {align === 'center' ? (
        <div className="flex h-12 items-center px-1">
          <div className="flex flex-1 basis-0 items-center justify-start gap-1">
            {corner('leading')}
          </div>
          <div className="min-w-0 text-center">{title}</div>
          <div className="flex flex-1 basis-0 items-center justify-end gap-1">
            {corner('trailing')}
          </div>
        </div>
      ) : (
        <div className="flex h-12 items-center gap-1 px-4">
          {corner('leading')}
          <div className="flex min-w-0 flex-1 items-center gap-1">{title}</div>
          {corner('trailing')}
        </div>
      )}
      {children}
    </header>
  )
}
