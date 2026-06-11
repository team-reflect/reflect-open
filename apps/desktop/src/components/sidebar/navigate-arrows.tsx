import type { ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { keybindingFor } from '@/lib/commands/app-commands'
import { useRouter } from '@/routing/router'

const BACK_BINDING = keybindingFor('history.back')
const FORWARD_BINDING = keybindingFor('history.forward')

const BUTTON_CLASS =
  'rounded-md p-1 text-text-muted transition-colors duration-100 ' +
  'hover:bg-surface-hover hover:text-text disabled:opacity-50 ' +
  'disabled:hover:bg-transparent disabled:hover:text-text-muted'

/**
 * The sidebar's back/forward history arrows (the original app's
 * `NavigateArrows`): ghost chevron buttons over the router's history stack,
 * disabled at either end of it.
 */
export function NavigateArrows(): ReactElement {
  const { back, forward, canBack, canForward } = useRouter()

  return (
    // The arrows sit inside the overlaid macOS title-bar band, where the
    // WindowDragRegion strip (z-40, mounted before the app) would otherwise
    // swallow their clicks into a window drag. Matching its z-index puts the
    // buttons above it by tree order while same-z overlays mounted later
    // (the command palette) still cover them.
    <div className="relative z-40 flex items-center">
      <Tooltip>
        {/* Span wrapper keeps pointer events alive when the button is disabled,
            so the tooltip still opens at the start of the history stack. */}
        <TooltipTrigger asChild>
          <span>
            <button
              type="button"
              aria-label="Go back"
              disabled={!canBack}
              onClick={back}
              className={BUTTON_CLASS}
            >
              <ChevronLeft aria-hidden className="size-4" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Go back {BACK_BINDING && <ShortcutKeys binding={BACK_BINDING} />}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <button
              type="button"
              aria-label="Go forward"
              disabled={!canForward}
              onClick={forward}
              className={BUTTON_CLASS}
            >
              <ChevronRight aria-hidden className="size-4" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Go forward {FORWARD_BINDING && <ShortcutKeys binding={FORWARD_BINDING} />}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
