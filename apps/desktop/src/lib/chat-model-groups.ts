import { aiProvider, type AiProviderConfig, type ChatModelOption } from '@reflect/core'

/** One configured provider's models, shaped for a picker. */
export interface ModelOptionGroup {
  configId: string
  /** Provider label, key-hint-qualified when the provider is configured twice. */
  label: string
  /** The group's models, each with its picker value (index into the options). */
  options: Array<{ option: ChatModelOption; value: string }>
}

/**
 * The flat option list regrouped per configured provider for rendering
 * (options arrive consecutively per entry). Values are list indexes — model
 * ids alone can collide across providers. Shared by desktop's composer
 * `Select` and the mobile model sheet.
 */
export function groupModelOptions(
  options: ChatModelOption[],
  providers: AiProviderConfig[],
): ModelOptionGroup[] {
  const groups: ModelOptionGroup[] = []
  options.forEach((option, index) => {
    const item = { option, value: String(index) }
    const last = groups.at(-1)
    if (last?.configId === option.configId) {
      last.options.push(item)
      return
    }
    const providerLabel = aiProvider(option.provider).label
    const duplicated =
      providers.filter((provider) => provider.provider === option.provider).length > 1
    const keyHint = providers.find((provider) => provider.id === option.configId)?.keyHint ?? ''
    groups.push({
      configId: option.configId,
      label: duplicated && keyHint !== '' ? `${providerLabel} ·····${keyHint}` : providerLabel,
      options: [item],
    })
  })
  return groups
}
