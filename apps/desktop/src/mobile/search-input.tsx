import { type ComponentProps, type ReactElement } from 'react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type SearchInputProps = Omit<ComponentProps<'input'>, 'type' | 'inputMode'>

/**
 * The mobile screens' search field (the All and Tasks tabs): a search-typed
 * {@link Input} that dismisses the software keyboard on the return key. These
 * lists filter live as you type, so the keyboard's return key ("Search", the
 * blue key on iOS) has nothing to submit — blurring the field lowers the
 * keyboard and hands the whole screen back to the results. A caller's own
 * `onKeyDown` still runs after.
 */
export function SearchInput({ className, onKeyDown, ...props }: SearchInputProps): ReactElement {
  return (
    <Input
      type="search"
      inputMode="search"
      className={cn('text-base', className)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
        onKeyDown?.(event)
      }}
      {...props}
    />
  )
}
