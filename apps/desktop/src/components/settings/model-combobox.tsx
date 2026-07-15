import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useCommandState } from 'cmdk'
import { ChevronsUpDownIcon } from 'lucide-react'
import { aiModelLabel, type AiModelOption, type AiProviderId } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

interface FilterCountSyncProps {
  countRef: React.MutableRefObject<number>
}

/**
 * Tracks the cmdk filtered item count in a ref so the parent's keydown handler
 * (which fires long after render) always sees the latest value. Must be
 * rendered inside a {@link Command}.
 */
function FilterCountSync({ countRef }: FilterCountSyncProps): null {
  const count = useCommandState((state) => state.filtered.count)
  useEffect(() => {
    countRef.current = count
  })
  return null
}

interface ModelComboboxProps {
  /** Currently selected model id (may be a custom string not in the catalog). */
  value: string
  /** Provider whose curated model list to show. */
  provider: AiProviderId
  /** Curated options for quick-select (most capable first). */
  models: AiModelOption[]
  /** Called with the new model id — either a catalog id or a custom string. */
  onChange: (modelId: string) => void
  /** Accessible name for the trigger when multiple model pickers are visible. */
  ariaLabel?: string
}

/**
 * A combobox for selecting an AI model. Shows the provider's curated models
 * as quick-select options (searchable) and also accepts any arbitrary model
 * string — type a custom id and press Enter to confirm it.
 */
export function ModelCombobox({
  value,
  provider,
  models,
  onChange,
  ariaLabel = 'Default model',
}: ModelComboboxProps): ReactElement {
  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const filteredCountRef = useRef(models.length)

  const clearInput = () => setInputValue('')
  // Clear stale search text whenever the provider changes (popover close is
  // handled in the open-change handler). Adjusting during render avoids a
  // prop-syncing effect.
  const [appliedProvider, setAppliedProvider] = useState(provider)
  if (appliedProvider !== provider) {
    setAppliedProvider(provider)
    setInputValue('')
  }

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen)
    if (!isOpen) clearInput()
  }

  const commit = (modelId: string) => {
    onChange(modelId)
    setOpen(false)
    clearInput()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && filteredCountRef.current === 0 && inputValue.trim()) {
      event.preventDefault()
      commit(inputValue.trim())
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{aiModelLabel(provider, value)}</span>
          <ChevronsUpDownIcon className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="p-0"
        style={{ width: 'var(--radix-popover-trigger-width)' }}
        align="start"
      >
        <Command>
          <FilterCountSync countRef={filteredCountRef} />
          <CommandInput
            placeholder="Search or type a model name…"
            value={inputValue}
            onValueChange={setInputValue}
            onKeyDown={handleKeyDown}
          />
          <CommandList>
            <CommandEmpty>
              Press{' '}
              <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-xs">Enter</kbd>{' '}
              to use &ldquo;{inputValue}&rdquo;
            </CommandEmpty>
            <CommandGroup>
              {models.map((model) => (
                <CommandItem
                  key={model.id}
                  value={`${model.label} ${model.id}`}
                  onSelect={() => commit(model.id)}
                  data-checked={model.id === value}
                >
                  {model.label}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {model.id}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
