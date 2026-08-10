import { z } from 'zod'
import { call } from '../ipc/invoke'

/**
 * Typed bindings for the Zotero link picker (desktop): search the local
 * Zotero library through Zotero 7's built-in Local API and turn a picked item
 * into a markdown deep link.
 *
 * Rust owns the capability — `apps/desktop/src-tauri/src/zotero.rs` fetches
 * `http://127.0.0.1:23119/api/users/0/items` and normalizes the response. This
 * module owns the policy: which item fields compose the picker display, and
 * which markdown an item becomes (`{@link zoteroItemLink}`). Nothing here
 * touches the index and no data leaves the machine.
 */

/** One searchable Zotero library item, as normalized by the Rust command. */
export const zoteroItemSchema = z.object({
  /** The 8-character Zotero item key — the `zotero://` deep-link target. */
  key: z.string(),
  title: z.string(),
  /** Creator display names in document order ("Smith, John"). */
  creators: z.array(z.string()),
  /** The item's `date` field as authored ("2020-01-01", "2020", "n.d."). */
  date: z.string().nullable(),
  itemType: z.string(),
})

export type ZoteroItem = z.infer<typeof zoteroItemSchema>

/** Search the local Zotero library by title/creator/year. */
export async function zoteroSearch(query: string): Promise<ZoteroItem[]> {
  return await call('zotero_search', { query }, z.array(zoteroItemSchema))
}

/** A picker display summary: "Title — Smith, 2020" (empty parts dropped). */
export function zoteroItemSummary(item: ZoteroItem): string {
  const parts = [item.creators[0], yearOf(item.date)]
  return parts.filter((part): part is string => part != null && part !== '').join(', ')
}

/**
 * The year prefix of a Zotero `date` field ("2020-01-02" → "2020"). Non-year
 * dates — "n.d.", "circa 1950", malformed values — yield nothing rather than
 * a misleading display part.
 */
function yearOf(date: string | null): string | null {
  if (date === null) {
    return null
  }
  const year = date.split('-')[0]?.trim() ?? ''
  return /^\d{4}$/.test(year) ? year : null
}

/**
 * The markdown link an item inserts at the caret:
 * `[Title](zotero://select/library/items/KEY)` — the deep link the Zotero
 * desktop app registered for "select this item". Brackets in the title are
 * escaped so an authored title can never break out of the link text.
 */
export function zoteroItemLink(item: ZoteroItem): string {
  const label = item.title.trim() === '' ? 'Zotero item' : item.title.trim()
  return `[${escapeLinkText(label)}](zotero://select/library/items/${item.key})`
}

/** Escape backslash and brackets — the characters that delimit link text. */
function escapeLinkText(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('[', String.raw`\[`)
    .replaceAll(']', String.raw`\]`)
}
