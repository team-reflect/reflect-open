import { useState, type ReactElement, type ReactNode } from 'react'
import { Info, Sparkles } from 'lucide-react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import {
  SEMANTIC_SEARCH_DESCRIPTION,
  semanticSearchDetails,
  semanticSearchStatusLabel,
  useSemanticSearchControls,
  type SemanticSearchPhase,
} from '@/lib/use-semantic-search-controls.ts'
import { DescribeAssetsField } from './describe-assets-field.tsx'
import { SettingsField } from './field.tsx'
import { RebuildIndexField } from './rebuild-index-field.tsx'
import { SettingsSection } from './section.tsx'

const BUTTON_CLASS =
  'shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover'

// The determinate fraction of a phase with a progress bar; `null` for an indeterminate bar.
function progressOf(phase: SemanticSearchPhase): number | null {
  switch (phase.kind) {
    case 'downloading':
      return phase.fraction
    case 'indexing':
      return phase.total > 0 ? phase.done / phase.total : null
    default:
      return null
  }
}

function ProgressBar({ phase }: { phase: SemanticSearchPhase }): ReactElement {
  const fraction = progressOf(phase)
  return (
    <div
      role="progressbar"
      aria-label="Semantic search progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction !== null ? Math.round(fraction * 100) : undefined}
      className="h-1.5 overflow-hidden rounded-full bg-accent-soft"
    >
      {fraction !== null ? (
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-200"
          style={{ width: `${fraction * 100}%` }}
        />
      ) : (
        <div className="h-full w-full animate-pulse rounded-full bg-accent/40" />
      )}
    </div>
  )
}

/**
 * The search settings: the semantic-search opt-in (Plan 09) and the index
 * rebuild action. The semantic search control follows the same phases as the
 * mobile settings: the model download and the first indexing pass show as a
 * progress bar, and the details sit behind the info button.
 */
export function SearchSection(): ReactElement {
  const { phase, enable, disable, retry, downloadNow } = useSemanticSearchControls()
  const [detailsOpen, setDetailsOpen] = useState(false)

  let control: ReactNode
  switch (phase.kind) {
    case 'unsupported':
      control = (
        <p className="text-xs text-text-muted">Semantic search is not available on this device.</p>
      )
      break
    case 'off':
      control = (
        <button
          type="button"
          onClick={enable}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover"
        >
          <Sparkles aria-hidden strokeWidth={1.75} className="size-3.5" />
          Enable semantic search
        </button>
      )
      break
    case 'failed':
      control = (
        <div>
          <InlineAlert tone="error">Couldn’t load the model: {phase.message}</InlineAlert>
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={retry} className={BUTTON_CLASS}>
              Try again
            </button>
            <button type="button" onClick={disable} className={BUTTON_CLASS}>
              Disable
            </button>
          </div>
        </div>
      )
      break
    default:
      control = (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            {phase.kind === 'ready' ? (
              <span className="flex items-center gap-2 text-xs text-text-muted">
                <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
                {semanticSearchStatusLabel(phase)}
              </span>
            ) : (
              <>
                {phase.kind === 'waiting' ? null : <ProgressBar phase={phase} />}
                <p className="mt-1.5 text-xs text-text-muted">{semanticSearchStatusLabel(phase)}</p>
              </>
            )}
          </div>
          {phase.kind === 'waiting' ? (
            <button type="button" onClick={downloadNow} className={BUTTON_CLASS}>
              Download Now
            </button>
          ) : null}
          <button type="button" onClick={disable} className={BUTTON_CLASS}>
            Disable
          </button>
        </div>
      )
  }

  const description = (
    <>
      {SEMANTIC_SEARCH_DESCRIPTION}{' '}
      {phase.kind === 'unsupported' ? null : (
        <button
          type="button"
          aria-label="About semantic search"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen(!detailsOpen)}
          className="inline-flex size-4 items-center justify-center rounded-sm align-text-bottom text-text-muted transition-colors duration-100 hover:text-text"
        >
          <Info aria-hidden strokeWidth={1.75} className="size-3.5" />
        </button>
      )}
      {detailsOpen && phase.kind !== 'unsupported'
        ? semanticSearchDetails(phase).map((line) => (
            <span key={line} className="mt-1 block break-words">
              {line}
            </span>
          ))
        : null}
    </>
  )

  return (
    <SettingsSection id="search">
      <SettingsField legend="Semantic search" description={description}>
        <div className="mt-3">{control}</div>
      </SettingsField>
      <DescribeAssetsField />
      <RebuildIndexField />
    </SettingsSection>
  )
}
