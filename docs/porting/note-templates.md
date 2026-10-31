# Porting note templates

**Status: shipped.** The slash-menu entry point uses meowdown's host-items
API (`insertMarkdown` + `onSlashMenuSearch`,
[#197](https://github.com/prosekit/meowdown/pull/197)/[#198](https://github.com/prosekit/meowdown/pull/198)),
with two v1-parity refinements (insert never deletes a selection, and
slash-menu `keywords` behind `/template`) in meowdown 0.33.0
([#208](https://github.com/prosekit/meowdown/pull/208)/[#209](https://github.com/prosekit/meowdown/pull/209)).
The [product vision](../reflect-v2-product-vision.md) deferred templates
with "markdown snippets may be enough", and that is the design: templates
are markdown files in the graph.

## What v1 did

Templates were per-graph named blocks of rich content, managed in
**Preferences → Note Templates**, stored in the cloud account, and inserted
via the slash menu. New graphs got three starters (**journal**, **person**,
**company**). No variable substitution: bodies were inserted verbatim.

## How it will work in v2

### Templates are files

A `templates/` folder at the graph root, beside `daily/` and `notes/`:

```text
my-graph/
├── daily/
├── notes/
├── templates/
│   ├── journal.md
│   └── person.md
└── .reflect/
```

Each file is one template; its title (H1 or filename) is its name. That
gives most of what v1 had to build: editable in any editor (the watcher
picks up changes), per-graph and synced by git backup, and versioned by git
history.

### Inserting a template

- **Command palette** (`mod+k`): "Insert template…" lists the graph's
  templates and inserts the body at the cursor.
- **Editor slash/insert menu**: meowdown's insert affordances (slash menu,
  block-handle `+`) show host-provided template items beside built-in
  blocks.

Insertion is verbatim, like v1. Template frontmatter is not inserted.

### Managing templates

Files first: create, rename, and delete from any editor or file manager. In
the app, **Settings → Note templates** lists them with open / rename /
delete rows, and "New template" (also a palette command) creates
`templates/<slug>.md` named via frontmatter `title:` (metadata, stripped on
insert, like v1's name/body split). Rename moves the file to the new slug
**and** rewrites the title, carrying any open session; delete sends the
file to the trash. Title edits in the editor do **not** rename a template
file (the rename pipeline's slug targets live under `notes/`); the settings
rename is the in-app rename.

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

- Starter templates in every new graph: scaffolding stays minimal; the
  examples below carry v1's seed content.
- Duplicate-name quirks: filenames make names unique.
- `unwrapInvisibleList` (v1 peeled a wrapper list off the template): an
  artifact of v1's mandatory outer-bullet document shape.
- Newest-first ordering in the preferences list.

## Starter examples

v1 seeded every graph with these. Create a file under `templates/` and
paste one in. The frontmatter `title:` is the display name and is stripped
on insert, so (like v1) the name never lands in a note. An H1 also works as
the name, but then it is inserted with the body.

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

- **Indexing.** `templates/*.md` is indexed like any note, with a
  `notes.kind` column (`daily` / `note` / `template`, migration 0014,
  projection v12) derived from the path. Every note surface (All Notes,
  search, backlinks, tasks, pinned, tag facets, wikilink autocomplete and
  resolution, graph stats, the CLI) excludes `kind = 'template'`; the
  `note_keys`/`backlinks` views enforce the wikilink rule in the schema.
  Templates are never embedded, so AI retrieval can't see them.
- **Insertion.** The picker reads the file, strips frontmatter, and inserts
  the body as a parsed fragment (`NoteEditorHandle.insertMarkdown`): one
  undoable edit with paste semantics.

## Open questions

- **Daily-note templates.** v1 never auto-applied a template to daily notes
  and users asked for it constantly. A `templates/daily.md` applied to new
  daily notes fits v2, but it interacts with the lazy "no file until first
  keystroke" contract; deferred to its own decision.
- **Variables.** `{{date}}`-style substitution is out for parity; the
  files-first design allows it later without migration.
