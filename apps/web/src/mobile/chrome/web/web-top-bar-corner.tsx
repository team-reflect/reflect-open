import type { ReactElement } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'
import type { TopBarCornerProps } from '@/mobile/chrome/chrome-renderer.ts'
import type { ChromeButton, ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import { WEB_ICONS } from '@/mobile/chrome/web/web-icons.ts'
import { MobileTopBarIconButton } from '@/mobile/top-bar.tsx'

interface WebTopBarCornerProps extends TopBarCornerProps {
  /**
   * Extra classes of the back button.
   */
  backClassName?: string | undefined
}

/**
 * One corner of a top bar as web buttons. In a `start` bar the outer
 * buttons reach into the row's padding, so their icons line up with the
 * screen's content.
 */
export function WebTopBarCorner({
  edge,
  align,
  chrome,
  backClassName,
}: WebTopBarCornerProps): ReactElement | null {
  const back = edge === 'leading' ? chrome.back : undefined
  const buttons = (edge === 'leading' ? chrome.leading : chrome.trailing) ?? []
  if (back === undefined && buttons.length === 0) {
    return null
  }
  const outer = align === 'start' ? edge : undefined
  return (
    <>
      {back === undefined ? null : (
        <MobileTopBarIconButton
          edge={outer}
          aria-label="Back"
          className={backClassName}
          onClick={back}
        >
          <ChevronLeft aria-hidden />
        </MobileTopBarIconButton>
      )}
      {buttons.map((button, index) => (
        <CornerButton
          key={button.id}
          button={button}
          chrome={chrome}
          edge={
            (edge === 'leading' && back === undefined && index === 0) ||
            (edge === 'trailing' && index === buttons.length - 1)
              ? outer
              : undefined
          }
        />
      ))}
    </>
  )
}

function CornerButton({
  button,
  chrome,
  edge,
}: {
  button: ChromeButton
  chrome: ScreenChrome
  edge: 'leading' | 'trailing' | undefined
}): ReactElement {
  const hidden = button.hidden === true
  const hiddenProps = {
    'aria-hidden': hidden || undefined,
    inert: hidden,
    className: cn(
      'transition-opacity duration-150 motion-reduce:transition-none',
      hidden ? 'pointer-events-none opacity-0' : 'opacity-100',
    ),
    onClick: () => chrome.onAction?.(button.id),
  }
  if (button.icon === undefined) {
    return (
      <Button variant="ghost" size="sm" {...hiddenProps}>
        {button.title}
      </Button>
    )
  }
  const Icon = WEB_ICONS[button.icon]
  return (
    <MobileTopBarIconButton edge={edge} aria-label={button.title} {...hiddenProps}>
      <Icon aria-hidden />
    </MobileTopBarIconButton>
  )
}
