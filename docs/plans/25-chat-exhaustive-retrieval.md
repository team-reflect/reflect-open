# Plan 25 — Exhaustive retrieval for AI chat

**Goal:** let the chat answer "find that conversation" questions completely and
cheaply: *every* note that mentions some people and a topic, in a date range,
so a mid-size local model (e.g. Qwen 3.6 35B over Ollama) answers them as well
as it does in a file-tool agent that can grep. Read-only, behind the existing
`CloudSafe` gate.

**Depends on:** Plan 10 (chat engine, note tools, `CloudSafe`), Plan 04 (FTS).
**Unlocks:** reliable people and meeting recall in chat, on any provider.

**Explicitly not in scope:** regex or operator syntax in tool inputs; stemming
or substring indexes (word-start prefixes plus model-supplied stems cover word
forms); date filters on `search_notes`; changing the tool-round ceiling
(`MAX_STEPS`); write tools.

> **Status (2026-11-03): implemented.** Checked by hand against Qwen 3.6 35B
> on a real graph: before, the chat could not find the conversation; with
> grouped alternatives, it finds the exact note.

## Where we stand

A prompt like *"I talked farming with Andy and Bob this summer or autumn:
beets, bears, or battlestar galactica. Find records of the conversation."*
needs "every daily note from June on mentioning Andy or Bob and any of those
topics". Before
this plan the chat tools could not express that:

- `search_notes` is ranked top-N (default 8, max 20) over the whole graph, with
  no date filter. Its lexical leg ANDs every word of the query, so a
  natural-language query from a smaller model matches nothing. Its semantic
  leg (MiniLM, 1,000-char chunks, 0.7 cosine cutoff) gives names almost no
  weight.
- `list_daily_notes` returns paths and 120-char previews, 31 days per call.
  Reading ~150 daily notes at `MAX_READ_NOTES = 10` per call does not fit the
  12-round ceiling or a 64k context.

A file-tool agent (OpenCode) with the same model answered the question with one
grep pipeline, `(andy|bob)` then `(beets|bears|battlestar|galactica)`.
This plan gives the chat that capability, built only from parts search already
uses: `search_fts`, its `snippet()`, the `backlinks` view, `WikiResolverService`,
and `cloudSafeSearchHits`.

## Contracts

### `buildFtsGroupsMatch`

`search-query.ts` builds an FTS5 expression from groups of alternatives: OR
within a group, AND across groups, every word of a multi-word alternative
required, each word a quoted prefix over title and body as in `buildFtsMatch`.
A word whose last token is a single character (`R&D`, `Bob's`) matches
exactly rather than as a prefix, as in the title prefix search, since `a*`
expands to most of the vocabulary. Untokenizable words, and alternatives they
leave empty, are dropped; a group left empty makes the whole expression `null`,
since dropping it would widen the match.

### `RetrievalService.findAll`

```ts
findAll(groups: readonly (readonly string[])[], options: {
  limit: number
  from?: string | null      // daily notes on or after this ISO day
  to?: string | null        // daily notes on or before this ISO day
  linksTo?: string | null   // notes linking to this title, alias, or date
}): Promise<
  | { ok: true; hits: RetrievalHit[]; truncated: boolean }
  | { ok: false; reason: 'unresolvedLink' | 'unsearchableWords' }
>
```

- **Groups of alternatives:** a note matches when it contains at least one
  alternative from every group, the shape of a grep pipeline:
  `[["Andy", "Bob"], ["beets", "bears", "battle", "galactica"]]`. A first
  version took one flat list that had to match entirely. Against Qwen it was
  too strict: the model's four words excluded the note grep found. Stems in the
  alternatives catch word forms without a stemming index.
- **Exhaustive, not ranked:** one SQL query (FTS match, daily-date range,
  `EXISTS` on `backlinks`, private notes and templates excluded), most recent
  first, where a daily note's recency is its date and any other note's is its
  last edit, with the path as tie-breaker. It fetches `limit + 1` rows, so
  `truncated` means "older matches exist". "Every note matching" is a different
  contract from `search_notes`' "best few matches", which is why it is a
  separate tool rather than a mode.
- **Snippets:** each hit carries FTS5's `snippet()` at its 64-token maximum: the
  stretch of the body with the most matching words, marked like search
  snippets. It is the existing search-result mechanism, sized up because here
  the snippet is the evidence, not just a way to recognise the note. A note
  matched only by its title gets no snippet, as in search: the unmarked body
  fragment would not be evidence.
- **Refusals, not empty results:** a `linksTo` that names no public note, a
  group with no searchable word, or a `from` after `to` is refused rather than matched against
  nothing, so a typo is not reported as "no such conversation". A private
  target is refused like a missing one, so the reply never reveals that a
  private title exists. `[[Title]]` is accepted as a target.
- **Privacy:** notes indexed as private are excluded before the limit, so they
  cannot surface through `truncated` either. Hits are `RetrievalHit`s, so the
  tool gates them with `cloudSafeSearchHits`, which re-checks each note live,
  as `search_notes` does.

### Tool `find_in_notes`

Input `{ groups, from?, to?, linksTo? }`: at most 4 groups of 12 alternatives;
the optional fields also accept `null` or an empty string, which local models
send for parameters they leave unused. Output
`{ ok: true, hits: CloudSafe<CloudSearchHit>[], truncated }`, or a refusal
`{ ok: false, error }`. The transcript gains a `find` tool part, persisted by
`chat-history-service` and rendered by `ChatToolChip` as
`Found N notes for (“Andy” or “Bob”) and “beets” in …: …`, outcome and
search first and the note links last, where the truncation falls, with a
refusal or error in place of the count.

### System prompt

One grounding rule: for questions about people, conversations, or meetings,
start with `find_in_notes`, with the people in one group and the topic in
another, each with synonyms and stems. Dates limit it to daily notes, so the
model leaves them out when the note may be a regular one; `list_daily_notes`
stays the way to see a whole period.

## Acceptance criteria

- `findAll([["Andy", "Bob"], ["battle", "bears"]])` finds notes that say
  "battlestar" or "bears" and leaves out one that names the people only.
- Date and link filters restrict the result; an unknown or private link target,
  or words that cannot be searched, are refused. A regular note sorts among
  daily notes by its last edit.
- A word like `R&D` or `Bob's` still narrows the match.
- No tool output, count, or refusal reveals a `private: true` note, including
  one flagged after its last index pass.
- `search_notes` behaves exactly as before.

## Risks

- **Tool count.** Small models choose worse among more tools. Mitigation: one
  new tool, with a description and a prompt rule that say when to use it.
  Against Qwen 3.6 35B it was chosen without further prompting.
- **Word forms** depend on the model supplying stems or variants. The prompt
  asks for them. A stemming index would remove that dependency, but it would
  change palette search and require a reindex.
- **One snippet per note.** A note that names the people in one place and the
  topic in another shows only the best stretch. The model reads the note with
  `read_notes` when a snippet is not enough.
- **Snippets come from the index**, so, like `search_notes` snippets, they can
  lag an edit and can include the asset descriptions the index appends to note
  bodies, including for an asset a private note also embeds, which
  `read_assets` would refuse. The fix, indexing asset text in its own FTS
  column, changes both tools and needs a reindex, so it is a follow-up.
- **Inherited from lexical search:** short names prefix-match longer words
  (`Tim` finds `timeline`); runs in unsegmented scripts are single tokens, so
  a word inside one does not match; a note marked private moments before its
  reindex can still be accepted as a link target, the same lag the chat's graph
  overview accepts.
