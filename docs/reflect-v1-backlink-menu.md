# Reflect V1: Backlink Menu & Date Generator

The observable **behavior** of the V1 backlink autocomplete menu (the popup on `[[`), with
a focus on its **date suggestions** ("3 days ago", "next Friday"). A reference for the V2
rewrite. For product context see [Reflect V1 Overview](./reflect-v1-overview.md).

## What It Is

Typing `[[` opens a menu with two kinds of results:

1. **Existing links**: notes, contacts, and aliases that match the query.
2. **Generated date suggestions**: calendar dates, relative offsets ("3 days ago"), and
   natural-language dates ("next Friday").

So `[[3 days ago`, `[[next monday`, or `[[12/25` links straight to that **daily note**,
which is created on the fly if it doesn't exist yet.

## How Results Are Ordered

- **Empty query**: a short sample of existing links.
- **As you type**: at most **3 date suggestions**, listed **first**; existing links fill the
  rest.
- An existing note whose title **exactly** equals the query takes the top slot.
- The **current note is never offered** as a link to itself.

## Date Suggestions

Reflect reads the query three ways at once (relative offset, natural-language date, typed
calendar date) and merges the results. When two readings land on the **same day**, only one
entry shows, worded by the natural-language phrase where one exists (`[[one day ago]]`
reads "one day ago", not "1 day ago").

### Relative offsets

A query with a number offers offsets from **today** both ways: `N days/weeks/months/years
from now` and `N days/weeks/months/years ago`. Further typing narrows the list (`week`,
`ago`, ...), and the top 3 survive.

- The words **one through ten** count as digits (`[[three days ago]]` = `[[3 days ago]]`).
  "twenty" is not recognized.
- Offsets beyond roughly **15 years** are dropped silently, so `[[17 years]]` and
  `[[1000 years]]` show nothing. This is the only guard on relative offsets.

### Natural-language dates

- `Today`, `Yesterday`, `Tomorrow`
- `This` / `Next` / `Last` + a weekday, or + `week`, `weekend`, `month`

These need at least three typed characters: `[[mon]]` shows This/Next/Last Monday, `[[yest]]`
shows Yesterday. Free-form phrasings like `[[one day ago]]` or `[[December 2nd]]` also work,
and malformed ordinals still resolve (`31th December`). The "this/next/last week" options
**ignore the week-start preference**.

### Typed calendar dates

A number followed by a slash parses as a date using the **date-format preference**
(month/day or day/month). Full dates (`23/2/2023`) and year-less shorthand (`12/25`, current
year) both work, with no 15-year limit (`15/3/1850` works). Natural-language dates ignore
the preference, so ambiguous shorthand like `[[12/10]]` can show **two** suggestions:
12th October and 10th December.

## What Gets Inserted

The menu shows a **friendly label** and inserts a **compact date**:

| Menu label                           | Inserted     |
| ------------------------------------ | ------------ |
| `3 days ago (29th December, 2019)`   | `29/12/2019` |
| `Next Friday (10th January, 2020)`   | `10/1/2020`  |

Picking a date links to that **daily note** and creates it if needed. Picking an existing
link links to that note. Picking a non-date with no match creates a new regular note.

## Worked Examples

Today is **Wednesday, 1 January 2020**; date format is **day/month**:

| You type `[[…`   | Menu shows (top results)                                          |
| ---------------- | ---------------------------------------------------------------- |
| `1`              | `1 day from now`, `1 week from now`, `1 month from now`          |
| `one day`        | `1 day from now (2nd Jan)`, `1 day ago (31st Dec)`               |
| `this monday`    | `This Monday (6th January, 2020)`                                |
| `12/10`          | `12/10 (12th October, 2020)` **and** `12/10 (10th December, 2019)` |
| `17 years`       | *(nothing)*                                                      |

## Notes for V2

- Preserve **lazy daily-note creation on link**.
- Keep the **friendly-label-in-menu, compact-date-in-note** split. Choose V2's canonical
  on-disk date form deliberately: ISO `YYYY-MM-DD` matches the daily-note files.
- Reproduce the **three-way reading with same-day de-duplication** and the **~15-year
  limit**: the limit keeps nonsense queries quiet.
- Numbers beyond **ten** ("twenty days ago") would be a new capability, not a port.
- Week-start-aware "this/next/last week" would also be new.
