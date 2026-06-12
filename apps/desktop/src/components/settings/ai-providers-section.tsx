import { useState, type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { useAiProviders } from '@/hooks/use-ai-providers'
import { Button } from '@/components/ui/button'
import { AddAiProviderDialog } from './add-ai-provider-dialog'
import { AiProviderRow } from './ai-provider-row'
import { SettingsSection } from './section'

/**
 * Settings → AI providers (Plan 10): the configured BYOK providers. Each
 * entry pairs a provider + default model choice (persisted in the settings
 * document) with an API key (persisted in the OS keychain); the list shows
 * which is the app-wide default and only the key's trailing characters.
 */
export function AiProvidersSection(): ReactElement {
  const { providers, defaultProvider, addProvider, removeProvider, makeDefault } = useAiProviders()
  const [adding, setAdding] = useState(false)

  return (
    <SettingsSection id="ai-providers">
      {providers.length === 0 ? (
        <p className="px-4 py-3.5 text-xs text-text-muted">
          No AI providers configured. Add a provider API key to use AI features — keys
          are stored in your OS keychain and calls go directly to the provider.
        </p>
      ) : (
        providers.map((config) => (
          <AiProviderRow
            key={config.id}
            config={config}
            isDefault={config.id === defaultProvider?.id}
            onMakeDefault={makeDefault}
            onRemove={removeProvider}
          />
        ))
      )}
      <div className="px-4 py-2.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setAdding(true)}
          className="text-accent hover:bg-surface-hover"
        >
          <Plus aria-hidden strokeWidth={1.75} />
          Add provider
        </Button>
      </div>
      {adding ? <AddAiProviderDialog onAdd={addProvider} onClose={() => setAdding(false)} /> : null}
    </SettingsSection>
  )
}
