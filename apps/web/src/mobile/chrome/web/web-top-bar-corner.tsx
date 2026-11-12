import type { ComponentProps, ReactElement } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { useToastController } from '@/lib/use-toasts.ts'
import { cn } from '@/lib/utils.ts'
import { runChromeAction } from '@/mobile/chrome/chrome-action.ts'
import type { TopBarCornerProps } from '@/mobile/chrome/chrome-renderer.ts'
import type { ChromeButton, ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import { ChromeMenuDrawer } from '@/mobile/chrome/web/chrome-menu-drawer.tsx'
import { WEB_ICONS } from '@/mobile/chrome/web/web-icons.ts'
import { MobileTopBarIconButton } from '@/mobile/top-bar.tsx'

/**
 * One corner of a top bar as web buttons. In a `start` bar the outer
 * buttons reach into the row's padding, so their icons line up with the
 * screen's content.
 */
export function WebTopBarCorner({ edge, align, chrome }: TopBarCornerProps): ReactElement | null {
  const back = edge === 'leading' ? chrome.back : undefined
  const buttons = (edge === 'leading' ? chrome.leading : chrome.trailing) ?? []
  if (back === undefined && buttons.length === 0) {
    return null
  }
  const outer = align === 'start' ? edge : undefined
  return (
    <>
      {back === undefined ? null : (
        <MobileTopBarIconButton edge={outer} aria-label="Back" onClick={back}>
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
  const toasts = useToastController()
  const hidden = button.hidden === true
  const hiddenProps = {
    'aria-hidden': hidden || undefined,
    inert: hidden,
    className: cn(
      'transition-opacity duration-150 motion-reduce:transition-none',
      hidden ? 'pointer-events-none opacity-0' : 'opacity-100',
    ),
  }
  if (button.menu !== undefined) {
    return (
      <ChromeMenuDrawer
        button={{ ...button, menu: button.menu }}
        chrome={chrome}
        trigger={renderButtonFace(button, edge, hiddenProps)}
      />
    )
  }
  return renderButtonFace(button, edge, {
    ...hiddenProps,
    onClick: () => void runChromeAction(chrome, button.id, toasts),
  })
}

/**
 * The button element of `button`: its icon, or a small text button with its
 * title when it has no icon.
 */
function renderButtonFace(
  button: ChromeButton,
  edge: 'leading' | 'trailing' | undefined,
  props: ComponentProps<typeof Button>,
): ReactElement {
  if (button.icon === undefined) {
    return (
      <Button variant="ghost" size="sm" {...props}>
        {button.title}
      </Button>
    )
  }
  const Icon = WEB_ICONS[button.icon]
  return (
    <MobileTopBarIconButton edge={edge} aria-label={button.title} {...props}>
      <Icon aria-hidden />
    </MobileTopBarIconButton>
  )
}
