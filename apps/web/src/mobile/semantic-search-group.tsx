import { useState, type ReactElement } from 'react'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  SEMANTIC_SEARCH_DESCRIPTION,
  SEMANTIC_SEARCH_DOWNLOAD_CONSENT,
  semanticSearchDetails,
  semanticSearchStatusLabel,
  useSemanticSearchControls,
  type SemanticSearchControls,
} from '@/lib/use-semantic-search-controls.ts'
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from '@/mobile/scroll-drawer.tsx'
import {
  SettingsActionRow,
  SettingsGroup,
  SettingsSwitchRow,
  SettingsValueRow,
} from './settings-list.tsx'

const FOOTER_ID = 'semantic-search-footer'

function DownloadConsentDrawer({
  consent,
}: {
  consent: SemanticSearchControls['consent']
}): ReactElement {
  return (
    <Drawer open={consent.open} onOpenChange={(open) => (open ? undefined : consent.dismiss())}>
      <DrawerContent>
        <DrawerTitle>{SEMANTIC_SEARCH_DOWNLOAD_CONSENT.title}</DrawerTitle>
        <DrawerBody>
          <DrawerDescription>{SEMANTIC_SEARCH_DOWNLOAD_CONSENT.message}</DrawerDescription>
          <div className="flex flex-col gap-2 pt-2">
            <Button className="h-12 w-full text-base" onClick={consent.confirm}>
              {SEMANTIC_SEARCH_DOWNLOAD_CONSENT.confirm}
            </Button>
            <Button variant="ghost" className="h-12 w-full text-base" onClick={consent.dismiss}>
              {SEMANTIC_SEARCH_DOWNLOAD_CONSENT.dismiss}
            </Button>
          </div>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}

/**
 * The semantic search group of the mobile settings: the opt-in switch, the
 * status of the model download and the first indexing pass, and the details
 * behind the info button. Hidden where the runtime is `unsupported`.
 */
export function SemanticSearchGroup(): ReactElement | null {
  const { phase, enable, disable, retry, downloadNow, consent } = useSemanticSearchControls()
  const [detailsOpen, setDetailsOpen] = useState(false)

  if (phase.kind === 'unsupported') {
    return null
  }

  const footer = (
    <>
      {SEMANTIC_SEARCH_DESCRIPTION}{' '}
      <button
        type="button"
        aria-label="About semantic search"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen(!detailsOpen)}
        className="inline-flex size-4 items-center justify-center align-text-bottom text-text-secondary"
      >
        <Info aria-hidden strokeWidth={2} className="size-3.5" />
      </button>
      {detailsOpen
        ? semanticSearchDetails(phase).map((line) => (
            <span key={line} className="mt-1 block break-words">
              {line}
            </span>
          ))
        : null}
      {phase.kind === 'failed' ? (
        <span className="mt-1 block">Couldn’t load the model: {phase.message}</span>
      ) : null}
    </>
  )

  return (
    <>
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
      <DownloadConsentDrawer consent={consent} />
    </>
  )
}
