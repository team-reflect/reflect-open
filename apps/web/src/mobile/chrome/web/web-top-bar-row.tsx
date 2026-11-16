import { useImperativeHandle, useRef, type ComponentProps, type ReactElement } from 'react'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { useToastController } from '@/lib/use-toasts.ts'
import { cn } from '@/lib/utils.ts'
import { runChromeAction } from '@/mobile/chrome/chrome-action.ts'
import type { TopBarRowProps } from '@/mobile/chrome/chrome-renderer.ts'
import type { ChromeButton, ChromeSearch, ScreenChrome } from '@/mobile/chrome/screen-chrome.ts'
import { ChromeMenuDrawer } from '@/mobile/chrome/web/chrome-menu-drawer.tsx'
import { WEB_ICONS } from '@/mobile/chrome/web/web-icons.ts'
import { MonthPicker } from '@/mobile/month-picker.tsx'
import { MonthTitle } from '@/mobile/month-title.tsx'
import { SearchInput } from '@/mobile/search-input.tsx'
import { MobileTopBarIconButton } from '@/mobile/top-bar.tsx'

interface TopBarCornerProps extends TopBarRowProps {
  edge: 'leading' | 'trailing'
}

/**
 * The main row of a top bar as web elements: the corners around the search
 * field or the title.
 */
export function WebTopBarRow({ align, chrome }: TopBarRowProps): ReactElement {
  const middle = <WebTopBarMiddle chrome={chrome} />
  if (align === 'center') {
    return (
      <div className="flex h-12 items-center gap-2 px-1">
        <div className="flex flex-1 basis-0 items-center justify-start gap-1">
          <WebTopBarCorner edge="leading" align={align} chrome={chrome} />
        </div>
        <div className="min-w-0 text-center">{middle}</div>
        <div className="flex flex-1 basis-0 items-center justify-end gap-1">
          <WebTopBarCorner edge="trailing" align={align} chrome={chrome} />
        </div>
      </div>
    )
  }
  return (
    <div className="flex h-12 items-center gap-1 px-4">
      <WebTopBarCorner edge="leading" align={align} chrome={chrome} />
      <div className="flex min-w-0 flex-1 items-center gap-1">{middle}</div>
      <WebTopBarCorner edge="trailing" align={align} chrome={chrome} />
    </div>
  )
}

/**
 * The search field, or the title.
 */
function WebTopBarMiddle({ chrome }: { chrome: ScreenChrome }): ReactElement | null {
  const { title, search } = chrome
  if (search !== undefined) {
    return <WebSearchField search={search} />
  }
  if (title === undefined) {
    return null
  }
  if (typeof title === 'string') {
    return <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
  }
  return (
    <h1 className="text-base font-semibold">
      <MonthPicker
        month={title.month}
        selected={title.selected}
        today={title.today}
        onPick={title.onPick}
      >
        <MonthTitle month={title.month} />
        <ChevronDown aria-hidden className="size-4 shrink-0 text-text-muted" />
      </MonthPicker>
    </h1>
  )
}

/**
 * The search field. Its input is what `search.ref` focuses.
 */
function WebSearchField({ search }: { search: ChromeSearch }): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null)
  useImperativeHandle(
    search.ref,
    () => ({
      focus: () => inputRef.current?.focus(),
      select: () => inputRef.current?.select(),
    }),
    [],
  )
  return (
    <SearchInput
      ref={inputRef}
      placeholder={search.placeholder}
      aria-label={search.label}
      value={search.value}
      onValueChange={search.onChange}
    />
  )
}

/**
 * One corner of a top bar as web buttons. In a `start` bar the outer
 * buttons reach into the row's padding, so their icons line up with the
 * screen's content.
 */
function WebTopBarCorner({ edge, align, chrome }: TopBarCornerProps): ReactElement | null {
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
