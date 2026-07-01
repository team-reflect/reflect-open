# Porting deep links

**Status: planned.** v1 was addressable from outside: a `reflect://` URL
scheme for actions, web URLs for every note, and a "copy link" action. v2
has none of that yet — but the seams were built for it: the typed route
model (`apps/desktop/src/routing/route.ts`) and the command registry's
stable ids (`apps/desktop/src/lib/commands/types.ts`) both name "later deep
links" as their integration point. This doc is that later.

## What v1 did

- **Action scheme** — `reflect://?command=<name>&…` handled by the app:
  `append-to-daily-note` (text into today's list), `create-task`,
  `create-note`, and `edit-notes` (open by id or subject, optionally with
  content and a second split-pane note).
- **Web URLs** — every note, daily note, tag, search, and the task view had
  a `reflect.app/g/<graphId>/…` URL; "Copy link to note" (`alt+mod+l`,
  toast: "Note link copied to clipboard") put one on the clipboard.
- **Published URLs** — paid users could publish a note to a public
  `reflect.site` URL.
- **REST API** — authenticated endpoints to create notes and append to the
  daily note.

## What changes in v2, and why

There is no server, so anything whose address *is* a server dies with it:
web URLs, published pages, and the REST API are not portable. What remains
— and what mattered — is **local addressability**: other apps, scripts,
launchers, and your own notes elsewhere being able to say "open this note"
or "add this to today". v2 already half-solves this from two directions:

- the **CLI** ([docs/cli.md](../cli.md)) answers reads (`reflect show`,
  `reflect search`, `reflect path`) for scripts and agents;
- the **capture inbox** (`.reflect/inbox/`, from the link-capture pipeline)
  is the sanctioned way for outside software to hand Reflect content
  without talking to a live app.

Deep links complete the triangle: a clickable way to **navigate** the
running app.

## How it will work in v2

### A `reflect://` scheme that mirrors the route model

The Tauri app registers the `reflect://` scheme (deep-link plugin +
`CFBundleURLTypes`; single-instance so a link focuses the running app or
launches it). URLs map one-to-one onto the existing `Route` union rather
than inventing a second grammar:

```text
reflect://today                     { kind: 'today' }
reflect://daily/2026-07-01          { kind: 'daily', date }
reflect://note/<target>             { kind: 'note', path }  — see resolution
reflect://search?q=meeting          { kind: 'search', query }
reflect://tag/<name>                { kind: 'allNotes', tag }
reflect://tasks                     { kind: 'tasks' }
```

`<target>` resolves exactly like the CLI's `<note>` argument and the
`note_keys` view: frontmatter `id` first (stable across renames — the
reason ids exist), then date, title, or alias. "Copy deep link" therefore
prefers the id form, so a link outlives any rename — within the graph it
was copied from; see graph addressing below. A human-written
`reflect://note/Project%20X` still works via title resolution.

A "Copy deep link" entry joins the command palette and the note context
menu, porting v1's `alt+mod+l`.

### Write actions go through the inbox, not straight into notes

v1's `append-to-daily-note` and `create-task` are the automation hooks
worth keeping (launchers, Shortcuts, "quick add" scripts). But a URL scheme
is an unauthenticated, world-invokable surface — any web page can attempt
`reflect://` — so v2 splits by risk:

- **Navigation links** (everything above) act immediately: worst case, the
  wrong screen is shown.
- **Write links** — `reflect://append?text=…`, `reflect://task?text=…` —
  reuse the capture-inbox pattern: the payload lands as a pending capture
  with visible provenance and is imported through the same reviewed path as
  browser captures, never silently spliced into a note. Size-limited,
  text-only, no format smuggling.
- **No remote-control surface.** v1's `edit-notes` could inject `content`
  into arbitrary subjects; v2 does not take content or execute registry
  commands from URLs. The command ids stay the vocabulary for the palette
  and a future `reflect open` CLI verb, where invocation is local and
  deliberate.

### Relationship to the CLI

The scheme and the CLI stay complementary, not duplicative: the CLI reads
and resolves (`reflect path` already gives scripts a *file* address); the
scheme navigates and captures. A natural follow-up is `reflect open
<note>`, which just shells out to the scheme URL — one resolution routine,
three front doors (palette, CLI, links).

## v1 → v2 mapping

| v1                                              | v2                                                    |
| ----------------------------------------------- | ----------------------------------------------------- |
| `reflect://?command=edit-notes&id=…`            | `reflect://note/<id>` (route-shaped, id-first)        |
| `reflect://?command=append-to-daily-note`       | `reflect://append?text=…` via the capture inbox       |
| `reflect://?command=create-task`                | `reflect://task?text=…` via the capture inbox         |
| Web URLs (`reflect.app/g/…`)                    | Not ported — no server; `reflect://` + file paths     |
| Tag URLs (`…/g/<id>/tag/<name>`)                | `reflect://tag/<name>` (All Notes filtered by tag)    |
| "Copy link to note" (`alt+mod+l`)               | "Copy deep link" (palette + context menu)             |
| Published `reflect.site` pages                  | Not ported here (a publishing story is separate)      |
| REST API create/append                          | CLI + capture inbox + plain files                     |
| `DDMMYYYY` daily ids                            | ISO `YYYY-MM-DD`, as everywhere in v2                 |

## Explicitly not ported

- Anything requiring Reflect-hosted infrastructure: shareable web URLs,
  public publishing, authenticated REST endpoints.
- Split-pane parameters (`splitPaneSubject`, …) — v2 has no split editor;
  if it grows one, the URL grammar can gain a parameter then.
- URL-initiated note **creation with content** (`edit-notes` with
  `subject` + `content`) — creation stays a deliberate in-app/inbox act.

## Open questions

- **Graph addressing.** URLs above assume the current graph. Multi-graph
  users need either a `?graph=` parameter (matched against the recents
  store) or the rule "links resolve in the open graph" — start with the
  latter, it's honest about what the app can safely do.
- **x-callback-url.** Automation tools (Shortcuts, Raycast) like
  success/error callbacks. Worth deciding once real integrations ask.
- **Block/heading anchors.** v1 never had them; markdown has no stable
  block ids. Heading anchors (`reflect://note/<id>#heading`) are feasible
  later without breaking the grammar.
