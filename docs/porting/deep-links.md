# Porting deep links

**Status: shipped.** The scheme, note resolution, write links, and "Copy
deep link" landed as designed below; [docs/deep-links.md](../deep-links.md)
is the user-facing grammar reference. Decisions made at implementation:

- **Id minting on first copy.** "Copy deep link" (`⌥⌘L`) writes a ULID `id:`
  into the frontmatter of a note that has none (pre-Plan-17 notes, files
  made outside Reflect), through the same session-or-disk channel as pin and
  private, so the link survives renames.
- **Append lands as a daily bullet.** `reflect://append` / `reflect://task`
  spool a size-capped, single-line envelope into `.reflect/inbox/`; the
  capture drain appends `- <text>` / `- [ ] <text>` to the capture-day daily
  note (exact-line-deduplicated, so re-drains are safe). The envelope is the
  provenance; no capture note is made for one line.
- **All flavors register `reflect://`** (Reflect, Beta, Dev); macOS picks a
  handler when several are installed. Links stay portable across flavors.
- **Graph addressing:** links resolve in the open graph. URLs that arrive
  with no graph open wait until one opens.

The original plan follows.

---

v1 was addressable from outside: a `reflect://` action scheme, web URLs for
every note, and "copy link". v2 had none, but the typed route model
(`apps/desktop/src/routing/route.ts`) and the command registry's stable ids
(`apps/desktop/src/lib/commands/types.ts`) both name "later deep links" as
their integration point. This doc is that later.

## What v1 did

- **Action scheme**: `reflect://?command=<name>&…` with
  `append-to-daily-note`, `create-task`, `create-note`, and `edit-notes`
  (open by id or subject, optionally with content and a second split-pane
  note).
- **Web URLs**: every note, daily note, tag, search, and the task view had
  a `reflect.app/g/<graphId>/…` URL; "Copy link to note" (`alt+mod+l`,
  toast "Note link copied to clipboard").
- **Published URLs**: paid users could publish to a public `reflect.site`
  URL.
- **REST API**: authenticated create-note and append-to-daily endpoints.

## What changes in v2, and why

Anything whose address *is* a server dies with it: web URLs, published
pages, the REST API. What mattered is **local addressability**: other apps,
scripts, and launchers saying "open this note" or "add this to today". v2
already covers reads with the **CLI** ([docs/cli.md](../cli.md):
`reflect show`, `search`, `path`) and outside content with the **capture
inbox** (`.reflect/inbox/`). Deep links complete the triangle: a clickable
way to **navigate** the running app.

## How it will work in v2

### A `reflect://` scheme that mirrors the route model

The app registers `reflect://` (deep-link plugin + `CFBundleURLTypes`;
single-instance, so a link focuses or launches the app). URLs map
one-to-one onto the `Route` union instead of a second grammar:

```text
reflect://today                     { kind: 'today' }
reflect://daily/2026-07-01          { kind: 'daily', date }
reflect://note/<target>             { kind: 'note', path }  — see resolution
reflect://search?q=meeting          { kind: 'search', query }
reflect://tasks                     { kind: 'tasks' }
```

`<target>` resolves like the CLI's `<note>` argument: frontmatter `id`
first (stable across renames), then a calendar-valid date, a graph-relative
path, a title, and an alias. Duplicate claims in a tier choose the first
path alphabetically. This free-form resolver is separate from the wikilink
`note_keys` mapping. "Copy deep link" prefers the id form so links outlive
renames; `reflect://note/Project%20X` still works by title. The command
keeps v1's `alt+mod+l` shortcut.

### Write actions go through the inbox, not straight into notes

v1's `append-to-daily-note` and `create-task` are worth keeping for
launchers and Shortcuts. But any web page can invoke `reflect://`, so v2
splits by risk:

- **Navigation links** act immediately: the worst case is the wrong screen.
- **Write links** (`reflect://append?text=…`, `reflect://task?text=…`)
  land as a pending capture with visible provenance and go through the same
  path as browser captures, never silently spliced into a note.
  Size-limited, text-only.
- **No remote-control surface.** v1's `edit-notes` could inject `content`
  into any subject; v2 takes no content and runs no registry commands from
  URLs. Command ids stay the vocabulary for the palette and a future
  `reflect open` CLI verb, where invocation is local and deliberate.

### Relationship to the CLI

The CLI reads and resolves (`reflect path` gives a *file* address); the
scheme navigates and captures. A follow-up `reflect open <note>` would
shell out to the scheme URL: one resolver, three front doors (palette, CLI,
links).

## v1 → v2 mapping

| v1                                              | v2                                                    |
| ----------------------------------------------- | ----------------------------------------------------- |
| `reflect://?command=edit-notes&id=…`            | `reflect://note/<id>` (route-shaped, id-first)        |
| `reflect://?command=append-to-daily-note`       | `reflect://append?text=…` via the capture inbox       |
| `reflect://?command=create-task`                | `reflect://task?text=…` via the capture inbox         |
| Web URLs (`reflect.app/g/…`)                    | Not ported — no server; `reflect://` + file paths     |
| "Copy link to note" (`alt+mod+l`)               | "Copy deep link" (palette + shortcut)                 |
| Published `reflect.site` pages                  | Not ported here (a publishing story is separate)      |
| REST API create/append                          | CLI + capture inbox + plain files                     |
| `DDMMYYYY` daily ids                            | ISO `YYYY-MM-DD`, as everywhere in v2                 |

## Explicitly not ported

- Anything needing Reflect-hosted infrastructure: web URLs, publishing,
  REST endpoints.
- Split-pane parameters (`splitPaneSubject`, …): v2 has no split editor.
- URL-initiated creation with content (`edit-notes` with `subject` +
  `content`): creation stays a deliberate in-app or inbox act.

## Open questions

- **Graph addressing.** A `?graph=` parameter (matched against recents) or
  "links resolve in the open graph". Start with the latter; it is honest
  about what the app can safely do.
- **x-callback-url.** Shortcuts and Raycast like success/error callbacks.
  Decide once real integrations ask.
- **Block/heading anchors.** v1 had none; markdown has no stable block ids.
  `reflect://note/<id>#heading` fits the grammar later.
