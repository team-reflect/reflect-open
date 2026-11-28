import type { ReactElement } from 'react'
import {
  SEMANTIC_SEARCH_DESCRIPTION,
  semanticSearchStatusLabel,
  useSemanticSearchControls,
} from '@/lib/use-semantic-search-controls.ts'
import {
  SettingsActionRow,
  SettingsGroup,
  SettingsSwitchRow,
  SettingsValueRow,
} from './settings-list.tsx'

const FOOTER_ID = 'semantic-search-footer'

/**
 * The semantic search group of the mobile settings: the opt-in switch, the
 * status of the model download and the first indexing pass. Hidden where the runtime is `unsupported`.
 */
export function SemanticSearchGroup(): ReactElement | null {
  const { phase, enable, disable, retry, downloadNow } = useSemanticSearchControls()

  if (phase.kind === 'unsupported') {
    return null
  }

  const footer = (
    <>
      {SEMANTIC_SEARCH_DESCRIPTION}
      {phase.kind === 'indexing' ? (
        <span className="mt-1 block">
          Keep Reflect open to finish indexing. The screen stays on until then.
        </span>
      ) : null}
      {phase.kind === 'failed' ? (
        <span className="mt-1 block">Couldn’t load the model: {phase.message}</span>
      ) : null}
    </>
  )

  return (
    <SettingsGroup header="Search" footer={footer} footerId={FOOTER_ID}>
      <SettingsSwitchRow
        label="Semantic search"
        checked={phase.kind !== 'off'}
        onCheckedChange={(checked) => (checked ? enable() : disable())}
        descriptionId={FOOTER_ID}
      />
      {phase.kind === 'off' ? null : (
        <SettingsValueRow label="Status" value={semanticSearchStatusLabel(phase)} />
      )}
      {phase.kind === 'waiting' ? (
        <SettingsActionRow label="Download Now" onPress={downloadNow} />
      ) : null}
      {phase.kind === 'failed' ? <SettingsActionRow label="Try again" onPress={retry} /> : null}
    </SettingsGroup>
  )
}
