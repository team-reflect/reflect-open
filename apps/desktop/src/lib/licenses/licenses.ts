import { once } from '@ocavue/utils'
import { z } from 'zod'

const LicenseEntrySchema = z.object({
  name: z.string(),
  ecosystem: z.enum(['npm', 'cargo', 'other']),
  license: z.string(),
  url: z.string().optional(),
  /** Keys into {@link Licenses.texts}; empty when the package ships no license file. */
  texts: z.array(z.string()),
})

const LicensesSchema = z.object({
  entries: z.array(LicenseEntrySchema),
  /** License texts keyed by a hash of their content. */
  texts: z.record(z.string(), z.string()),
})

export type LicenseEntry = z.infer<typeof LicenseEntrySchema>
export type Licenses = z.infer<typeof LicensesSchema>

/** Loads the generated notices, which Vite splits into their own lazy chunk. */
async function loadLicenses(): Promise<Licenses> {
  const { default: data } = await import('./licenses.gen.json')
  return LicensesSchema.parse(data)
}

/**
 * The notices, loaded on the first call. Every call returns the same promise,
 * so it can be passed to React's `use`.
 */
export const getLicenses: () => Promise<Licenses> = /* @__PURE__ */ once(loadLicenses)

export function getEntryKey(entry: LicenseEntry): string {
  return `${entry.ecosystem}:${entry.name}`
}
