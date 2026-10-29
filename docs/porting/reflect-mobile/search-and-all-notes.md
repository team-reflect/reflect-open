# Porting search and All Notes

**v2 status: shipped for the list + lexical search + filter badges (the
All tab, `apps/desktop/src/mobile/screens/all-notes.tsx`, badges in
`apps/desktop/src/mobile/search-filters/`); AI search chat is a later wave
(with the copilot).**

## What V1 mobile does

Implementation: `client/screens/notes-list/` (list, search bar, filters, AI
chat), `services/search/` (shared search stack).

### The list

- A virtualized list (react-virtuoso): title + first content line +
  relative time ("2 days ago"). Rows are fixed-height (68 px), so
  placeholder resolution never jumps.
- Order: pinned first (`pinnedIndex ASC NULLS LAST`), then most recently
  edited.
- Tap → detail (`/:graph/all/:id`); tag taps from the editor land here as
  a filtered list (`/:graph/all/tag/:tag`) with a back button.
- Empty state, pull-to-refresh, double-tap-tab scroll-to-top.

### Search

- An `IonSearchbar` ("Search anything…") with 300 ms debounce and a
  3-character minimum (shorter queries show a hint).
- **Local FTS5 only**: unicode61 tokenizer, BM25 with ~3× subject weight,
  re-ranked by recency, pinned, and exact-subject match (same as desktop
  V1). Trigram is disabled on mobile, and `notesVec` exists but is unused:
  **V1 mobile shipped without semantic search and it was not missed**.
- Typing `#` switches to fuzzy tag search; picking a tag filters the list.

### Filter badges

A scrollable badge row under the search bar
(`client/screens/notes-list/search-filter/search-filter-bar.tsx`):

- **Pinned** and **Published** toggles.
- **Tags** (multi-select modal).
- **Linked to** / **Linked by** a chosen note (note-picker modals).
- **Created at** / **Updated at** (relative presets + custom ranges) and a
  **Daily notes** filter.
- Filters AND together; a **Reset** button animates in when any is active.

### AI search chat

A chat icon in the search bar opens `/:graph/all/ai-chat`: a chat
**grounded in the current search results** (desktop V1's "chat over an
explicit retrieval set", as a page instead of a modal). Streaming answers,
inline citations to source notes, stop while streaming, and a provider
disclosure. View model shared with the notes list
(`client/screens/notes-list/ai-chat/`, `client/screens/ai-chat-page/`).

## What changes in v2, and why

- **Same search shape, different substrate.** The All tab uses the FTS5
  getters with the same schema and ranking as desktop v2, over the
  rebuildable `.reflect/` projection.
- **Semantic search stays off mobile** per the indexing strategy
  (`fastembed`/ORT is desktop-only). V1 shows lexical-first is a proven
  mobile scope.
- **Filter badges are V1-parity work** (Plan 19: "embedded search and
  filter badges"), minus dead concepts: *Published* has no v2 meaning
  (publishing deferred), and *Created at* has no substrate (the index has
  no creation time, markdown carries none, and file birthtimes don't
  survive Git/iCloud sync, so it would rank on garbage). *Pinned*, *Tags*,
  *Daily*, and *Updated at* map to index columns; *Linked to/by* to the
  backlink projection.
- **AI chat waits for the copilot wave.** It should be the v2 chat engine
  (BYOK, CloudSafe/`private: true` enforcement) grounded in search results:
  V1's retrieval-set grounding is the model to keep, and its visible
  provider disclosure is already v2 policy.
- Minimum length and debounce may differ (desktop v2 wins), but
  fixed-height rows and virtualization are load-bearing on mobile and
  already the v2 approach.

## V1 → v2 mapping

| V1                                             | v2                                                             |
| ---------------------------------------------- | --------------------------------------------------------------- |
| FTS5 BM25, 3× subject, recency/pinned/exact    | Same-index FTS5 getters as desktop v2                           |
| Vector search stubbed out                      | Explicitly out (indexing strategy); lexical-first               |
| Filter badges incl. Published, Created at      | V1-parity badges minus Published/Created; backlink + updated    |
| `#` tag search mode                            | Tag filtering per desktop tag parity                            |
| Virtuoso, fixed 68 px rows                     | Virtualized list (same technique)                               |
| Search-grounded AI chat page (server AI)       | Later wave: copilot/chat engine, BYOK, `private: true` blocked  |
| Pull-to-refresh                                | Optional; index updates arrive via the in-process write seam    |
