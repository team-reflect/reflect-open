export interface LicenseEntry {
  name: string
  ecosystem: 'npm' | 'cargo' | 'other'
  license: string
  url?: string | undefined
  /** Keys into {@link Licenses.texts}; empty when the package ships no license file. */
  texts: string[]
}

export interface Licenses {
  entries: LicenseEntry[]
  /** License texts keyed by a hash of their content. */
  texts: Record<string, string>
}

/** Loads the generated notices, which Vite splits into their own lazy chunk. */
export async function loadLicenses(): Promise<Licenses> {
  const { default: data } = await import('./licenses.gen.json')
  return data as Licenses
}

export function entryKey(entry: LicenseEntry): string {
  return `${entry.ecosystem}:${entry.name}`
}
