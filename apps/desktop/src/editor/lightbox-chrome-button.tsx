import type { ComponentProps, CSSProperties, ReactElement } from 'react'
import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'

interface LightboxChromeButtonProps extends ComponentProps<typeof Button> {
  side: 'left' | 'right'
  wrapperStyle?: CSSProperties | undefined
}

/** A translucent lightbox control pinned inside the iOS safe area. */
export function LightboxChromeButton({
  side,
  wrapperStyle,
  className,
  ...props
}: LightboxChromeButtonProps): ReactElement {
  return (
    <div
      className={cn(
        'absolute top-safe-or-4 z-10',
        side === 'left' ? 'left-safe-or-4' : 'right-safe-or-4',
      )}
      style={wrapperStyle}
    >
      <Button
        type="button"
        variant="ghost"
        className={cn(
          'rounded-full bg-white/15 text-white shadow-sm backdrop-blur-xl hover:bg-white/25 active:bg-white/20',
          className,
        )}
        {...props}
      />
    </div>
  )
}
