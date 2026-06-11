import type { ReactElement } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { keybindingFor } from '@/lib/commands/app-commands'
import { formatBindingLabel } from '@/lib/keybindings'
import { useRouter } from '@/routing/router'

const BACK_BINDING = keybindingFor('history.back')
const FORWARD_BINDING = keybindingFor('history.forward')

function buttonTitle(label: string, binding: string | null): string {
  return binding !== null ? `${label} (${formatBindingLabel(binding)})` : label
}

/**
 * The sidebar's back/forward history arrows (the original app's
 * `NavigateArrows`): ghost chevron buttons over the router's history stack,
 * disabled at either end of it.
 */
export function NavigateArrows(): ReactElement {
  const { back, forward, canBack, canForward } = useRouter()

  const buttonClass =
    'rounded-md p-1 text-text-muted transition-colors duration-100 ' +
    'hover:bg-surface-hover hover:text-text disabled:opacity-50 ' +
    'disabled:hover:bg-transparent disabled:hover:text-text-muted'

  return (
    <div className="flex items-center">
      <button
        type="button"
        aria-label="Go back"
        title={buttonTitle('Go back', BACK_BINDING)}
        disabled={!canBack}
        onClick={back}
        className={buttonClass}
      >
        <ChevronLeft aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Go forward"
        title={buttonTitle('Go forward', FORWARD_BINDING)}
        disabled={!canForward}
        onClick={forward}
        className={buttonClass}
      >
        <ChevronRight aria-hidden className="size-4" />
      </button>
    </div>
  )
}
