# Plan 03 — Markdown Document Model

**Goal:** Define the canonical markdown parse/serialize layer: a stable AST, frontmatter
handling, `[[wiki link]]` extraction, and **lossless round-tripping** that tolerates
edits made outside Reflect.

**Depends on:** Plan 02 (file IO).
**Unlocks:** Plan 04 (index), 05 (editor), 07 (backlinks), 13 (import/export).

**Libraries:** `@lezer/markdown` + `@lezer/common` (one parser, shared with the editor),
`yaml` (eemeli, tolerant frontmatter). See [Libraries](libraries.md).

## Scope

**In:** parser choice, AST shape, frontmatter parse/merge, link/tag/heading extraction,
serialization, zod schemas, round-trip tests.
**Out:** rendering/editing (Plan 05), persisting derived data (Plan 04).

## Why this is its own phase

Markdown is the source of truth, so the parser is load-bearing:

1. **External-edit tolerance:** a user, `git pull`, or Obsidian may change the file.
   Invalid/unknown frontmatter must never make a note unreadable.
2. **Round-trip fidelity:** Reflect edits (rename rewrite, AI patch) must not reflow the
   whole file, or sync (Plan 12) drowns in spurious diffs.

## Steps

1. **Parser: `@lezer/markdown` with `GFM`**, the same parser meowdown uses. It gives a
   position-based tree, which incremental indexing + splice edits need. Write the
   `[[wiki link]]` rule **once** as an inline extension, reused in two configs:
   - **editor:** meowdown's block-only config (inline syntax stays literal text);
   - **indexer/edits:** full-inline config surfacing `Link`, `Image`, `InlineCode`, and
     wiki links.
   YAML frontmatter is parsed separately from the `---` block (neither Lezer nor remark
   parses it).
2. **Frontmatter.** Tolerant YAML loader; zod validates the *known* subset (`id`,
   `aliases`, `private`, Plan 11 capture provenance) and **unknown keys pass through** on
   write. A failed parse degrades to "no frontmatter" + a non-fatal warning.

   ```ts
   export const frontmatterSchema = z.object({
     id: z.string().optional(), // reserved; not auto-written in the first wave
     aliases: z.array(z.string()).default([]),
     private: z.boolean().default(false),
   }).passthrough() // preserve unknown keys (incl. a user's `tags:`)
   ```

3. **Extraction** (pure, unit-tested; the contract Plan 04 consumes): `title`
   (frontmatter, else first H1, else filename), wiki links (target, `|alias`, position),
   markdown links + domains, tags, headings (anchors + Plan 09 chunking), `assets/`
   references, plain text. Tags are **body `#tag` only** (decided 2026-06-09); a
   frontmatter `tags:` key passes through but is not a tag source.
4. **Serialization + edit helpers** (`retitleWikiLinks`, `upsertFrontmatter`,
   `appendUnderHeading` for Plan 11 capture). Edits are **minimal-diff**: touch only
   affected nodes, keep surrounding whitespace/style.
5. **Wiki-link resolution:** case-insensitive title, alias, and `[[YYYY-MM-DD]]` → daily.
   Returns `resolved(ref)` | `unresolved(text)` so the editor can offer "create note."
   **Identity = path/title in the first wave** (decided 2026-06-09): `ref` is the path;
   resolution prefers a frontmatter `id` when present, but ids are not auto-written. This
   keeps files clean and externally editable; rename-stable ids (V1 model) are revisited
   when sync makes them matter. The lookup is **injected** (DI per conventions §3):
   `resolve.ts` owns only normalization + the `Resolution` type; the index-backed
   resolver lands in Plan 04/07.
6. **Tests.** Golden corpus (Reflect, Obsidian, GFM edge cases, broken frontmatter, mixed
   line endings) and a property test that `serialize(parse(x))` is stable and minimal-diff.

## One parser: `@lezer/markdown` (revised, was "remark + share grammar")

An earlier draft used **remark** for the index and Lezer for the editor, "sharing the
wiki-link grammar." That does not hold: remark uses *micromark* extensions and meowdown
uses *`@lezer/markdown`* extensions, so the rule would be written twice and guarded by a
cross-engine test forever.

So **`@lezer/markdown` is used for editor, indexer, and edits**. `packages/core/src/markdown/`
owns the GFM + wiki-link config, extraction, and splice-based edit helpers that edit the
source string by node position instead of re-serializing. The editor's `docToMarkdown`
and these edits share syntax, so one round-trip test covers both.

**remark stays out of the hot path.** Plan 13 is closed, so no HTML export pipeline
justifies it.

## Key decisions / contracts

- **`@lezer/markdown` (GFM + one wiki-link extension) is the one parser.** Edits are
  position-based splices. (Supersedes the remark recommendation.)
- **Unknown frontmatter is preserved.** zod `.passthrough()`; only the known subset is typed.
- **Identity = path/title in the first wave**; `id` is reserved and preferred when present.
- **Tags = body `#tag` only** this wave.
- **Edits are minimal-diff** to keep sync quiet.
- **The extraction output is a stable, versioned interface** for Plan 04.

## Acceptance criteria

- Parse → serialize is byte-stable for unedited notes.
- Broken/unknown frontmatter still yields a readable note + extracted links.
- `[[Wiki Links]]`, `[[Note|alias]]`, `[[2026-06-08]]` parse into typed nodes with positions.
- Extraction tests cover title fallback, tags, links, assets, headings, plain text.

## Risks

- **Wiki links are not CommonMark.** A regex breaks inside code spans/fences; the Lezer
  inline extension respects code contexts.
- **Round-trip drift** from normalizing. Prefer position-aware splices over full
  re-serialization, gated by the property test.
