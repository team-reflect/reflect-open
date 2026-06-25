/** Header Anthropic requires when its API is called directly from browser code. */
export const ANTHROPIC_DIRECT_BROWSER_ACCESS_HEADER =
  'anthropic-dangerous-direct-browser-access'

/** Opt-in value for {@link ANTHROPIC_DIRECT_BROWSER_ACCESS_HEADER}. */
export const ANTHROPIC_DIRECT_BROWSER_ACCESS_VALUE = 'true'

/** Headers shared by Anthropic validation and model calls. */
export function anthropicDirectBrowserAccessHeaders(): Record<string, string> {
  return {
    [ANTHROPIC_DIRECT_BROWSER_ACCESS_HEADER]: ANTHROPIC_DIRECT_BROWSER_ACCESS_VALUE,
  }
}
