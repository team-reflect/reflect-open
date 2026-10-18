import { z } from 'zod'

const LicenseEntrySchema = z.object({
  name: z.string(),
  ecosystem: z.enum(['npm', 'cargo', 'other']),
  license: z.string(),
  url: z.string().optional(),
  /** Indexes into {@link Licenses.texts}; empty when the package ships no license file. */
  texts: z.array(z.number()),
})

const LicensesSchema = z.object({
  entries: z.array(LicenseEntrySchema),
  texts: z.array(z.string()),
})

export type LicenseEntry = z.infer<typeof LicenseEntrySchema>
export type Licenses = z.infer<typeof LicensesSchema>

/** Loads the generated notices, which Vite splits into their own lazy chunk. */
export async function loadLicenses(): Promise<Licenses> {
  const { default: data } = await import('./licenses.gen.json')
  return LicensesSchema.parse(data)
}

export function entryKey(entry: LicenseEntry): string {
  return `${entry.ecosystem}:${entry.name}`
}
