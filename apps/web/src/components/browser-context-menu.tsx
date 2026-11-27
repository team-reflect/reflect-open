import type { ContextMenuItem } from '@reflect/app'
import { useState, type ReactElement, type ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu.tsx'

interface Point {
  readonly x: number
  readonly y: number
}

interface BrowserContextMenuProps {
  items: readonly ContextMenuItem[]
  onSelect: (id: string) => void
  point: Point
}

export function BrowserContextMenu({
  items,
  onSelect,
  point,
}: BrowserContextMenuProps): ReactElement {
  const [open, setOpen] = useState(true)
  const anchor = { getBoundingClientRect: () => DOMRect.fromRect(point) }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* React bubbles the event from submenus too, through their portals. */}
      <DropdownMenuContent
        anchor={anchor}
        sideOffset={0}
        className="w-auto"
        onContextMenu={(event) => event.preventDefault()}
      >
        {renderItems(items, onSelect, '')}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function renderItems(
  items: readonly ContextMenuItem[],
  onSelect: (id: string) => void,
  path: string,
): ReactNode[] {
  return items.map((item, index) => {
    const key = `${path}${index}`
    switch (item.type) {
      case 'separator':
        return <DropdownMenuSeparator key={key} />
      case 'submenu':
        return (
          <DropdownMenuSub key={key}>
            <DropdownMenuSubTrigger>{item.title}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {renderItems(item.items, onSelect, `${key}.`)}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      case 'action': {
        const disabled = item.disabled ?? false
        const select = (): void => onSelect(item.id)
        return item.checked === undefined ? (
          <DropdownMenuItem key={key} disabled={disabled} onClick={select}>
            {item.title}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuCheckboxItem
            key={key}
            disabled={disabled}
            checked={item.checked}
            closeOnClick
            onClick={select}
          >
            {item.title}
          </DropdownMenuCheckboxItem>
        )
      }
    }
  })
}
