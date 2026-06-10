import type { ReactElement } from 'react'
import { Trash2 } from 'lucide-react'
import { aiModelLabel, aiProvider, errorMessage, type AiModelConfig } from '@reflect/core'
import { startOperation } from '@/lib/operations'

interface AiModelRowProps {
  config: AiModelConfig
  /** Whether this entry is the (resolved) app-wide default. */
  isDefault: boolean
  /** Make this entry the app-wide default. */
  onMakeDefault: (id: string) => void
  /** Remove the entry and its keychain secret; rejects on failure. */
  onRemove: (id: string) => Promise<void>
}

/**
 * One configured AI model in the settings list: provider + model, the stored
 * key's trailing characters, and the default/remove controls. The row owns
 * its own removal (including surfacing a keychain failure as an operation).
 */
export function AiModelRow({
  config,
  isDefault,
  onMakeDefault,
  onRemove,
}: AiModelRowProps): ReactElement {
  const providerLabel = aiProvider(config.provider).label
  const modelLabel = aiModelLabel(config.provider, config.model)
  const name = `${providerLabel} — ${modelLabel}`

  const remove = (): void => {
    onRemove(config.id).catch((error: unknown) => {
      startOperation(`Removing ${name}`).fail(errorMessage(error))
    })
  }

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-text">{name}</div>
        <p className="mt-0.5 text-xs text-text-muted">
          API key <span className="font-mono">·····{config.keyHint}</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isDefault ? (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-soft-text">
            Default
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onMakeDefault(config.id)}
            className="rounded-md px-2 py-0.5 text-xs text-text-secondary transition-colors duration-100 hover:bg-surface-hover hover:text-text"
          >
            Make default
          </button>
        )}
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={remove}
          className="rounded-md p-1.5 text-text-muted transition-colors duration-100 hover:bg-surface-hover hover:text-text"
        >
          <Trash2 aria-hidden strokeWidth={1.75} className="size-4" />
        </button>
      </div>
    </div>
  )
}
