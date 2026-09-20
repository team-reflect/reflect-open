import type { ComponentProps, CSSProperties, ReactElement } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

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
        'absolute top-[max(env(safe-area-inset-top),1rem)] z-10',
        side === 'left'
          ? 'left-[max(env(safe-area-inset-left),1rem)]'
          : 'right-[max(env(safe-area-inset-right),1rem)]',
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
