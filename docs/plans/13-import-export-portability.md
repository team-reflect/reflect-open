# Plan 13 — Import / Export / Portability

> **Status (2026-06-14): Partial.** The graph is already a plain markdown folder (the
> core "open your folder and it's just files" promise holds). A focused Reflect V1
> Markdown ZIP importer exists in `packages/core/src/import/v1-markdown.ts`: it unzips
> with `fflate`, preserves V1 IDs as frontmatter, normalizes task markers, routes daily
> notes into `daily/YYYY-MM-DD.md`, and writes collision-safe regular notes through the
> graph command layer. The general previewed Obsidian/markdown import and all
> Markdown/JSON/HTML export surfaces below are still outstanding.

**Goal:** Make data ownership tangible from day one: import existing markdown/Obsidian
graphs, and export the graph to Markdown, JSON, and HTML with backlinks, tags, and
daily dates preserved.

**Depends on:** Plan 02 (file IO), Plan 03 (doc model), Plan 04 (projections for export
metadata).
**Unlocks:** trust + adoption; a migration on-ramp.

**Libraries:** export is client-side TS — `fflate` (ZIP) + the editor's ProseMirror
`DOMSerializer` for HTML (no remark). See [Libraries](libraries.md).

## Scope

**In:** Reflect V1 Markdown ZIP import (shipped), Markdown / Obsidian-style graph import
(planned), full-graph export to Markdown ZIP, JSON, and HTML ZIP; attachments preserved;
backlinks/tags/daily-dates preserved.
**Out:** Evernote/Roam/Notion/Readwise importers (later), publishing (deferred).

## Why now (not later)

Portability is an explicit Reflect value, not a checkbox. Because the source of truth is
already plain markdown files, "export" is mostly faithful copying + format conversion —
cheap to do well early, and a strong trust signal for an open-source launch.

## Steps

1. **Import: markdown / Obsidian graph.** Point at a folder; copy/normalize into the
   Reflect layout (`daily/`, `notes/`, `assets/`):
   - detect daily notes by filename pattern → `daily/YYYY-MM-DD.md`;
   - keep `[[wiki links]]` as-is (already the canonical syntax); map Obsidian aliases →
     frontmatter `aliases` (Plan 03); carry attachments into `assets/` and fix relative
     links;
   - assign `id`s to regular notes without one; tolerate unknown frontmatter (Plan 03).
   Run as a previewed job (counts, conflicts, skips) before writing. Reindex on finish.

   **Shipped narrow importer:** `importReflectMarkdownZip` handles Reflect V1 Markdown
   ZIP exports today. It is not a general Obsidian importer: it accepts the old Reflect
   ZIP shape, skips unsafe paths, keeps existing graph files by choosing available note
   paths, and reports `{ imported, regular, daily, skipped, renamed }`.

2. **Import safety.** Never overwrite existing graph files silently; surface name
   collisions; import into a subfolder or merge with explicit choices. Large imports show
   progress and are cancellable.

   **Export runs client-side (TS):** zip with **`fflate`** (in `@reflect/core`); Rust just
   persists the produced bytes to a chosen path via a save command. Perf is fine at our
   scale, and it reuses libraries we already ship.

3. **Export: Markdown ZIP.** The portable baseline — the graph *is* markdown, so export is
   a faithful `fflate` ZIP of `daily/`, `notes/`, `assets/` (excluding `.reflect/`), with
   links and frontmatter intact. This is the "open your folder and it's just files" promise,
   packaged.

4. **Export: JSON.** A structured dump (notes with id/path/title/frontmatter/body, links,
   backlinks, tags, aliases, daily dates, asset references) for programmatic reuse and a
   future re-import path. Derive from Plan 04 projections + file bodies; zod-typed schema.

5. **Export: HTML ZIP.** Rendered, self-contained HTML — **reuse the editor**: parse each
   note with `markdownToDoc` and serialize the ProseMirror doc to HTML via ProseMirror's
   `DOMSerializer` (no remark; one parser everywhere). Wiki links → relative anchors,
   assets bundled, zipped with `fflate`.

6. **Round-trip guarantee.** Markdown export → fresh import reproduces an equivalent graph
   (same notes, links, tags, dailies, attachments). This is the portability contract,
   test-asserted.

7. **Tests.** Obsidian fixture imports with links/aliases/attachments preserved; daily
   detection; collision handling; each export format produced; markdown export→import
   round-trip equivalence.

## Key decisions / contracts

- **Markdown export is a faithful copy** (source of truth is already files); JSON + HTML
  are derived views.
- **Import is non-destructive.** The shipped V1 ZIP importer chooses collision-safe paths;
  the broader Obsidian/markdown importer still needs the preview UX described above.
- **Markdown round-trips** (export→import) to an equivalent graph.
- **Attachments, backlinks, tags, daily dates, and aliases are always preserved.**

## Acceptance criteria

- Importing a Reflect V1 Markdown ZIP yields working regular and daily notes in Reflect
  layout without overwriting existing files.
- Importing an Obsidian-style graph yields working notes, backlinks, aliases, and
  attachments in Reflect layout, with a pre-write preview.
- Export produces valid Markdown ZIP, JSON, and HTML ZIP excluding `.reflect/`.
- Markdown export re-imported reproduces an equivalent graph (test-asserted).
- `pnpm typecheck` + tests pass.

## Risks

- **Link/attachment path rewriting** during import (Obsidian shortest-path vs relative).
  Mitigate with AST-based link rewriting (Plan 03) + a fixture corpus.
- **Frontmatter dialect drift** across tools. Mitigate with tolerant parsing +
  passthrough of unknown keys (Plan 03).
- **Large-graph performance.** Stream + batch; show progress; keep memory bounded.
