# Deep links

The desktop app registers the `reflect://` URL scheme, so other apps, scripts, and launchers can
navigate the app (or launch it) and send it quick captures. The grammar mirrors the in-app route
model (`packages/app/src/navigation/route.ts`): a URL is an address for an app state, never a
remote control. The parser is `packages/core/src/navigation/deep-link-parse.ts`.

## Navigation links

```text
reflect://today                     the daily stream, on today
reflect://daily/2026-07-01          a specific day (ISO YYYY-MM-DD)
reflect://note/<target>             a note
reflect://search?q=meeting          the search screen, query prefilled
reflect://tasks                     the tasks view
```

`<target>` resolves like the CLI's `<note>` argument, with the frontmatter `id` first because it
survives renames. Then come an ISO date, a graph-relative path, a title, and an alias.
Ambiguity resolves to the first path alphabetically. Links resolve **in the open graph** only.

**Copy deep link** (⌘K palette, `⌥⌘L`) copies the id form. On first copy it writes an `id:` into
the frontmatter of notes that predate ids, so the link outlives any rename. Daily notes use the
date form. A hand-written `reflect://note/Project%20X` also works, by title.

## Write links

```text
reflect://append?text=call%20the%20bank    a bullet on today's daily note
reflect://checkbox?text=pack%20a%20bag     a square (`- [ ]`) checkbox, daily note only
reflect://task?text=buy%20milk             a round (`+`) task, shown in the Tasks view
```

Any web page can try to open `reflect://`, so writes are deliberately narrow: **one line of plain
text, onto today's daily note, nothing else**. The text is folded to one line (no markdown-block
smuggling) and length-capped. It lands through the capture inbox (`.reflect/inbox/`), the same
audited drain browser captures use, never spliced into a note by the URL handler. No URL writes
into an arbitrary note, creates a note with content, or runs a command.

The status line reports the result ("Task added to today"). The appended line is deduplicated
exactly, so a crashed drain re-runs cleanly.

## Platform notes

- macOS registers the scheme at **bundle** time. Plain `pnpm tauri dev` does not, so use a built
  bundle to test OS-delivered links.
- All flavors (Reflect, Reflect Beta, Reflect Dev) register `reflect://`. With several installed,
  macOS picks one handler.
- On Windows and Linux, the single-instance plugin forwards a second launch's URL to the running
  instance. macOS does this natively.
- A link that arrives with no graph open waits until a graph opens.
- A `reflect://` link clicked *inside* the app goes straight to the in-app handler. It works in
  dev builds and never lands on a different installed flavor.
- iOS registers the scheme for one mobile-native verb only: `reflect://record-audio`, the
  lock-screen widget's start-recording entry point. The Rust shell handles it (see
  [audio-memos.md](porting/reflect-mobile/audio-memos.md)). Desktop parses it as unknown. The
  navigation grammar is not a mobile surface yet.

## Relationship to the CLI

The [CLI](cli.md) reads and resolves for scripts; the scheme navigates and captures.
`reflect open <note>` bridges the two: it resolves like `reflect show` and opens the scheme URL.
It prefers the `id` form (never writing one, since the CLI does not write), then the date form
for dailies, then the path form. `--print` emits the URL without launching.
