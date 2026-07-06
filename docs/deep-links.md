# Deep links

The desktop app registers the `reflect://` URL scheme, so other apps,
scripts, and launchers can navigate the running app (or launch it) and hand
it quick captures. The grammar mirrors the in-app route model
(`apps/desktop/src/routing/route.ts`) one-to-one — a URL is an address for an
app state, never a remote control.

## Navigation links

```text
reflect://today                     the daily stream, on today
reflect://daily/2026-07-01          a specific day (ISO YYYY-MM-DD)
reflect://note/<target>             a note — see resolution below
reflect://search?q=meeting          the search screen, query prefilled
reflect://tasks                     the tasks view
```

`<target>` resolves like the CLI's `<note>` argument, with the frontmatter
`id` first because it survives renames:

1. frontmatter `id` (the ULID notes carry since Plan 17)
2. a calendar-valid ISO date → that daily note
3. an explicit graph-relative path (`notes/foo.md`)
4. a title match (case-folded)
5. an alias match (`aliases:` frontmatter, or a v1 subject-alias segment of
   a `//` title like `Charlotte MacCaw // Mum`)

Ambiguity resolves to the first path alphabetically — the CLI's rule. Links
resolve **in the open graph**; there is no cross-graph addressing.

**Copy deep link** (⌘K palette, `⌥⌘L`) puts the id form on the
clipboard, minting an `id:` into the note's frontmatter on first copy for
notes that predate ids — so a copied link outlives any rename. Daily notes
are addressed by date instead. A human-written
`reflect://note/Project%20X` works too, via title resolution.

## Write links

```text
reflect://append?text=call%20the%20bank    a bullet on today's daily note
reflect://task?text=buy%20milk             an open task on today's daily note
```

A URL scheme is a world-invokable surface — any web page can attempt
`reflect://` — so writes are deliberately narrow: **one line of plain text,
onto today's daily note, nothing else**. The payload is whitespace-folded to
a single line (no markdown-block smuggling), capped at 10k characters, and
lands through the capture inbox (`.reflect/inbox/`) — the same audited drain
browser captures use — never spliced directly into a note by the URL
handler. There is no URL that writes into an arbitrary note, creates a note
with content, or runs a command.

Success and failure surface on the status line ("Added to today", "Task
added to today"); the appended line is deduplicated exactly, so a crashed
drain re-runs cleanly.

## Platform notes

- macOS registers the scheme at **bundle** time (`CFBundleURLTypes` via the
  Tauri deep-link plugin) — plain `pnpm tauri dev` does not register it; use
  a built bundle to exercise real OS-delivered links.
- All flavors (Reflect, Reflect Beta, Reflect Dev) register `reflect://`;
  when several are installed, macOS picks one handler.
- On Windows/Linux the single-instance plugin forwards a second launch's URL
  to the running instance and focuses it; macOS does this natively.
- A link that arrives while no graph is open (cold launch, graph chooser)
  buffers and fires once the graph opens.
- A `reflect://` link clicked *inside* the app (a note body, chat, a backlink
  snippet) dispatches straight into the same in-app handler — no OS
  round-trip, so it works in dev builds and can never land on a different
  installed flavor.

## Relationship to the CLI

The scheme and the [CLI](cli.md) stay complementary: the CLI reads and
resolves for scripts (`reflect show`, `reflect path`); the scheme navigates
and captures. `reflect open <note>` bridges the two — it resolves like
`reflect show` and shells out to the scheme URL, preferring the frontmatter
`id` form (never minting one; the CLI doesn't write), the date form for
dailies, and the path form otherwise. `--print` emits the URL without
launching. The scheme's own resolution is the CLI's order with the
frontmatter `id` step in front.
