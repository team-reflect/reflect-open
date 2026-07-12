import { type ComponentProps, type ReactElement } from 'react'
import { CircleX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type SearchInputProps = Omit<
  ComponentProps<'input'>,
  'type' | 'inputMode' | 'value' | 'defaultValue' | 'onChange'
> & {
  value: string
  onValueChange: (value: string) => void
}

/**
 * The mobile screens' search field (the All and Tasks tabs): a search-typed
 * {@link Input} that dismisses the software keyboard on the return key. These
 * lists filter live as you type, so the keyboard's return key ("Search", the
 * blue key on iOS) has nothing to submit — blurring the field lowers the
 * keyboard and hands the whole screen back to the results. A caller's own
 * `onKeyDown` still runs after. Non-empty searches get a consistent clear
 * action that does not steal focus from an active field.
 */
export function SearchInput({
  className,
  disabled,
  onKeyDown,
  onValueChange,
  readOnly,
  value,
  ...props
}: SearchInputProps): ReactElement {
  return (
    <div className="relative w-full min-w-0">
      <Input
        type="search"
        inputMode="search"
        className={cn(
          'text-base [&::-webkit-search-cancel-button]:hidden',
          value !== '' && 'pr-9',
          className,
        )}
        disabled={disabled}
        readOnly={readOnly}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          }
          onKeyDown?.(event)
        }}
        {...props}
      />
      {value !== '' && !disabled && !readOnly ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute inset-y-0 right-0 size-8 text-text-muted"
          aria-label="Clear search"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onValueChange('')}
        >
          <CircleX aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}
