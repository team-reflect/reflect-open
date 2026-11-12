import { useState, type ReactElement } from 'react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import { aiModelLabel, type AiModelOption, type AiProviderId } from '@reflect/core'
import { getIsComposing } from '@meowdown/core'
import { Button } from '@/components/ui/button.tsx'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from '@/components/ui/combobox.tsx'

interface ModelComboboxProps {
  /** Currently selected model id (may be a custom string not in the catalog). */
  value: string
  /** Provider whose curated model list to show. */
  provider: AiProviderId
  /** Curated options for quick-select (most capable first). */
  models: AiModelOption[]
  /** Called with the new model id — either a catalog id or a custom string. */
  onChange: (modelId: string) => void
  /** Accessible name for the trigger when multiple model pickers are visible. */
  ariaLabel?: string
}

/**
 * A combobox for selecting an AI model. Shows the provider's curated models
 * as quick-select options (searchable by label or id) and also accepts any
 * arbitrary model string — type a custom id and press Enter to confirm it.
 */
export function ModelCombobox({
  value,
  provider,
  models,
  onChange,
  ariaLabel = 'Default model',
}: ModelComboboxProps): ReactElement {
  const [inputValue, setInputValue] = useState('')

  return (
    <Combobox
      items={models}
      itemToStringLabel={(model: AiModelOption) => `${model.label} ${model.id}`}
      value={models.find((model) => model.id === value) ?? null}
      onValueChange={(model: AiModelOption | null) => {
        if (model !== null) {
          onChange(model.id)
        }
      }}
      inputValue={inputValue}
      onInputValueChange={setInputValue}
      autoHighlight
    >
      <ComboboxTrigger
        render={
          <Button
            type="button"
            variant="outline"
            aria-label={ariaLabel}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className="truncate">{aiModelLabel(provider, value)}</span>
      </ComboboxTrigger>
      <ComboboxContent>
        <ModelSearchInput inputValue={inputValue} onCustom={onChange} />
        <ComboboxEmpty>
          Press <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-xs">Enter</kbd> to use
          &ldquo;{inputValue}&rdquo;
        </ComboboxEmpty>
        <ComboboxList>
          {(model: AiModelOption) => (
            <ComboboxItem key={model.id} value={model}>
              {model.label}
              <span className="ml-auto font-mono text-xs text-muted-foreground">{model.id}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

interface ModelSearchInputProps {
  inputValue: string
  /** Called with the typed text when no catalog model matches it. */
  onCustom: (modelId: string) => void
}

function ModelSearchInput({ inputValue, onCustom }: ModelSearchInputProps): ReactElement {
  // The combobox's own filter result, so custom entry follows its matching rules.
  const filteredModels = ComboboxPrimitive.useFilteredItems<AiModelOption>()

  return (
    <ComboboxInput
      showTrigger={false}
      placeholder="Search or type a model name…"
      onKeyDown={(event) => {
        if (getIsComposing()) {
          // The Enter that commits a composition must not pick the highlighted model.
          if (event.key === 'Enter') {
            event.preventDefault()
            event.preventBaseUIHandler()
          }
          return
        }
        // With no model left in the list, Enter takes the typed text as a custom id.
        if (event.key === 'Enter' && filteredModels.length === 0 && inputValue.trim()) {
          event.preventDefault()
          onCustom(inputValue.trim())
        }
      }}
    />
  )
}
