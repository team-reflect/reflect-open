import { useEffect, useState, type ReactElement } from 'react'
import { Check, Copy } from 'lucide-react'
import { errorMessage } from '@reflect/core'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { startOperation } from '@/lib/operations'

interface ChatCopyButtonProps {
  /** The markdown put on the clipboard when the button is pressed. */
  text: string
}

const COPY_RESET_MS = 1400

/**
 * Copies one assistant reply to the clipboard. The check mark is the whole
 * confirmation — a toast per copy would be noise — so only a failed write
 * raises an operation, where it would otherwise be silent.
 */
export function ChatCopyButton({ text }: ChatCopyButtonProps): ReactElement {
  const [isCopied, setIsCopied] = useState(false)

  // Reset the check mark whenever the reply changes underneath it.
  const [appliedText, setAppliedText] = useState(text)
  if (appliedText !== text) {
    setAppliedText(text)
    setIsCopied(false)
  }

  useEffect(() => {
    if (!isCopied) {
      return
    }
    const timeout = window.setTimeout(() => setIsCopied(false), COPY_RESET_MS)
    return () => window.clearTimeout(timeout)
  }, [isCopied])

  const copyReply = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setIsCopied(true)
    } catch (cause) {
      startOperation('Copying the reply').fail(errorMessage(cause))
    }
  }

  const Icon = isCopied ? Check : Copy

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Copy reply"
            onClick={() => void copyReply()}
            className="text-text-muted hover:text-text"
          >
            <Icon aria-hidden className="size-3.5" />
          </Button>
        }
      />
      <TooltipContent>{isCopied ? 'Copied' : 'Copy reply'}</TooltipContent>
    </Tooltip>
  )
}
