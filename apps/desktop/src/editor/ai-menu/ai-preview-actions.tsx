import type { ReactElement } from 'react'
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react'
import type { AiPromptMode, ChatModelOption } from '@reflect/core'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface AiPreviewActionsProps {
  /** The staged placement of the current run, or null while nothing runs. */
  mode: AiPromptMode | null
  /** Every configured provider/model the one-shot switch can retry with. */
  modelOptions: ChatModelOption[]
  /** Re-run the transform; `null` keeps the model of the previous run. */
  onRetry: (option: ChatModelOption | null) => void
  /** Accept with the placement opposite to the staged one (old Reflect's Replace/Insert choice). */
  onAcceptAs: (mode: AiPromptMode) => void
}

/**
 * The AI preview's extra controls (rendered in meowdown's pending-replacement
 * actions slot): retry on the same model, a one-shot model switch, and the
 * alternate placement — old Reflect let the user pick Replace vs Insert at
 * accept time, so next to the mode-default Accept the other placement stays
 * one click away.
 */
export function AiPreviewActions({
  mode,
  modelOptions,
  onRetry,
  onAcceptAs,
}: AiPreviewActionsProps): ReactElement {
  return (
    <div className="flex items-center">
      <Button variant="ghost" size="sm" onClick={() => onRetry(null)}>
        <RotateCcwIcon data-icon="inline-start" />
        Retry
      </Button>
      {modelOptions.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="sm" aria-label="Retry with another model">
                <ChevronDownIcon />
              </Button>
            }
          />
          <DropdownMenuContent align="start">
            {modelOptions.map((option) => (
              <DropdownMenuItem
                key={`${option.configId}:${option.modelId}`}
                onClick={() => onRetry(option)}
              >
                {option.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {mode !== null ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onAcceptAs(mode === 'replace' ? 'append' : 'replace')}
        >
          {mode === 'replace' ? 'Insert below' : 'Replace selection'}
        </Button>
      ) : null}
    </div>
  )
}
