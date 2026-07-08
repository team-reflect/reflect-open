const PUNCTUATION_RE = /[\p{P}\p{S}]/gu

function normalizedBreadcrumb(text: string): string {
  return text.replace(/\s+/g, '').replace(PUNCTUATION_RE, '')
}

export function visibleTaskBreadcrumbs(breadcrumbs: readonly string[]): string[] {
  const visible = breadcrumbs.map((text) => text.trim()).filter((text) => text.length > 0)
  if (visible.length !== 1) {
    return visible
  }
  return /^(?:task|todo)s?$/i.test(normalizedBreadcrumb(visible[0]!)) ? [] : visible
}
