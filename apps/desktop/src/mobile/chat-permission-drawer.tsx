import type { ChatPermissionMode } from '@reflect/core'
import { Check } from 'lucide-react'
import { useRef, type KeyboardEvent, type ReactElement } from 'react'
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer'
import { cn } from '@/lib/utils'
import { useChatSession } from '@/providers/chat-provider'

interface ChatPermissionDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface PermissionOption {
  value: ChatPermissionMode
  label: string
  description: string
}

const OPTIONS: readonly PermissionOption[] = [
  {
    value: 'read',
    label: 'Read only',
    description: 'Search and answer from your notes',
  },
  {
    value: 'readWrite',
    label: 'Read & write',
    description: 'Can edit non-private notes; changes are reviewable and undoable',
  },
]

/** The mobile capability picker for the next AI chat turn. */
export function ChatPermissionDrawer({
  open,
  onOpenChange,
}: ChatPermissionDrawerProps): ReactElement {
  const { permissionMode, setPermissionMode, status } = useChatSession()
  const arrowTraversalRef = useRef(false)
  const disabled = status !== 'idle'

  const handleRadioKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    mode: ChatPermissionMode,
  ): void => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      arrowTraversalRef.current = false
      setPermissionMode(mode)
      onOpenChange(false)
      return
    }
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowRight' ||
      event.key === 'ArrowUp'
    ) {
      arrowTraversalRef.current = true
      setTimeout(() => {
        arrowTraversalRef.current = false
      }, 0)
    } else {
      arrowTraversalRef.current = false
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent aria-label="Choose chat permissions">
        <DrawerTitle className="px-4 pt-1">Chat permissions</DrawerTitle>
        <div
          role="radiogroup"
          aria-label="Chat permissions"
          className="mx-4 mb-8 mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface"
        >
          {OPTIONS.map((option) => {
            const selected = option.value === permissionMode
            return (
              <label
                key={option.value}
                className={cn(
                  'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-secondary/70 has-[:disabled]:opacity-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50',
                )}
              >
                <input
                  type="radio"
                  name="chat-permission-mode"
                  value={option.value}
                  checked={selected}
                  disabled={disabled}
                  className="sr-only"
                  onKeyDown={(event) => handleRadioKeyDown(event, option.value)}
                  onPointerDown={() => {
                    arrowTraversalRef.current = false
                  }}
                  onChange={() => setPermissionMode(option.value)}
                  onClick={() => {
                    if (arrowTraversalRef.current) {
                      arrowTraversalRef.current = false
                      return
                    }
                    onOpenChange(false)
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium">{option.label}</span>
                  <span className="block text-[13px] text-text-muted">{option.description}</span>
                </span>
                {selected ? (
                  <Check aria-hidden className="size-4 shrink-0 text-primary" strokeWidth={2} />
                ) : null}
              </label>
            )
          })}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
