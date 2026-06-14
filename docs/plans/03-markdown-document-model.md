# Plan 03 — Markdown Document Model

**Goal:** Define the canonical markdown parse/serialize layer: a stable AST, frontmatter
handling, `[[wiki link]]` extraction, and **lossless round-tripping** that tolerates
edits made outside Reflect.

**Depends on:** Plan 02 (file IO).
**Unlocks:** Plan 04 (index reads parsed structure), 05 (editor renders it), 07
(backlinks), 13 (import/export).

**Libraries:** `@lezer/markdown` + `@lezer/common` (the one parser, shared with the
editor), `yaml` (eemeli — tolerant frontmatter). See [Libraries](libraries.md).

## Scope

**In:** parser choice, AST shape, frontmatter parse/merge, wiki-link + tag + heading +
link extraction, serialization back to markdown, zod schemas, fuzz/round-trip tests.
**Out:** rendering/editing (Plan 05), persisting derived data (Plan 04).

## Why this is its own phase

Markdown is the source of truth, so the parser is load-bearing. Two hard requirements:

1. **External-edit tolerance:** a user (or `git pull`, or Obsidian) may have changed the
   file. Invalid/unknown frontmatter must never make a note unreadable.
2. **Round-trip fidelity:** Reflect-driven edits (e.g. rename rewrite, AI patch) must not
   reflow/normalize the whole file, or sync (Plan 12) drowns in spurious diffs.

## Steps

1. **Choose the parser — `@lezer/markdown` (same as the editor).** Use
   `@lezer/markdown` configured with `GFM` (tables, task lists, strikethrough, autolink) —
   the *same* parser meowdown uses (Plan 05). It produces a position-based tree, which is
   what incremental indexing + splice edits need. Write the `[[wiki link]]` rule **once**
   as a `@lezer/markdown` inline extension and reuse it in both modes:
   - **editor**: meowdown's block-only config (inline syntax kept as literal text);
   - **indexer/edits**: a full-inline config that surfaces `Link`, `Image`, `InlineCode`,
     and the wiki-link node for extraction.
   This is a revision of the earlier remark recommendation — see "One parser" below.
   (YAML frontmatter is parsed separately from the `---` block with a tolerant YAML loader;
   neither Lezer nor remark parse it natively.)

2. **Frontmatter.** Parse YAML frontmatter with a tolerant loader; validate the *known*
   subset with zod (`id`, `aliases`, `private`, capture-provenance fields from Plan 11)
   and **carry through unknown keys untouched** on write. A failed YAML parse degrades to
   "no frontmatter" + a non-fatal warning, never an unreadable note.

   ```ts
   // packages/core/src/markdown/frontmatter.ts
   import { z } from 'zod'

   export const frontmatterSchema = z.object({
     id: z.string().optional(), // reserved; not auto-written in the first wave (see step 5)
     aliases: z.array(z.string()).default([]),
     private: z.boolean().default(false),
   }).passthrough() // preserve unknown keys (incl. a user's `tags:`)
   export type Frontmatter = z.infer<typeof frontmatterSchema>
   ```

3. **Extraction pass.** From the AST, derive (pure functions, each unit-tested):
   - `title` (frontmatter, else first H1, else filename).
   - Outgoing `[[wiki links]]` with target + optional `|alias` + source position.
   - Standard markdown links (href, text) and their domains.
   - Tags: **body `#tag` only** (decided 2026-06-09). A frontmatter `tags:` key, if present,
     is preserved via passthrough but is **not** a tag source in the first wave.
   - Headings (for section anchors + chunking in Plan 09).
   - Asset references (relative links into `assets/`).
   - Plain text (for FTS + AI context).
   These outputs are the contract the indexer (Plan 04) consumes.

4. **Serialization.** Provide `serialize(ast)` and targeted edit helpers:
   `renameWikiLink(ast, from, to)`, `upsertFrontmatter(ast, patch)`,
   `appendUnderHeading(ast, heading, block)` (used by capture in Plan 11). Edits must be
   **minimal-diff** — touch only affected nodes, preserve surrounding whitespace/style.

5. **Wiki-link resolution model.** Define resolution rules used everywhere:
   case-insensitive title match, alias match, and `[[YYYY-MM-DD]]` → daily note. Return
   a typed result: `resolved(ref)` | `unresolved(text)` so the editor (Plan 05/07) can
   offer "create note." **Note identity = the file path/title in the first wave** (decided
   2026-06-09): `ref` is the note's path, resolution **prefers a frontmatter `id` when one
   is present** but we don't auto-write ids yet. This keeps files clean and externally
   editable; rename-stable ids (the V1 model) are reserved in the schema and revisited when
   sync (Plan 12) makes them matter. The lookup itself is **injected** (DI per conventions
   §3) — `resolve.ts` owns only the pure normalization + the `Resolution` type; the
   index-backed resolver lands in Plan 04/07.

6. **Tests.** Golden round-trip corpus (Reflect notes, Obsidian notes, GFM edge cases,
   broken frontmatter, mixed line endings). Property test: `serialize(parse(x))` is
   stable and minimal-diff for representative inputs.

## One parser: `@lezer/markdown` (revised — was "remark + share grammar")

An earlier draft kept **remark** for the index and meowdown's **Lezer** for the editor,
"sharing the `[[wiki link]]` grammar." On review that doesn't hold: remark uses *micromark*
extensions and meowdown uses *`@lezer/markdown`* extensions — **two different extension
systems**, so the wiki-link rule would have to be written and maintained *twice*, with a
cross-engine test forever guarding the seam. That's drift risk, not drift avoidance.

So **standardize on `@lezer/markdown` for everything** — editor, indexer, and programmatic
edits — and write the wiki-link inline extension exactly once. A single
`packages/core/src/markdown/` module owns: the GFM + wiki-link Lezer config, extraction
(walk the tree → links/headings/tags/assets/text), and splice-based edit helpers
(`renameWikiLink`, `upsertFrontmatter`, `appendUnderHeading`) that edit the source string
by node position rather than re-serializing. The editor's `docToMarkdown` and these edits
operate on the same syntax, so a round-trip test covers both.

**remark is intentionally out of the editor/indexer hot path.** Plan 13 is closed by
product decision, so there is no planned HTML export pipeline that would justify adding
remark for portability.

## Key decisions / contracts

- **`@lezer/markdown` (GFM + a single wiki-link extension) is the one canonical parser**,
  shared by editor, indexer, and edits. Edits are position-based splices on the source
  string. (Answers the indexing-doc open question; supersedes the remark recommendation.)
- **Unknown frontmatter is preserved, never dropped.** zod `.passthrough()` at the
  boundary; only the known subset is typed.
- **Note identity = path/title in the first wave** (decided 2026-06-09). `id` is reserved
  in the schema and resolution prefers it when present, but ids aren't auto-written yet.
- **Tags = body `#tag` only** (decided 2026-06-09). A frontmatter `tags:` key passes through
  untouched but isn't a tag source this wave.
- **Edits are minimal-diff** to keep sync quiet.
- **The extraction output is a stable, versioned interface** — Plan 04 depends on it.

## Acceptance criteria

- Round-trip corpus passes: parse → serialize is byte-stable for unedited notes.
- Broken/unknown frontmatter still yields a readable note + extracted links.
- `[[Wiki Links]]`, `[[Note|alias]]`, and `[[2026-06-08]]` parse into typed nodes with
  positions.
- Extraction unit tests cover title fallback, tags, links, assets, headings, plain text.
- `pnpm typecheck` + tests pass.

## Risks

- **Wiki-links aren't CommonMark.** A naive regex breaks inside code spans/fences.
  Mitigate with the canonical `@lezer/markdown` inline extension (shared by editor +
  indexer) whose tokenization respects code contexts — not a second parser.
- **Round-trip drift** from the serializer normalizing markdown. Mitigate by preferring
  source-position-aware splice edits over full re-serialization where possible, and by
  the property test gate.
