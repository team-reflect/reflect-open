import { useState, type ReactElement } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { useToastController } from '@/lib/use-toasts.ts'
import { cn } from '@/lib/utils.ts'
import { runChromeAction } from '@/mobile/chrome/chrome-action.ts'
import type {
  ChromeButton,
  ChromeConfirm,
  ChromeMenuItem,
  ScreenChrome,
} from '@/mobile/chrome/screen-chrome.ts'
import { ChromeConfirmDrawer } from '@/mobile/chrome/web/chrome-confirm-drawer.tsx'
import { WEB_ICONS } from '@/mobile/chrome/web/web-icons.ts'
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from '@/mobile/scroll-drawer.tsx'

interface ChromeMenuDrawerProps {
  button: ChromeButton & { menu: ChromeMenuItem[] }
  chrome: ScreenChrome
  /**
   * The button that opens the menu.
   */
  trigger: ReactElement
}

type ActionItem = Extract<ChromeMenuItem, { type: 'action' }>

/**
 * A corner button that opens its menu as a bottom drawer. An item with a
 * confirmation asks in a second drawer before it runs.
 */
export function ChromeMenuDrawer({ button, chrome, trigger }: ChromeMenuDrawerProps): ReactElement {
  const toasts = useToastController()
  const [open, setOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // Kept after the drawer closes, so its content stays during the exit.
  const [confirming, setConfirming] = useState<{ id: string; confirm: ChromeConfirm } | null>(null)

  const select = (item: ActionItem): void => {
    setOpen(false)
    if (item.confirm === undefined) {
      void runChromeAction(chrome, item.id, toasts)
    } else {
      setConfirming({ id: item.id, confirm: item.confirm })
      setConfirmOpen(true)
    }
  }

  return (
    <>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger render={trigger} />
        <DrawerContent>
          <DrawerTitle className="sr-only">{button.title}</DrawerTitle>
          <div className="flex flex-col gap-1 p-4">
            <MenuItems items={button.menu} onSelect={select} />
          </div>
        </DrawerContent>
      </Drawer>
      {confirming === null ? null : (
        <ChromeConfirmDrawer
          confirm={confirming.confirm}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          onConfirm={() => chrome.onAction?.(confirming.id)}
        />
      )}
    </>
  )
}

/**
 * The rows of a menu. A section adds its title, when it has one, above its
 * rows.
 */
function MenuItems({
  items,
  onSelect,
}: {
  items: ChromeMenuItem[]
  onSelect: (item: ActionItem) => void
}): ReactElement {
  return (
    <>
      {items.map((item, index) => {
        if (item.type === 'section') {
          return (
            <div key={`section-${index}`} className="contents">
              {item.title === undefined ? null : (
                <p className="px-3 pt-2 text-xs font-medium text-text-muted">{item.title}</p>
              )}
              <MenuItems items={item.items} onSelect={onSelect} />
            </div>
          )
        }
        const Icon = item.icon === undefined ? null : WEB_ICONS[item.icon]
        return (
          <Button
            key={item.id}
            variant="ghost"
            size="lg"
            className={cn(
              'h-12 justify-start gap-3 text-base',
              item.destructive === true && 'text-destructive hover:text-destructive',
            )}
            disabled={item.disabled === true}
            onClick={() => onSelect(item)}
          >
            {Icon === null ? null : <Icon aria-hidden />}
            {item.title}
            {item.checked === true ? <Check aria-hidden className="ml-auto" /> : null}
          </Button>
        )
      })}
    </>
  )
}
