import { useState, type ReactElement } from 'react'
import { Plus } from 'lucide-react'
import { useAiModels } from '@/hooks/use-ai-models'
import { AddAiModelDialog } from './add-ai-model-dialog'
import { AiModelRow } from './ai-model-row'
import { SettingsSection } from './section'

/**
 * Settings → AI models (Plan 10): the configured BYOK providers. Each entry
 * pairs a provider + model choice (persisted in the settings document) with
 * an API key (persisted in the OS keychain); the list shows which is the
 * app-wide default and only the key's trailing characters.
 */
export function AiModelsSection(): ReactElement {
  const { models, defaultModel, addModel, removeModel, makeDefault } = useAiModels()
  const [adding, setAdding] = useState(false)

  return (
    <SettingsSection title="AI models">
      {models.length === 0 ? (
        <p className="px-4 py-3.5 text-xs text-text-muted">
          No AI models configured. Add a provider API key to use AI features — keys are
          stored in your OS keychain and calls go directly to the provider.
        </p>
      ) : (
        models.map((config) => (
          <AiModelRow
            key={config.id}
            config={config}
            isDefault={config.id === defaultModel?.id}
            onMakeDefault={makeDefault}
            onRemove={removeModel}
          />
        ))
      )}
      <div className="px-4 py-2.5">
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] font-medium text-accent transition-colors duration-100 hover:bg-surface-hover"
        >
          <Plus aria-hidden strokeWidth={1.75} className="size-4" />
          Add model
        </button>
      </div>
      {adding ? <AddAiModelDialog onAdd={addModel} onClose={() => setAdding(false)} /> : null}
    </SettingsSection>
  )
}
