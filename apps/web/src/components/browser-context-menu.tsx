import type { NativeMenuItem } from '@reflect/app'
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
  items: readonly NativeMenuItem[]
  point: Point
  onClosed: () => void
}

export function BrowserContextMenu({
  items,
  point,
  onClosed,
}: BrowserContextMenuProps): ReactElement {
  const [open, setOpen] = useState(true)
  const anchor = { getBoundingClientRect: () => DOMRect.fromRect(point) }
  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(next) => {
        if (!next) {
          onClosed()
        }
      }}
    >
      <DropdownMenuContent anchor={anchor} sideOffset={0} className="w-auto">
        {renderItems(items, '')}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function renderItems(items: readonly NativeMenuItem[], path: string): ReactNode[] {
  return items.map((item, index) => {
    const key = `${path}${index}`
    switch (item.kind) {
      case 'predefined':
        // Context menus contain only the separator.
        return item.item === 'Separator' ? <DropdownMenuSeparator key={key} /> : null
      case 'submenu':
        return (
          <DropdownMenuSub key={key}>
            <DropdownMenuSubTrigger>{item.text}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>{renderItems(item.items, `${key}.`)}</DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      case 'command': {
        const disabled = item.enabled === false
        const select = (): void => item.action(item.id ?? key)
        return item.checked === undefined ? (
          <DropdownMenuItem key={key} disabled={disabled} onClick={select}>
            {item.text}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuCheckboxItem
            key={key}
            disabled={disabled}
            checked={item.checked}
            closeOnClick
            onClick={select}
          >
            {item.text}
          </DropdownMenuCheckboxItem>
        )
      }
    }
  })
}
