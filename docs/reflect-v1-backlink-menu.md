# Reflect V1: Backlink Menu & Date Generator

This document describes the **backlink autocomplete menu** in Reflect V1 — the popup
that appears when you type `[[` in the editor — with a focus on its **relative-date
generator** (the "3 days ago", "next Friday", "1 week from now" suggestions). It is a
reference for the V2 rewrite.

All file paths refer to the **V1 codebase** (`~/repos/reflect`, a Next.js + MobX app),
not this repository. For broader product context see
[Reflect V1 Overview](./reflect-v1-overview.md).

## What It Is

When you type `[[` in a note, V1 opens a backlink autocomplete menu. As you type the
query, the menu is populated from **two merged sources**:

1. **Existing backlinks** — notes, contacts, and aliases already in the graph that
   match the query (from the SQLite-backed backlink store).
2. **Generated date suggestions** — virtual targets the user has almost certainly *not*
   created yet, synthesized on the fly from the query: calendar dates, relative offsets
   ("3 days ago"), and natural-language dates ("next Friday", "yesterday").

The second source is the interesting part. It means a user can type `[[3 days ago` or
`[[next monday` or `[[12/25` and link straight to that **daily note** — creating it
lazily if it doesn't exist yet — without ever leaving the editor or knowing the exact
date.

## Where It Lives (Wiring)

The `[[` **trigger and the menu rendering** live inside the closed-source editor
package `@team-reflect/reflect-editor` (v0.27.1 in V1), so they are not in the app repo.
What the app owns is the **data source**: a `backlinkGenerator` callback handed to the
`<ReflectEditor>` component. The editor calls it on every keystroke and renders whatever
it returns.

The callback is `NoteDocumentView.generateBacklink`
(`client/models/note/note-document-view.ts:206`), wired in at both editor mount sites:

- Daily stream rows — `client/screens/main/notes-daily/note-item.tsx:241`
- Single-note editor — `client/screens/main/note-edit/note-edit-main.tsx:261`

```
<ReflectEditor
  backlinkGenerator={docView.generateBacklink}   // query → Backlink[]
  onBacklinkAdd={docView.handleBacklinkAdd}       // selection → create/link note
  ...
/>
```

`generateBacklink` delegates to a `BacklinkGenerator`, rebuilt as a MobX `@computed`
whenever the note or preferences change, and seeded with the user's date preferences
and the current note (to exclude self-links):

```ts
// note-document-view.ts:193
get backlinkGenerator() {
  const { dateFormat, weekStart } = this.preferenceStore
  return new BacklinkGenerator({
    backlinkStore: this.backlinkStore,
    dateFormat,
    weekStart,
    excludeNote: this.note,
  })
}
```

## The Combined Generator: `BacklinkGenerator`

`helpers/generator/backlink-generator.ts` orchestrates the two sources.

**Empty query** → returns a small sample of existing backlinks for the menu's resting
state (`sampleMaxItems = 5`, de-duplicated by id; `getSampleBacklinks`).

**Non-empty query** → runs the note search and the date generator, then merges and
sorts (`generate`, `backlink-generator.ts:43`):

```ts
const normalizedQuery = normalizeString(query)          // strips/normalizes, keeps accents
const matchingBacklinks = await backlinkStore.searchBacklinks(normalizedQuery, maxItems) // up to 50
const dateBacklinks = this.dateGenerator.generate(normalizedQuery)                       // up to 3
return this.normalizeBacklinks([...dateBacklinks, ...matchingBacklinks], normalizedQuery)
```

Sort/filter rules (`normalizeBacklinks`):

1. **Date suggestions come first** (they're prepended before the store results).
2. The current note is filtered out (`excludeNote`), so you can't link a note to itself.
3. An **exact label match** (`normalizedLabel === normalizedQuery`) is hoisted to the
   very top via a stable `sortBy`.
4. The list is capped at `maxItems` (default 50).

So for `[[today` the **generated** "Today" date suggestion outranks an existing note
literally titled "Today custom" (see `backlink-generator.test.ts:183`).

## The Date Generator: `BacklinkDateGenerator`

`helpers/generator/backlink-date-generator.ts` is the heart of the feature. Its public
method `generate(query)` returns **at most 3** date suggestions
(`.slice(0, 3)`), and an empty array for an empty query.

It merges **three** independent matchers, then de-duplicates by calendar day
(`generateRelative`, `backlink-date-generator.ts:50`):

```ts
const dateLabels = uniqDateLabels([
  ...this.exactDateMatch(query),            // 1. typed calendar dates: "12/25", "23/2/2023"
  ...parseFuzzyDate(query),                 // 2. natural language via chrono-node
  ...this.filteredRelativeDateMatch(parsed),// 3. "N days ago" / "N weeks from now"
])
```

`uniqDateLabels` de-dupes by `date.toDateString()` and **keeps the first occurrence**
(`helpers/date-fuzzy.ts:19`). Because the array is ordered **exact → fuzzy → relative**,
that ordering is also the **label-precedence**: if two matchers land on the same day, the
*earlier* matcher's wording wins. (This is why `[[one day ago]]` is labelled
"one day ago" — chrono's fuzzy text — rather than the relative matcher's "1 day ago".)

### 1. Relative offsets ("N days ago", "3 weeks from now")

This is the generator the request is about. Given a query containing a number, it
produces eight candidate offsets from **today** (`relativeDateOptionsForQuery`,
`backlink-date-generator.ts:104`):

| Direction      | Units offered (in order)            | Label pattern                |
| -------------- | ----------------------------------- | ---------------------------- |
| Future (`add`) | day, week, month, year              | `N {unit} from now`          |
| Past (`sub`)   | day, week, month, year              | `N {unit} ago`               |

Each option is `[computedDate, label]`. The candidate list is then **filtered to those
whose label contains the query string** (`relativeDateMatch`), so typing `day` narrows to
the day rows, `week` to the week rows, `ago` to the past rows, and so on. After the
calendar-window filter (below), `generate` keeps the **top 3**.

**Number parsing** (`helpers/generator/helpers.ts`):

- `parseQueryNumber` extracts the first run of digits (`/\d+/`). No number → no relative
  suggestions.
- `replaceNumberWordsWithDigits` first rewrites spelled-out numbers **one … ten** → `1 … 10`
  (whole-word, lowercased), so `[[three days ago]]` works exactly like `[[3 days ago]]`.
  Only one through ten are supported; "eleven", "twenty", etc. are not.

**The 15-year sanity window.** Relative results are clamped to a window of ±15 years
around now (`RELATIVE_DATE_YEAR_SPAN = 15`, `helpers/generator/constants.ts`), using a
**strict, exclusive** `isAfter && isBefore` check (`isBetween`, `helpers.ts:48`). This is
why `[[1000 years]]` and even `[[17 years]]` return **nothing** — they fall outside the
window. The clamp applies to **relative matches only**; typed calendar dates and fuzzy
dates are exempt (so `[[15/3/1850]]` and `[[1/1/2300]]` still resolve — see below).

### 2. Fuzzy natural-language dates (chrono-node)

`parseFuzzyDate` (`helpers/date-fuzzy.ts`) handles human phrasings. It has two paths:

- **Curated phrase list** — if the (≥3-char) query is a substring of any entry in a
  hard-coded list, each matching phrase is run through `chrono-node`. The list is:
  - `Today`, `Yesterday`, `Tomorrow`
  - `This / Next / Last` × each weekday (`Sunday`…`Saturday`)
  - `This / Next / Last` × `week`, `weekend`, `month`

  So `[[mon]]` surfaces *This Monday*, *Next Monday*, *Last Monday*; `[[next fri]]`
  surfaces *Next Friday*; `[[yest]]` → *Yesterday*. (Queries shorter than 3 chars are
  skipped on this path.)
- **Direct chrono parse** — if nothing in the list matched, the raw query is parsed by
  chrono directly, which catches free-form phrases like `"one day ago"` or
  `"December 2nd"`. Each result is normalized to `startOfDay` and keeps chrono's matched
  `text` as the label.

### 3. Exact / typed calendar dates

`exactDateMatch` (`backlink-date-generator.ts:94`) only fires when the query *looks* like
a date — it requires a digit-then-slash (`/\d\//`). It parses with the user's
`dateFormat` via `parseDate` (`helpers/date-format.ts:83`), trying full and shorthand
forms:

- **MonthDayYear** users: `MM/dd/yyyy` → `M/d/yyyy` → `M/d`
- **DayMonthYear** users: `dd/MM/yyyy` → `d/M/yyyy` → `d/M`

**Ambiguity → two results.** A bare `[[12/10]]` is genuinely ambiguous, so the menu can
show *two* dates: one from `exactDateMatch` (respecting `dateFormat`) and one from
chrono's fuzzy parse (which does not). The V1 tests document this intentional pairing —
e.g. `12/10` yields both "12th October" (date-fns, format-respecting) and "10th December"
(chrono) — see the comment at `backlink-date-generator.test.ts:204`.

## The `Backlink` Shape & What Gets Inserted

Each suggestion is a `Backlink` (`client/models/backlink/types.ts`). Date suggestions
set four fields (`generateRelative`, `backlink-date-generator.ts:60`):

| Field         | Example                                  | Role                                                    |
| ------------- | ---------------------------------------- | ------------------------------------------------------- |
| `id`          | `relative-31122019-1-day-ago`            | Synthetic id (`relative-<ddmmyyyy>-<kebab-label>`)      |
| `label`       | `1 day ago (31st December, 2019)`        | **Display** text in the menu (phrase + resolved date)   |
| `insertLabel` | `31/12/2019`                             | What's actually **inserted** into the note as the link  |
| `dailyAt`     | `2019-12-31T00:00:00.000Z`               | The daily-note date this links to                       |

Two formatting helpers drive the strings (`helpers/date-format.ts`):

- `label` uses `formatDate` — the long form, e.g. `1st December, 2019` (DayMonthYear) or
  `December 1st, 2019` (MonthDayYear).
- `insertLabel` uses `shorthandFormatDate` — the slash form, e.g. `1/12/2019`.

So the **menu shows** the friendly relative phrase plus the resolved date, but the
**link text written into markdown** is the compact numeric date.

## What Happens on Selection

Picking a suggestion calls `onBacklinkAdd` → `handleBacklinkAdd` →
`addBacklinkToNote` (`client/actions/note/add-backlink.ts`), which resolves the target
through `findOrCreateNoteByBacklink` (`client/actions/note/find-or-create.ts`):

1. If the backlink already carries a real note `id`, that note is used.
2. **Else if `dailyAt` is set** (every date suggestion sets it), the **daily note for
   that date is found or created** (`findOrCreateDailyNoteByDate`). This is the lazy
   daily-note creation that makes `[[3 days ago]]` "just work".
3. Else, fall back to matching by subject/alias, or create a fresh regular note.

There's also a guard for markdown inserted **outside** the menu (e.g. MCP/automation):
if a backlink's label is a strict ISO date `YYYY-MM-DD` and `dailyAt` wasn't set, it's
routed to that day's daily note rather than creating a regular note titled `2026-05-04`
(`find-or-create.ts:25`).

Finally, the text inserted into the document is `insertLabel ?? label`
(`add-backlink.ts:27`) — i.e. the shorthand date for date suggestions, the plain label
for everything else.

## Worked Examples

Assuming the user is on **DayMonthYear** format and **today = Wed 1 January 2020** (the
fixture the V1 tests pin with `setSystemTime`):

| You type `[[…`   | Menu shows (top results)                                         | Inserts      |
| ---------------- | --------------------------------------------------------------- | ------------ |
| `3 days ago`     | `3 days ago (29th December, 2019)`                              | `29/12/2019` |
| `three days ago` | same as above (word → digit)                                   | `29/12/2019` |
| `1` (just `1`)   | `1 day from now`, `1 week from now`, `1 month from now` (top 3) | per pick     |
| `one day`        | `1 day from now (2nd Jan)`, `1 day ago (31st Dec)`             | per pick     |
| `today`          | `Today (1st January, 2020)`                                    | `1/1/2020`   |
| `this monday`    | `This Monday (6th January, 2020)`                              | `6/1/2020`   |
| `next fri`       | `Next Friday (…)`                                              | per pick     |
| `10/12`          | `10/12 (10th December, 2020)` **and** `10/12 (12th October, 2019)` | per pick |
| `23/2/2023`      | `23/2/2023 (23rd February, 2023)`                             | `23/2/2023`  |
| `17 years`       | *(nothing — outside the ±15-year window)*                      | —            |
| `1000 years`     | *(nothing)*                                                    | —            |

## Quirks & Gotchas

- **`weekStart` is plumbed but unused.** `BacklinkDateGenerator` stores `weekStart` but
  never reads it; the "this/next/last week" semantics come entirely from chrono-node's
  defaults. The `previousDay` helper in `helpers/generator/helpers.ts:38` is likewise
  exported but unused by the generator.
- **Exclusive window bounds.** `isBetween` uses strict `isAfter`/`isBefore`, so the exact
  ±15-year boundary day is excluded, not included. Edge-case, but worth matching exactly
  if V2 reimplements the clamp.
- **Label precedence is order-dependent**, not preference-driven: exact → fuzzy →
  relative, first-wins on a per-day basis. Reordering the merge would silently change the
  wording users see.
- **`dateFormat` is only half-respected.** `date-fns`-based parsing honors the user's
  M/d vs d/M preference; chrono-node does not. The deliberate two-result pairing for
  ambiguous shorthand dates is the visible symptom.
- **Typo'd ordinals pass through.** The generator doesn't validate ordinal suffixes — the
  test fixture's `31th December` is preserved verbatim in the label even though chrono
  still resolves the correct date.

## Key Files

| Concern                                  | File                                                        |
| ---------------------------------------- | ---------------------------------------------------------- |
| Combined generator (merge + sort)        | `helpers/generator/backlink-generator.ts`                  |
| **Date generator** (relative/exact/fuzzy)| `helpers/generator/backlink-date-generator.ts`             |
| Number parsing + word→digit + window     | `helpers/generator/helpers.ts`                             |
| `RELATIVE_DATE_YEAR_SPAN` (15)           | `helpers/generator/constants.ts`                           |
| Fuzzy/natural-language dates (chrono)    | `helpers/date-fuzzy.ts`                                    |
| Date formatting (`label` / `insertLabel`)| `helpers/date-format.ts`                                  |
| Generator hook                           | `helpers/generator/use-backlink-generator.ts`              |
| App wiring (callback to editor)          | `client/models/note/note-document-view.ts` (`generateBacklink`) |
| Selection → find/create daily note       | `client/actions/note/add-backlink.ts`, `client/actions/note/find-or-create.ts` |
| `Backlink` type                          | `client/models/backlink/types.ts`                          |
| Behavior tests (best spec)               | `helpers/generator/backlink-date-generator.test.ts`, `backlink-generator.test.ts` |

## Notes for V2

- The **lazy daily-note-on-link** behavior is the core value: linking to a date you've
  never visited should create that daily note transparently. Preserve `dailyAt`-driven
  find-or-create.
- Keep the **display vs inserted** split (`label` vs `insertLabel`): show the friendly
  relative phrase in the menu, write the canonical date into markdown. In V2's
  markdown-backed model, decide the canonical on-disk form deliberately (ISO `YYYY-MM-DD`
  is the natural fit for `daily/` filenames, and `find-or-create` already special-cases
  ISO labels).
- Reproduce the **three-matcher merge with first-wins dedup** and the **±15-year clamp on
  relative-only** results; both shape what users see and the year window is what keeps
  nonsense queries quiet.
- `weekStart` is currently dead in this path — if V2 wants Sunday/Monday-aware "this
  week" behavior in suggestions, it has to actually implement it (chrono config), not
  just pass the flag.
- Spelled-out numbers stop at **ten**. If broader natural-language number support is
  wanted ("twenty days ago"), that's a deliberate extension, not existing behavior.
