# Reflect V1: Backlink Menu & Date Generator

This document describes the **behavior** of the backlink autocomplete menu in Reflect V1
— the popup that appears when you type `[[` in the editor — with a focus on its
**date suggestions** (the "3 days ago", "next Friday", "1 week from now" entries). It is
a reference for the V2 rewrite, captured as observable behavior rather than implementation.

For broader product context see [Reflect V1 Overview](./reflect-v1-overview.md).

## What It Is

Typing `[[` in a note opens an autocomplete menu. As you type a query, the menu fills
from two kinds of results:

1. **Existing links** — notes, contacts, and aliases already in your graph that match
   what you've typed.
2. **Generated date suggestions** — dates synthesized from the query that you probably
   haven't created yet: calendar dates, relative offsets ("3 days ago"), and
   natural-language dates ("next Friday", "yesterday").

The date suggestions are the distinctive part. You can type `[[3 days ago`, `[[next monday`,
or `[[12/25` and link straight to that **daily note** — Reflect creates the daily note on
the fly if it doesn't exist yet — without leaving the editor or knowing the exact date.

## How Results Are Ordered

- **Empty query** (just `[[` with nothing typed) — the menu shows a short sample of a few
  existing links as a starting point.
- **As you type** — date suggestions are listed **first**, above matching existing links.
- An **exact title match** is pulled to the very top. For example, if you have a note
  literally titled "Today", typing `[[today` still shows the generated **Today** date
  suggestion above it, but an existing note whose title exactly equals your query wins the
  top slot.
- The **current note is never offered** as a link to itself.
- At most **3 date suggestions** appear; existing-link matches fill the rest of the menu.

## Date Suggestions

Reflect interprets your query three ways at once — as a relative offset, as a
natural-language date, and as a typed calendar date — and merges the results. If two
interpretations land on the **same calendar day**, only one entry appears for that day.

### Relative offsets ("3 days ago", "2 weeks from now")

When your query contains a number, Reflect offers offsets from **today** in both
directions:

- **Into the future:** `N days from now`, `N weeks from now`, `N months from now`,
  `N years from now`
- **Into the past:** `N days ago`, `N weeks ago`, `N months ago`, `N years ago`

As you keep typing, the list narrows to what matches: typing `day` keeps the day options,
`week` keeps the week options, `ago` keeps the past options, and so on. Only the top 3
survive into the menu.

**Numbers can be spelled out.** The words **one through ten** are treated as digits, so
`[[three days ago]]` behaves exactly like `[[3 days ago]]`. Only one through ten are
recognized — larger spelled-out numbers ("twenty") are not.

**A sanity limit keeps far-off offsets out.** Relative suggestions are only offered within
roughly **15 years** of today. This is why `[[17 years]]` and `[[1000 years]]` produce no
relative suggestions at all. (The limit applies only to these relative offsets — typed
calendar dates far in the past or future still work; see below.)

### Natural-language dates ("yesterday", "next Friday")

Reflect recognizes everyday date phrases. Typing a few letters of any of these surfaces
the matching options:

- `Today`, `Yesterday`, `Tomorrow`
- `This`, `Next`, or `Last` + any weekday (e.g. *This Monday*, *Next Friday*, *Last Tuesday*)
- `This`, `Next`, or `Last` + `week`, `weekend`, or `month`

So `[[mon]]` surfaces *This Monday*, *Next Monday*, and *Last Monday*; `[[yest]]` surfaces
*Yesterday*; `[[next fri]]` surfaces *Next Friday*. These phrase suggestions need at least
three typed characters before they appear. Free-form phrasings like `[[one day ago]]` or
`[[December 2nd]]` are also understood.

### Typed calendar dates ("12/25", "23/2/2023")

When your query looks like a date (a number followed by a slash), Reflect parses it as a
calendar date using your **date-format preference** (month/day or day/month). It accepts
full dates (`23/2/2023`) and shorthand without a year (`12/25`), defaulting the year to
the current year for shorthand.

**Ambiguous shorthand can show two dates.** A bare `[[12/10]]` is genuinely ambiguous, so
the menu may show *two* suggestions — one read in your preferred order, and one read the
other way around. For example `12/10` can offer both "12th October" and "10th December".

## What You See vs. What Gets Inserted

Each date suggestion shows a **friendly label** in the menu but inserts a **compact date**
into your note:

| You see in the menu                  | What gets inserted into the note |
| ------------------------------------ | -------------------------------- |
| `3 days ago (29th December, 2019)`   | `29/12/2019`                     |
| `Today (1st January, 2020)`          | `1/1/2020`                       |
| `Next Friday (10th January, 2020)`   | `10/1/2020`                      |

The menu label combines the relative phrase (or typed query) with the fully resolved date
so you can confirm you're picking the right day; the link written into the note is the
plain numeric date.

## What Happens When You Pick One

Selecting a date suggestion links the note to the **daily note for that date**. If that
daily note doesn't exist yet, it's created automatically. This is what makes
`[[3 days ago]]` work even for a day you've never visited — there's no separate step to
create the daily note first.

(Selecting an existing-link result simply links to that note; picking something that
isn't a date and doesn't match anything creates a new regular note with that title.)

## Worked Examples

Suppose today is **Wednesday, 1 January 2020**, and your date format is **day/month**:

| You type `[[…`   | Menu shows (top results)                                          | Inserts      |
| ---------------- | ---------------------------------------------------------------- | ------------ |
| `3 days ago`     | `3 days ago (29th December, 2019)`                               | `29/12/2019` |
| `three days ago` | same as above (the word becomes a digit)                        | `29/12/2019` |
| `1`              | `1 day from now`, `1 week from now`, `1 month from now` (top 3)  | per pick     |
| `one day`        | `1 day from now (2nd Jan)`, `1 day ago (31st Dec)`              | per pick     |
| `today`          | `Today (1st January, 2020)`                                     | `1/1/2020`   |
| `this monday`    | `This Monday (6th January, 2020)`                              | `6/1/2020`   |
| `next fri`       | `Next Friday (…)`                                               | per pick     |
| `12/10`          | `12/10 (12th October, 2020)` **and** `12/10 (10th December, 2019)` | per pick  |
| `23/2/2023`      | `23/2/2023 (23rd February, 2023)`                              | `23/2/2023`  |
| `17 years`       | *(nothing — beyond the ~15-year limit)*                         | —            |
| `1000 years`     | *(nothing)*                                                     | —            |

## Behavior Notes & Edge Cases

- **The "this/next/last week" options ignore your week-start preference.** Their meaning
  comes from a fixed interpretation of the phrase, not from whether your week starts on
  Sunday or Monday.
- **The ~15-year limit is the only guard on relative offsets.** Anything within it is
  offered; anything beyond it silently disappears. Typed calendar dates are exempt, so you
  can still link to dates centuries away by typing them out (`15/3/1850`, `1/1/2300`).
- **When two interpretations resolve to the same day, only one entry shows.** Its wording
  follows the natural-language phrasing where one exists (so `[[one day ago]]` reads
  "one day ago" rather than "1 day ago").
- **Date-format preference is honored for typed dates but not for natural-language ones.**
  This is what produces the two-result pairing for ambiguous shorthand like `12/10`.
- **Malformed ordinals still resolve.** Typing `31th December` is understood as the 31st
  even though the suffix is wrong.

## Notes for V2

- Preserve **lazy daily-note creation on link**: linking to a date you've never opened
  should transparently create that daily note.
- Keep the **friendly-label-in-menu, compact-date-in-note** split so the menu stays
  readable while the written link stays canonical. (Decide V2's canonical on-disk date
  form deliberately — an ISO `YYYY-MM-DD` link is the natural match for daily-note files.)
- Reproduce the **three-way interpretation with same-day de-duplication** and the
  **~15-year limit on relative offsets** — both shape what users see, and the limit is
  what keeps nonsense queries quiet.
- Spelled-out numbers stop at **ten** today. Broader natural-language numbers
  ("twenty days ago") would be a new capability, not a port.
- The week-start preference currently has **no effect** on the "this/next/last week"
  suggestions. If V2 wants week-start-aware behavior here, it has to be added.
