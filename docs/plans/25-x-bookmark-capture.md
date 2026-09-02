# Plan 25 — X bookmark capture (saved posts)

**Goal:** bookmark (or, opt-in, like) a post on X and have it land in your graph
as a real note — the post's text, author, date, and images, not a bare URL — with
a bullet on the day's daily note. No Reflect server, no X API keys, no account:
the extension notices the bookmark on the page you are already looking at, hands
the post id (plus whatever it could read from the page) to the desktop app through
the existing capture inbox, and the app fetches the structured post from X's
embed backend, writes the note, and downloads the media. Capturing a post URL
explicitly (⌘⇧K or the popup on a post page) produces the same note; the bookmark
trigger is just an automatic producer of it.

**Depends on:** Plan 11 (extension, `reflect-capture-host`, capture inbox, drain,
enrichment, privacy gate) and the desktop's bounded web fetch primitives
(`src-tauri/src/web_fetch.rs`).

**Status (2026-09-02): Phases 1–2 implemented** in one PR — the `post` block
on the envelope (TS + host serde mirror + shared fixtures), the post note
template and its read-back parser (`post-note-render.ts` / `post-note-parse.ts`
over the shared `post-note-markup.ts`), the post frontmatter keys
(`post-meta.ts`), permalink detection for the drain (`post-capture.ts`),
syndication fetch/merge (`post-syndication.ts`, `post-merge.ts`), the post
enrichment leg (`post-enrichment.ts`, media in `post-media.ts`), the Rust
`capture_json_fetch` (generalized from the oEmbed fetch) and
`capture_media_fetch` commands, and in the extension the opt-in permission +
runtime-registered watcher (`lib/x/`, the options page, the popup nudge, the
badge). Landing the post leg also split the enrichment pass: the link legs
now live in `link-enrichment.ts`, both legs share `capture-enrichment-context.ts`,
and `reconcileCaptureEnrichment` is list → resume → dispatch by kind → count. Two deliberate deltas from the phase text below:
posts dedupe on **post id**, not URL (a handle-less `/i/status/` share and the
page's `/<handle>/status/` are one post), and the manual path (popup / ⌘⇧K on
a permalink) already sends the minimal page read through the on-demand
content script, so phase 3 is only the media/quoted extractor, the popup's
post preview, and the selector smoke test. The oEmbed title fallback was not
built: when both the endpoint and the page yield nothing, the note keeps the
tab title. The syndication endpoint and oEmbed were verified live; the
logged-in DOM contract (phase 0) has **not** been — the extractor and watcher
are tested against hand-written markup that mirrors the expected test ids,
and the manual pass below is still owed.

**Explicitly not in scope:**

- Deleting or editing the note when a bookmark is removed on X. Notes are the
  user's once written; un-bookmarking is observed only so a re-bookmark does not
  duplicate.
- Syncing the existing X bookmark list (past bookmarks, bookmarks made on the
  phone). That needs X's private GraphQL API with the user's session cookies —
  rejected below.
- Threads. A bookmark captures that one post; a quoted post is captured inline.
  The syndication answer carries one `parent` for replies, which a later
  iteration could render as context; not here.
- Video download. Videos keep their poster image plus the link (the syndication
  answer does list MP4 variants, so this is a policy choice, not a gap).
- Safari, Firefox. The extension is Chromium-only today; nothing here narrows a
  future port, but the trigger relies on `scripting.registerContentScripts`.
- Other networks (Bluesky, Mastodon, Threads). The `post` payload is deliberately
  provider-tagged so they can join later; only `x` ships here.

## Where we stand

### What the V1 extension did (`~/repos/reflect-browser`)

The whole feature is one ~90-line file, `src/shared/background/twitter-listener.ts`:

- A `chrome.webRequest.onBeforeRequest` listener (with `requestBody`) matched X's
  private GraphQL mutations `…/i/api/graphql/*/CreateBookmark` and `…/FavoriteTweet`
  on `twitter.com` and `x.com`, pulled `variables.tweet_id` out of the request body,
  and rebuilt a permalink `https://twitter.com/i/web/status/<id>`.
- It then POSTed `{ url, title: null, description: null, highlights: [] }` to
  `POST /api/graphs/:id/links/async`. **Everything else — fetching the post's text,
  author, and media, rendering it, creating the link note — happened on Reflect's
  servers.** None of that code exists in either repo.
- Two options-page checkboxes: "Save bookmarked tweets" (default on) and "Save
  favorited tweets" (default off).

What was good about it: the trigger was the user's own bookmark gesture, so
there was no separate "save to Reflect" ritual, and it fired regardless of how the
bookmark was made (button, keyboard `b`, share menu).

What was not:

- It needed the `webRequest` permission, `*://x.com/*` + `*://twitter.com/*` host
  permissions, and read request bodies on X — a heavy store-review surface for a
  one-field payload.
- It depended on a server-side unfurl that V2 does not have.
- Silent failure: no auth/graph guard, no retry, an un-awaited promise, no badge —
  a failed save was invisible.
- `twitter.com/i/web/status/<id>` vs `x.com/<user>/status/<id>` produced two
  distinct links for one post; a body split across `requestBody.raw` chunks was
  dropped.

### What X offers without a session (verified 2026-09-02)

- **The syndication endpoint** `https://cdn.syndication.twimg.com/tweet-result`
  — the backend of X's own official embeds (`publish.x.com`), also used by
  Vercel's `react-tweet`. Undocumented, but no auth, no cookies, and the `token`
  query parameter is a pure function of the post id
  (`((id / 1e15) * Math.PI).toString(36)` with zeros and the dot stripped). It
  answers structured JSON: `text`, `display_text_range`, `entities` (expanded
  URLs, mentions, hashtags), `user` (name, `screen_name`, avatar), `created_at`,
  `mediaDetails` / `photos` (full-size `pbs.twimg.com/media/…` URLs, video
  variants), `quoted_tweet`, `parent` for replies, `possibly_sensitive`, and
  `note_tweet: { id }` when the post is long-form — **in which case `text` is the
  truncated preview and the full text is not in the answer** (react-tweet renders
  a "Show more" link off that field). Deleted posts answer an HTML 404; withheld or
  protected ones answer `__typename: "TweetTombstone"`. Breakage precedent:
  `react-tweet#197` (Aug 2025, `user` vanished for a day, X-side) and `#187`
  (video variants stopped playing on mobile). The sibling profile-timeline
  endpoint answered `429` on the first request from this machine, so X does rate
  limit this family.
- **oEmbed** at `https://publish.x.com/oembed` (the old `publish.twitter.com`
  answers a 301, and `capture_oembed_fetch` follows no redirects). Text, author
  name/URL, and date inside an HTML blockquote; no media, no `title` field, so
  the existing `parseOEmbedAnswer` rejects it as-is. Strictly less than the
  syndication answer; kept only as a title fallback.
- **The logged-out permalink render** carries no `data-testid` markup at all —
  an HTML scrape of `x.com` is not a viable source.

### What V2 already has (reused unchanged)

- **The inbox contract.** `packages/core/src/actions/capture-envelope.ts` is the
  single source of truth (browser-safe, exported as
  `@reflect/core/capture-envelope`); `apps/native-host/src/envelope.rs` mirrors it
  in serde; `capture-envelope.fixtures.json` pins both validators. Unknown fields
  are tolerated; unparseable envelopes are quarantined, never deleted.
- **The transport.** Extension → per-capture `chrome.storage.local` queue
  (`apps/extension/lib/queue.ts`) → `sendNativeMessage` → host spools
  `<graph>/.reflect/inbox/<uuid>.json` (+ `.jpg`) → desktop drains on watcher /
  launch / wake (`apps/desktop/src/lib/capture-controller.ts`). Hold/retry/reject
  semantics live in `apps/extension/lib/flush.ts`.
- **The write path.** `drainCaptureInbox` (`capture-drain.ts`) creates
  `notes/capture-<stamp>.md` + a bullet under the daily note's `## [[Links]]`,
  dedupes same-day same-URL captures in place, and marks captures on a
  `private: true` day `skipped` so enrichment never touches them.
- **Enrichment.** `reconcileCaptureEnrichment` (`capture-enrichment.ts`): meta
  scrape (oEmbed shortcut in `oembed.ts`, YouTube only today) then optional BYOK AI
  title/description, with the structural privacy re-check around every await.
- **Bounded fetches.** `capture_meta_fetch`, `capture_oembed_fetch` (https, JSON,
  64 KiB, no redirects), `capture_link_preview`, and the reusable
  `fetch_public_image` in `web_fetch.rs` (used by editor link previews).
- **Tests.** `capture-harness.ts` (in-memory graph + spool for drain/enrichment
  tests), the TS/Rust fixture parity tests, `manifest-key.test.ts`.

The extension is entirely site-agnostic today: no host permissions, no declared
content scripts, no options page. Everything rides `activeTab`.

## Stepping back: what the feature is for

People bookmark on X because it is one keystroke; the bookmark list is then a
graveyard nobody revisits. The value Reflect adds is **turning that reflex into a
durable, searchable, linkable note** — in the user's own markdown, next to the
daily note it happened on, with the text preserved even after the post is deleted
or the account goes private. That framing drives every decision below:

1. **The note must carry the content.** A URL-only note is what the bookmark list
   already is. Text, author, date, and images must be in the markdown.
2. **The trigger must be the user's existing gesture,** not a new one. Otherwise
   this is just the popup, which already exists.
3. **Two content sources, because neither is sufficient alone.** The syndication
   endpoint gives clean structured data for public posts from the desktop, with
   no extension complexity. The page the user bookmarked from is the only source
   for protected accounts, for the full text of a long post (when on its
   permalink), and for the day X changes or throttles the endpoint.
4. **It must fit Plan 11's shape,** not fork it: same inbox, same drain, same
   privacy gate, same tests. A post capture is a link capture with structure.

## Architecture decisions

### 1. Trigger: an opt-in content script watching the bookmark button's state

The content script (registered only after the user opts in — see §5) observes
`article[data-testid="tweet"]` elements and captures when a post's bookmark button
flips from `bookmark` → `removeBookmark` (or, with the second toggle on, `like` →
`unlike`). Concretely:

- A `MutationObserver` on `document.body` (`childList` + `attributes`, filtered to
  `data-testid`) walks each mutation's target up to its `article` and compares the
  article's current bookmark/like state with the last state recorded for that
  post id in a `Map<postId, {bookmarked, liked}>`. **Only a `false → true`
  transition captures.** The first time an article is seen its state is recorded
  as the baseline, so already-bookmarked posts (the timeline, and the whole
  `x.com/i/bookmarks` page) never capture, and a re-mount that keeps the same state
  is a no-op.
- The post id comes from the article's permalink (`a[href*="/status/"]` around the
  `<time>`); the article element is what the page extractor (§2) reads.
- X updates the button optimistically; if the server rejects the bookmark X flips
  it back. We accept the optimistic capture (the note is still what the user
  wanted).

**Why not `webRequest` like V1?** Both approaches couple to a private X contract
(GraphQL operation names vs `data-testid`s), both fail silently when X renames it,
and both have broken exactly once historically (the x.com domain move). Equal
fragility — so the tiebreakers decide:

- The content script needs **no `webRequest` permission and reads no request
  bodies.** The store disclosure becomes "runs on x.com after you turn it on, reads
  the post you bookmark".
- At the moment of the flip **the post's DOM is right there** — text, author,
  media, quoted post — as the logged-in user sees it. `webRequest` sees an id and
  nothing else.
- Every way of bookmarking (button, `b` key, share menu, the post detail page)
  goes through the same React state and therefore the same DOM flip. No
  per-entry-point handling.
- Un-bookmark is observable for free, which is what makes re-bookmark dedupe
  correct (§6).

**Why not intercept GraphQL responses (main-world fetch patching)?** Far more
intrusive, needs `world: 'MAIN'` injection into X's page, and couples to X's
response shapes, which change more often than its test ids.

**Why not poll `x.com/i/bookmarks`?** That is X's private GraphQL API with the
user's session — a ToS and account-safety risk, and it is exactly the "sync my
bookmark list" feature we scope out.

### 2. Two content sources: the page at trigger time, the syndication endpoint on the desktop

The extension sends the post id and canonical URL plus **whatever the page
extractor could read** (all optional). The desktop app then fetches the post from
the syndication endpoint and merges: **the syndication answer wins for structure**
(exact `created_at`, expanded URLs, full-size media, quoted post) and **the page
wins for text when it has more of it** (a long post captured from its permalink
has the full text; the endpoint only has the preview). When the endpoint fails
(404, tombstone, 429, or the day X changes it) the page fields are what the note
gets; when the page extractor fails (X renamed a test id) the endpoint fields
are. Only when both fail does the note degrade to URL + `Name (@handle)` from
oEmbed — never a lost bookmark.

Why not the endpoint alone (id-only capture, like V1 but local)? It would be the
simplest extension by far, and it is where phase 1 starts. But it cannot see
protected accounts (tombstone), it truncates long posts, it has broken before,
it is rate-limited, and it costs one request to X per bookmark. Phase 3 adds the
page extractor precisely to cover those, and the merge rule above means the two
sources are complementary rather than redundant.

Why not the page alone? The page is fragile in the opposite way (test ids), and
it does not help the manual path for a logged-out user or a shared URL. The
endpoint makes *every* post permalink capture rich, including today's ⌘⇧K on a
tweet page, with zero extension changes.

### 3. One envelope, one new optional block: `post`

The link envelope (`captureEnvelopeSchema`) gains an optional `post` object rather
than a new `kind`. The codebase's rule is "new *producer* → widen `source`; new
*shape* → add a `kind`", and a post capture is not a new shape: it still wants URL,
title, `capturedAt`, `note`, the dedicated note, the daily bullet, same-day dedupe,
the privacy gate. What changes is the note *body* and the enrichment *leg*, both
of which branch on "this is a post". This also means the popup/⌘⇧K path and the
bookmark path build the identical wire message — one builder, one test suite.

The drain recognizes a post **by URL**, not only by the block: any link capture
whose canonical URL is `https://x.com/<handle>/status/<id>` (or the `twitter.com`
/ `/i/web/status/` variants) takes the post path with `trigger: 'manual'` and an
otherwise empty block. That is what makes phase 1 useful on its own.

```ts
// packages/core/src/actions/capture-envelope.ts (additive; version stays 1)
export const postMediaSchema = z.object({
  kind: z.enum(['image', 'gif', 'video']),
  /** Remote URL of the image, or of the poster for gif/video. */
  url: z.string().url(),
  alt: z.string().max(1000).optional(),
})

const postAuthorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  handle: z.string().trim().regex(/^[A-Za-z0-9_]{1,50}$/),
})

const quotedPostSchema = z.object({
  id: z.string().regex(/^\d+$/),
  url: z.string().url(),
  author: postAuthorSchema,
  text: z.string().max(POST_TEXT_MAX_LENGTH).optional(),
  postedAt: z.iso.datetime({ offset: true }).optional(),
})

export const capturedPostSchema = z.object({
  /** Which network; only `x` exists today. Bluesky/Mastodon join here. */
  provider: z.literal('x'),
  id: z.string().regex(/^\d+$/),
  /** Everything below is what the page could read; all optional, all best-effort. */
  author: postAuthorSchema.optional(),
  /** Plain text as rendered (emoji resolved, links as their display text + URL). */
  text: z.string().max(POST_TEXT_MAX_LENGTH).optional(),
  /** The page showed a "Show more": `text` is a prefix. Absent when unknown. */
  truncated: z.boolean().optional(),
  postedAt: z.iso.datetime({ offset: true }).optional(),
  media: z.array(postMediaSchema).max(4).optional(),
  quoted: quotedPostSchema.optional(),
  /** What produced the capture; `manual` is the popup / ⌘⇧K on a post page. */
  trigger: z.enum(['bookmark', 'like', 'manual']),
})
```

`url` on the envelope is the **canonical** permalink
`https://x.com/<handle>/status/<id>` (the extension canonicalizes `twitter.com`,
`/i/web/status/`, and query strings) so same-URL dedupe holds across entry points.
The serde mirror in `envelope.rs` validates the same bounds (the host must stay at
least as strict as the drain); new accepted/rejected cases go into
`capture-envelope.fixtures.json`, never into one side.

### 4. The desktop owns the fetch, the merge, and media; posts skip the AI leg

Drain (`capture-drain.ts`), for a post capture:

- Note body from a new `post-note.ts` template (§7) built from the page fields
  (or just the URL); frontmatter adds `captureKind: post`, `postProvider`,
  `postId`, `postTrigger`. `captureStatus` starts `pending` (or `skipped` on a
  private day, as today).
- Daily bullet text is `Name (@handle): first line…` when known, else the bare
  URL until enrichment retitles it (the existing `retitleDailyEntry` transaction
  handles the two-file update).
- Same-day dedupe reuses `findSameDayCapture` on the canonical URL.

Enrichment (`capture-enrichment.ts`), a `post` branch before the link legs, with
the privacy re-check around every await exactly as the link legs do:

1. **Syndication fetch.** `packages/core/src/actions/post-syndication.ts` owns
   the policy: the request URL (id, `lang=en`, the computed `token`, the
   `features` list react-tweet sends), a zod schema of the **subset** we consume
   (`text`, `display_text_range`, `entities.urls[].{url,expanded_url,display_url}`,
   `user.{name,screen_name}`, `created_at`, `mediaDetails[].{type,media_url_https,
   video_info.variants}`, `quoted_tweet`, `note_tweet`, `__typename`,
   `possibly_sensitive`), and the outcome mapping: JSON `Tweet` → merge;
   `TweetTombstone` or empty object or 404 → permanent, keep page fields;
   `429`/network → transient, the enrichment pass retries later (already the
   contract for `network` errors). Transport is the existing JSON fetch primitive
   generalized from `capture_oembed_fetch` to `capture_json_fetch` (same bounds:
   https, JSON content type, 64 KiB, no redirects) — policy stays in core.
2. **Merge** (pure, unit-tested): structure from the endpoint; text from the
   longer of page vs endpoint unless the endpoint says `note_tweet` and the page
   text is not marked truncated (then the page has the full text); `t.co` URLs
   in the endpoint text replaced with `entities.urls[].expanded_url`; media from
   the endpoint (full size) else the page (upgraded to `name=large`).
3. **Media → assets.** Each image fetched through a new bounded command
   `capture_media_fetch(url) -> base64` built on `web_fetch::fetch_public_image`
   (public-internet scope, raster content types, ~10 MiB cap), downscaled with
   the existing `downscale_jpeg` path (1600 px long edge), written with
   `writeAsset(assets/<base>-<n>.jpg)`, and the note's `![…](remote)` rewritten
   to the local path. Video/gif → poster image + `[Watch on X](url)`. A 4xx keeps
   the remote link (the V1-import precedent).
4. **Rewrite the note** with the merged post (body, title, daily bullet via the
   existing retitle transaction); `captureStatus` → `done`.
5. **oEmbed** (`publish.x.com`, a new provider entry whose answer has no `title`
   and therefore its own parser) runs only when the syndication answer was
   permanent-failed *and* the page gave no author — it recovers
   `Name (@handle): text` for the title and nothing more.
6. **No AI title or description.** `Name (@handle): text…` is a better title than
   any model's guess, and the post *is* the description. (Revisit for long posts;
   it would be one `describePage` call over the note text behind the same gate.)

The privacy gate is unchanged and applies to every request here: a
`private: true` daily note means **no outbound request at all** — no syndication
fetch, no media download; the note keeps the page fields and remote links with
status `skipped`. Both the syndication request and `pbs.twimg.com/media/<id>`
disclose to X which post you saved, so they are gated exactly like the meta
scrape. `docs/privacy.md` must say so.

### 5. Permissions: nothing new at install; opt-in requests X only

- `wxt.config.ts` adds `optional_host_permissions: ['*://x.com/*',
  '*://twitter.com/*']`. Install-time permissions stay exactly as today, so the
  store listing and the existing Plan 11 disclosure remain true for users who
  never turn this on.
- Turning the feature on (options page or the popup nudge) calls
  `browser.permissions.request({ origins })` from the user gesture, then
  `browser.scripting.registerContentScripts([{ id: 'x-bookmarks', matches, js,
  runAt: 'document_idle' }])`. On `runtime.onInstalled` the background re-registers
  when `permissions.contains` is still true (registrations do not survive updates);
  `permissions.onRemoved` unregisters and flips the preference off.
- The old extension's `webRequest`, `<all_urls>`, and always-on X host permissions
  are gone.

### 6. Dedupe and idempotence

Three layers, cheapest first:

1. **Transition detection** (§1): only `false → true` captures, so scrolling past
   bookmarked posts, X re-mounting an article, and the bookmarks page never fire.
2. **Extension seen-set:** the content script asks the background to enqueue; the
   background writes `seen:x:<postId>` (its own key, written immediately — not
   V1's 2 s-debounced snapshot that lost entries when the worker died) and skips a
   post already seen. Un-bookmark clears the key so a deliberate re-bookmark
   captures again. Keys are pruned past a few thousand entries.
3. **Desktop same-day dedupe** on the canonical URL, as for every link capture.

Accepted limitation: re-bookmarking a post from a *different* browser profile on a
*different* day yields a second note. The correct fix — a `capture_url` column on
the `notes` projection so the drain can dedupe any link capture across time — is
a small index-schema migration that benefits ⌘⇧K captures too; it is a
follow-up, not a prerequisite.

### 7. Note shape

A dedicated note per post, exactly like link captures (not an inline blockquote in
the daily note): notes are the unit of search, backlinks, embeddings, and
enrichment, and the existing dedupe/retitle/recovery machinery is note-based.
V1 did the same (one link note per tweet).

```markdown
---
aliases: [capture-2026-09-02-101522-317-4f2a]
captureUrl: https://x.com/jack/status/20
capturedAt: 2026-09-02T10:15:22.317Z
captureSource: extension
captureKind: post
captureStatus: done
postProvider: x
postId: "20"
postTrigger: bookmark
captureHash: …
---
# jack (@jack): just setting up my twttr

- URL: https://x.com/jack/status/20
- Type: #tweet
- Author: [jack](https://x.com/jack) (@jack)
- Posted: 2006-03-21

> just setting up my twttr

![](assets/capture-2026-09-02-101522-317-4f2a-1.jpg)

> **Quoting** [Name (@handle)](https://x.com/handle/status/…)
> > quoted text

## Note

(the popup's optional note, manual captures only)
```

Decisions inside the template, each reversible:

- **Title** `Name (@handle): <first line, clipped>` through the existing
  `normalizedPageTitle` (100 chars, wiki-link safe). Deterministic; no AI.
- **`Type: #tweet`** — the word people search for, even though X says "post".
- **Daily section:** the existing `## [[Links]]`, bullet
  `[[<base>|jack (@jack): just setting up my twttr]]`. A separate `[[Tweets]]`
  section is a one-constant change if the stream proves noisy; it is not the
  default because it adds a surface (Product Principles: minimal UI).
- **Text as a blockquote**, links kept as `[display](expanded url)`, emoji as
  characters, hashtags/mentions as plain text linking to X. No wiki-links are
  minted for mentions — auto-creating people notes is a separate product
  question.
- **Long posts** whose full text could not be obtained end with `…` and a
  `[Read the full post on X](url)` line, and keep `postTruncated: true` in
  frontmatter so a later pass (or a manual re-capture from the permalink) can
  complete them.
- Media are numbered `-1`, `-2` … after the capture base; `alt` becomes the image
  alt text.

## Contracts to pin

### Syndication (verified live 2026-09-02; keep a recorded fixture per shape)

- `GET https://cdn.syndication.twimg.com/tweet-result?id=<id>&lang=en&token=<t>&features=<react-tweet list>`
  with `token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')`.
  Send a browser-like `User-Agent` (the primitive already does).
- `200` JSON `__typename: "Tweet"` → the subset schema above. `photos[].url` and
  `mediaDetails[].media_url_https` are full-size `pbs.twimg.com/media/<id>.jpg`.
- `200` JSON `__typename: "TweetTombstone"` → protected/withheld: permanent.
- `200` `{}` or HTTP `404` (HTML body) → deleted/never existed: permanent.
- `429` → transient; also the signal to keep the enrichment pass's one-at-a-time
  cadence and never batch-backfill.
- `note_tweet` present → `text` is a preview; do not overwrite longer page text.

### DOM (to be confirmed in the phase-0 spike, logged in)

The logged-out render has no `data-testid`s, so this table is expectation, not
verification. The spike saves sanitized HTML fixtures per row.

| Purpose | Selector (expected) |
| --- | --- |
| Post container | `article[data-testid="tweet"]` |
| Text | `[data-testid="tweetText"]` (spans + `img[alt]` emoji + `a`) |
| Truncation | `[data-testid="tweet-text-show-more-link"]` present |
| Author | `[data-testid="User-Name"]` (name, then `@handle` link) |
| Permalink + time | `a[href*="/status/"] > time[datetime]` |
| Images | `[data-testid="tweetPhoto"] img[src*="pbs.twimg.com/media"]` |
| Video / gif | `[data-testid="videoPlayer"] video[poster]` |
| Quoted post | nested `[role="link"]` containing its own `tweetText`/`User-Name` |
| Bookmark state | `button[data-testid="bookmark"]` ↔ `"removeBookmark"` |
| Like state | `button[data-testid="like"]` ↔ `"unlike"` |
| Repost context | `[data-testid="socialContext"]` (capture the *inner* post) |

Also to confirm in the spike: whether X flips `data-testid` on the same button
element or re-mounts it (both are handled, but the fixture should show which);
that `optional_host_permissions` + `registerContentScripts` behave under `wxt dev`
reloads; the MutationObserver's cost on a busy timeline (measure before choosing
`document.body` over `main`); and, with a protected account the tester follows,
that the tombstone path really is what the endpoint answers.

## Phases

### Phase 1 — core + host: any post URL becomes a post note (implemented)

Contract-first, testable without touching the extension: spool a hand-written
envelope, or ⌘⇧K on a post permalink with today's extension.

- `capture-envelope.ts`: `capturedPostSchema`, `post?:` on the link envelope,
  `isPostUrl`/`canonicalPostUrl`, fixtures (accepted: URL-only, id-only block,
  full block with media + quote; rejected: bad handle, >4 media, non-https media
  URL, unknown provider).
- `apps/native-host/src/envelope.rs`: serde mirror + bounds; parity test passes
  from the shared fixtures.
- `post-syndication.ts`: request URL + token, answer schema, outcome mapping,
  recorded-fixture tests (text-only, photo, video, quoted, reply, long-form,
  tombstone, `{}`, 404 HTML, 429).
- `post-merge.ts`: the pure merge rule with table tests.
- `post-note.ts`: template + `postDisplayTitle`; `capture-note.ts` dispatches on
  post; `captureNoteMetaSchema` learns the `captureKind`/`post*` keys.
- `capture-drain.ts`: post branch (URL detection, body, daily bullet text).
- `src-tauri/src/capture.rs`: `capture_json_fetch` (generalized from
  `capture_oembed_fetch`) and `capture_media_fetch` on `fetch_public_image`; TS
  bindings in `graph/commands.ts`.
- `capture-enrichment.ts`: the post leg (fetch → merge → media → rewrite →
  `done`; oEmbed title fallback), privacy re-checks around each await.
- `oembed.ts` + `meta-scrape.ts`: `x` provider on `publish.x.com` with its
  title-less answer parser.
- Tests via `capture-harness.ts`: URL-only capture becomes a full note from a
  mocked syndication answer; page text beats preview text for a `note_tweet`;
  media download rewrites links and is skipped on a private day; tombstone keeps
  page fields; 429 leaves `pending` for the next pass; 404 media keeps the remote
  link; manual and bookmark triggers produce identical notes; same-day
  re-capture refreshes in place.
- `docs/privacy.md`: the "Browser capture" section gains the syndication
  request and media download under the same gate.

**Deliverable:** ⌘⇧K on a tweet produces a note with text, author, date, and
images. No extension change shipped yet.

### Phase 2 — extension: automatic bookmark capture (implemented)

- `wxt.config.ts`: `optional_host_permissions`; the content script registered at
  runtime (`entrypoints/x-bookmarks.content.ts`, `registration: 'runtime'`).
- `lib/x/bookmark-watch.ts`: the observer + transition map, unit-tested with
  synthetic DOM under `happy-dom` (the extension's vitest project runs in node
  today; add the dev dependency and a per-file `@vitest-environment` docblock
  rather than moving these tests into the desktop's browser project). Cases:
  flip on the same element, re-mount, baseline-on-first-sight, the bookmarks
  page, un-bookmark then re-bookmark.
- `lib/x/extract-post.ts`, **minimal**: post id, canonical URL, author, text,
  `truncated` — the four cheapest selectors. Media and quoted posts wait for
  phase 3; the endpoint covers them meanwhile.
- Content script → `runtime.sendMessage({ type: 'capture-post', page })`;
  background checks the seen-set, enqueues through the existing
  `saveCapture`/`flushQueue`, writes `seen:x:<id>`, and shows a `✓` badge for 3 s
  (V1 had this for manual saves but not tweets; a silent capture is
  indistinguishable from a broken one).
- Options page (`entrypoints/options`, the extension's first): section "X"
  with "Save posts you bookmark" and "Also save posts you like"; enabling
  requests the permission and registers the script; `permissions.onRemoved`
  reverts. Popup: on x.com with the feature off, a one-line "Save your X
  bookmarks automatically — Turn on".
- Preferences: `preference:xBookmarks`, `preference:xLikes` alongside
  `popup-preferences.ts`.
- `apps/extension/README.md`: permission table rows for the optional origins;
  the store "Data-handling" text changes from "never in the background" to
  "on x.com, only after you enable it, only for posts you bookmark or like".
  `docs/privacy.md`: the same statement.

**Deliverable:** the V1 feature, better: bookmark → note with content, badge,
retries, no server.

### Phase 3 — extension: the full page extractor and the post-aware popup

Resilience and coverage: protected accounts, long posts from their permalink,
and the day the endpoint changes.

- `extract-post.ts` grows media (`name=large`), quoted post, video poster;
  tested against the phase-0 fixtures.
- `capture-content.content.ts` gains an `extract-post` message so the popup and
  ⌘⇧K on a permalink send the block too.
- Popup: on a post page, render the post (author, text, thumbnails) instead of
  the tab screenshot; the note field and Save stay. The screenshot is sent only
  when extraction fails, never alongside a post block.
- A fixture-driven "selector smoke" test so an X markup change is a red test.

### Phase 0 — spike (½ day, gates phases 2–3, not phase 1)

Logged-in session, real bookmarks, no product code. Outputs: the fixture set
(`apps/extension/lib/x/__fixtures__/*.html` — text-only, photos, video, quoted,
long/truncated, repost, reply), the flip mechanics, the observer cost number,
the tombstone check, and a go/no-go on the selector table.

### Follow-ups (not gating)

- `capture_url` on the `notes` projection for cross-time dedupe of every link
  capture.
- A second provider (`bluesky`) to prove the `post` shape is not X-shaped.
- Render the syndication `parent` for replies; thread capture.
- AI summary for long posts, if asked for.

## Verification

Automated: `pnpm check`, `pnpm test --run` on the touched extension/core files,
`cargo test -p reflect-capture-host` (fixture parity), `cargo test -p reflect-open`
(the new fetch commands), after `pnpm --filter @reflect/desktop sidecar`.

Manual pass (logged-in X, desktop app running, then closed):

| Case | Expect |
| --- | --- |
| ⌘⇧K on a permalink (phase 1, today's extension) | Note with text/author/date/images after enrichment |
| Bookmark from timeline (button) | Note within ~1 s + enrichment; daily bullet; badge |
| Bookmark with `b` on a focused post | Same |
| Bookmark from the share menu | Same |
| Bookmark on the post detail page | Same, full text |
| Long post from timeline | Preview text + "Read the full post" line; `postTruncated` |
| Long post from its permalink (phase 3) | Full text from the page, structure from the endpoint |
| Post with 4 images | Four local assets, full size |
| Video post | Poster asset + "Watch on X" link |
| Quoted post | Quote block rendered |
| Protected account the tester follows (phase 3) | Note from page fields; endpoint tombstone logged, not an error |
| Like with the toggle off / on | Nothing / note with `postTrigger: like` |
| Un-bookmark, re-bookmark same day | One note, refreshed |
| Scroll `x.com/i/bookmarks` | No captures |
| App closed → bookmark → launch | Held in queue, spools, drains on launch |
| Daily note `private: true` | Note written from page fields, no requests, `skipped` |
| Endpoint 429 (simulate) | Stays `pending`, completes on a later pass |
| Remove the X permission in `chrome://extensions` | Toggle reverts, script gone |

## Risks and open questions

- **The syndication endpoint is undocumented.** X has changed it (Aug 2025
  user-data outage, video variants) and rate-limits its siblings. Mitigations:
  it is one of two sources; failures are typed (permanent vs transient) so the
  note is never blocked on it; the request is one-per-bookmark, never a
  backfill; the recorded fixtures make a shape change a red test. If X removes
  it entirely, phase 3's extractor carries the feature at V1-or-better quality.
- **X changes its `data-testid`s.** Same exposure as V1's GraphQL names. If only
  extraction breaks, captures still complete from the endpoint; if the flip
  detection breaks, the feature stops and the manual path still works.
- **Long-form posts** have no unauthenticated full-text source. The permalink
  page is the only one; the note says so and stays completable.
- **Observer cost on X's timeline.** Measured in the spike; the fallback is
  event-delegated click/keydown intent + a scoped per-article observer.
- **Likes as a capture trigger** are noisy; default off (V1's choice). Keep.
- **Should mentions become `[[people]]` notes?** Not here; it changes the graph
  on every bookmark. Worth a separate discussion with the Contacts integration
  in mind.
- **`[[Links]]` vs `[[Tweets]]`** in the daily note: default Links; revisit with
  usage.

## Rejected alternatives (recorded so they are not re-litigated)

- **Port V1's `webRequest` listener as-is.** Heavier permissions for a payload
  that has no content; needs a server that V2 does not have.
- **Endpoint-only, forever** (id in, syndication out, no page extractor). Where
  phase 1 starts, but not where it ends: protected accounts, long posts, and
  endpoint outages all need the page. Kept as the degraded mode, not the design.
- **Page-only** (no desktop fetch). Fragile in the opposite direction, and it
  leaves the manual/shared-URL path with nothing.
- **oEmbed as the primary desktop source.** Strictly less than syndication (no
  media, no structure, no `title`), and it redirects. Title fallback only.
- **A new `kind: 'post'` envelope.** A post is a link capture with structure;
  a separate kind would duplicate identity, dedupe, daily-bullet, and privacy
  code for no wire-level gain.
- **Inline blockquote in the daily note, no dedicated note.** Loses backlinks,
  search-as-a-note, media placement, and the retitle/recovery machinery.
- **Bookmark-list sync.** Private API + session cookies; out of scope.
- **Deleting the note on un-bookmark.** Destructive and surprising.
