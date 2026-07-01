import type { ReactElement } from 'react'
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react'
import type { ChatModelOption } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface AiRetryActionsProps {
  /** Every configured provider/model the one-shot switch can retry with. */
  modelOptions: ChatModelOption[]
  /** Re-run the transform; `null` keeps the model of the previous run. */
  onRetry: (option: ChatModelOption | null) => void
}

/**
 * The AI preview's retry control (rendered in meowdown's pending-replacement
 * actions slot): plain retry re-runs on the same model, and the chevron offers
 * a one-shot model switch from the configured providers — the pick applies to
 * this retry only, never persisted.
 */
export function AiRetryActions({ modelOptions, onRetry }: AiRetryActionsProps): ReactElement {
  return (
    <div className="flex items-center">
      <Button variant="ghost" size="sm" onClick={() => onRetry(null)}>
        <RotateCcwIcon data-icon="inline-start" />
        Retry
      </Button>
      {modelOptions.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Retry with another model">
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {modelOptions.map((option) => (
              <DropdownMenuItem
                key={`${option.configId}:${option.modelId}`}
                onSelect={() => onRetry(option)}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
