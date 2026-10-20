import { XIcon } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'

/** The editor colors use `light-dark()`, which Safari supports from 17.5. */
const SUPPORTS_LIGHT_DARK = CSS.supports('color', 'light-dark(#000, #fff)')

/**
 * A dismissible warning, floating at the top of the window, shown when the
 * system web engine is too old for the app's colors.
 */
export function OutdatedWebEngineBanner(): ReactElement | null {
  const [dismissed, setDismissed] = useState(false)
  if (SUPPORTS_LIGHT_DARK || dismissed) {
    return null
  }
  return (
    <div className="fixed inset-x-4 top-[max(env(safe-area-inset-top),2.25rem)] z-50 mx-auto max-w-md rounded-md bg-background shadow-lg">
      <InlineAlert className="flex items-center gap-2">
        <span className="flex-1">
          Your system's web engine is out of date, so some colors may look wrong. Update your
          operating system.
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(true)
          }}
        >
          <XIcon />
        </Button>
      </InlineAlert>
    </div>
  )
}
