# Porting note templates

**Status: shipped.** The editor slash-menu entry point rides meowdown's
host-items API (`insertMarkdown` + `onSlashMenuSearch`, upstream
[#197](https://github.com/prosekit/meowdown/pull/197)/[#198](https://github.com/prosekit/meowdown/pull/198)),
with two v1-parity refinements — insert-never-deletes-a-selection and the
slash-menu `keywords` behind the `/template` affordance — landed in
meowdown 0.33.0 ([#208](https://github.com/prosekit/meowdown/pull/208)/[#209](https://github.com/prosekit/meowdown/pull/209)).
The [product vision](../reflect-v2-product-vision.md) deferred templates
with "markdown snippets may be enough" — and that is exactly the design:
templates are markdown files in the graph.

## What v1 did

Templates were per-graph named blocks of rich content, managed in
**Preferences → Note Templates**, stored in the cloud account, and inserted
via the editor's slash menu. New graphs were seeded with three starter
templates (**journal**, **person**, **company**). There was no variable
substitution — bodies were inserted verbatim.

## How it will work in v2

### Templates are files

A `templates/` folder at the graph root, as a sibling of `daily/` and
`notes/`:

```text
my-graph/
├── daily/
├── notes/
├── templates/
│   ├── journal.md
│   └── person.md
└── .reflect/
```

Each markdown file is one template; its title (H1 or filename) is the name
shown when inserting. That single decision buys almost everything v1 had to
build:

- **Editable anywhere** — in Reflect or any text editor; the file watcher
  picks up changes like any other file.
- **Per-graph scope and sync for free** — templates live in the graph and
  ride the git backup, so every device sees them; no account storage, no
  separate sync path.
- **Versioned** — template history is git history.

### Inserting a template

- **Command palette** (`mod+k`): an "Insert template…" command lists the
  templates in the current graph and inserts the chosen body at the cursor.
- **Editor slash/insert menu**: meowdown's insert affordances (slash menu,
  block-handle `+`) gain host-provided items so templates appear alongside
  built-in blocks — same host-supplies-the-items pattern as wikilink
  autocomplete.

Insertion is verbatim, matching v1: links, tags, tasks, and headings paste
in as written. Frontmatter in a template file (if any) is not inserted.

### Managing templates

Templates are files first: creating, renaming, and deleting all work from
any text editor or file manager, and the watcher picks the changes up. In
the app, **Settings → Note templates** lists them with open / rename /
delete rows, and a "New template" dialog (also a palette command) creates
`templates/<slug>.md` named via frontmatter `title:` (metadata, stripped on
insert — v1's name/body split). Renaming moves the file onto the new name's
slug **and** rewrites the authored title, carrying any open editor session;
deleting sends the file to the trash. Templates open in the normal editor,
but title edits do **not** rename the file (the rename pipeline's slug
targets live under `notes/`) — the settings rename is the in-app rename.

## v1 → v2 mapping

| v1                                          | v2                                                 |
| ------------------------------------------- | -------------------------------------------------- |
| Stored in the cloud account, per graph      | Markdown files in `templates/`, per graph          |
| Managed in a preferences page               | Managed as files; edited in the normal editor      |
| Inserted via the editor slash menu          | Command palette + meowdown insert menus            |
| Seeded starter templates on graph creation  | None seeded (no-litter contract); docs show examples |
| No variable substitution                    | Same — verbatim insertion, at least initially      |
| Newest-first list in prefs, A→Z in menu     | A→Z everywhere                                     |

## Explicitly not ported

- Starter templates written into every new graph — scaffolding stays
  minimal; the copy-pasteable **journal**/**person**/**company** examples
  below carry v1's seed content instead.
- Duplicate-name tolerance quirks: filenames make names unique per graph by
  construction.
- `unwrapInvisibleList` (v1's insert extension peeled a wrapper list off the
  template) — an artifact of v1's mandatory outer-bullet document shape,
  meaningless in markdown.
- Newest-first ordering in the preferences list — A→Z everywhere, as decided
  above.

## Starter examples

v1 seeded every new graph with these three. Create a file under
`templates/` and paste one in. The frontmatter `title:` is the template's
display name; frontmatter is stripped on insert, so — exactly like v1 —
the name never lands in a note. (An H1 also works as the name, but then it
inserts with the body.)

`templates/journal.md`

```markdown
---
title: Journal
---
- [[Journal]]
  - Grateful for
  - On my mind
  - Working on
  - Daily habits
    + [ ] Exercise
```

`templates/person.md`

```markdown
---
title: Person
---
- Title:
- Company:
- Type: #person
- Email:
- Phone:
- Location:
```

`templates/company.md`

```markdown
---
title: Company
---
- type: #company
- domain:
```

## How it was built

- **Indexing.** `templates/*.md` is indexed like any note, with a new
  `notes.kind` column (`daily` / `note` / `template`, migration 0014,
  projection v12) derived from the path. Every note surface — All Notes,
  search, backlinks, tasks, pinned, tag facets, wikilink autocomplete and
  resolution, graph stats, the CLI — excludes `kind = 'template'`; the
  `note_keys`/`backlinks` views enforce the wikilink rule at the schema
  level. Templates are never embedded, so AI retrieval can't see them.
- **Insertion.** The picker reads the file, strips frontmatter, and inserts
  the body as a parsed fragment at the cursor
  (`NoteEditorHandle.insertMarkdown`) — one undoable edit with paste
  semantics.

## Open questions

- **Daily-note templates.** v1 never auto-applied a template to daily notes
  and users asked for it constantly. A designated `templates/daily.md`
  applied to new daily notes is a natural v2 extension, but it interacts
  with the lazy "no file until first keystroke" contract — deferred to its
  own decision.
- **Variables.** `{{date}}`-style substitution is deliberately out for
  parity, but the files-first design leaves room for it later without
  migration.
