/** `/.../Documents/My Notes` -> `My Notes`. */
export function graphNameFromRoot(root: string, fallback = ''): string {
  return root.split('/').filter(Boolean).at(-1) ?? fallback
}

/**
 * A graph folder name safe to create inside an app-owned container: no
 * separators, no leading dot, trimmed.
 */
export function cleanGraphName(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.startsWith('.')) {
    return null
  }
  if (/[/\\:]/.test(trimmed)) {
    return null
  }
  return trimmed
}

/** Case-insensitive graph-name collision check for macOS/iOS containers. */
export function isGraphNameTaken(cleanName: string, roots: readonly string[]): boolean {
  return roots.some((root) => graphNameFromRoot(root).toLowerCase() === cleanName.toLowerCase())
}

/** Absolute graph root for a cleaned folder name inside a container's Documents directory. */
export function graphRootForName(documentsRoot: string, cleanName: string): string {
  return `${documentsRoot}/${cleanName}`
}
