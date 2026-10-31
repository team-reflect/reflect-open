# Reflect V2 Grounding Brief

**Purpose:** A broad overview of the current (V1) Reflect app (product model, feature surface, UX assumptions, constraints) and its likely migration implications for V2.

**Decision status:** Grounding material from the V1/Academy docs, not the source of truth for V2 decisions. When it conflicts with the V2 decision docs, defer to [Reflect V2 Product Vision](./reflect-v2-product-vision.md), [Reflect V2 Indexing Strategy](./reflect-v2-indexing-strategy.md), and [Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md).

**Primary sources:** Reflect Academy / Notion pages browsed via the Notion connector on 2026-06-08 (listed at the end).

---

## 1. Executive Summary

Reflect is a personal note-taking and knowledge-management app built on a deliberately simple model:

- **Daily notes are the default capture surface** for journals, meetings, bookmarks, tasks, and loose thoughts.
- **Graph-first, not hierarchy-first.** Notes link to notes with backlinks; tags add categorization.
- **Minimal but keyboard-driven**: command palette, slash commands, backlinks, shortcuts.
- **More than an editor**: capture surfaces, AI, search, publishing, integrations, tasks, audio transcription, import/export, and an API.
- **Security and data ownership are core.** Notes, images, and files are end-to-end encrypted client-side, which constrains API design, server capability, search, AI, publishing, and recovery.
- **Narrow core UI, breadth through integrations** (calendar, contacts, Zapier, Readwise, Kindle, browser extensions, iOS share sheet, deep links).

V2 should keep fast capture, daily notes, backlinks, graph-based recall, trust, and portability, while revisiting encryption, AI, task depth, sync, mobile parity, local-first behavior, and structured extraction. V2 intentionally does not keep V1's E2EE-first architecture.

---

## 2. Product Philosophy

Memory is associative and temporal, so the app has two primitives: **time** (daily notes as an infinite chronological spine) and **association** (backlinks between people, companies, places, books, meetings, and ideas). The docs say to put everything into today's daily note, that Reflect has "no hierarchy, only association," that tags categorize while backlinks associate, and that the product avoids feature clutter. Reflect is a **personal memory graph** for fast capture and later recall, not a team document workspace or database-heavy project tool.

---

## 3. Core Information Architecture

- **Graphs.** Setup creates a graph and an encryption password. The graph is the top-level encrypted container: the password, preferences, import/export, and recovery are graph-scoped. Multiple graphs can exist (imports may create them), though docs assume a default such as "My Brain."
- **Notes** are regular or daily. They hold text, bullets, headings, backlinks, tags, tasks, checklists, templates, bookmarks, highlights, images/files, and AI or transcription output, and support revision history and publishing.
- **Daily notes** are the workflow anchor, reachable by shortcut and palette, with natural-ish navigation ("go to daily note", "5 days from now").
- **Backlinks** are created with `[[`, for any entity (person, company, place, project, idea). Docs recommend full names, not abbreviations. Backlinks are **case-sensitive**. Incoming backlinks appear at the bottom of linked notes. Split-pane editing exists mainly to edit backlinked notes without leaving the daily note.
- **Tags** categorize; some drive behavior: `#book` (Kindle imports), `#person` and `#company` (Clearbit-like enrichment). Tags work in search filters.
- **Tasks vs checklists.** Tasks are concrete todos with round checkboxes that appear in the Tasks tab. Checklists (e.g. shopping lists) use square checkboxes and stay local to the note. Tasks are created by slash command, `+` then space, or bullet conversion, and can be aggregated, edited, completed, archived, and scheduled. Tasks are intentionally simple, not a task-manager replacement.

---

## 4. Main UX Model

### 4.1 Keyboard-First Operation

Key shortcuts: `[[` backlink; `cmd k` search/command overlay; `cmd d` daily note; `cmd n` new note; `cmd /` shortcuts list; `cmd enter` list item to todo/checklist; `cmd shift return` bullet to task (tasks beta); `cmd shift f` no-distraction mode; `cmd ,` preferences; `cmd j` AI palette; `cmd shift p` browser capture; `cmd + click` or `command enter` on a backlink opens a split pane; `escape` closes it; `command option left/right` moves focus between panes.

V2 implication: shortcuts are product identity. Command routing, focus management, and keyboard ergonomics are first-class architecture.

### 4.2 Surfaces

- **Command palette** (`cmd k`): find and search notes, run basic commands, navigate by date; advanced search lives here too.
- **Slash menu**: inserts templates and tasks; likely the editor's block/action insertion mechanism.
- **Split pane**: view and edit two notes at once, positioned for editing linked notes in daily-note context. It is a direct response to the backlink workflow, not a generic productivity feature.

---

## 5. Feature Inventory

### 5.1 Onboarding and Account Setup

Flow: authenticate (email, Google, Apple) → create graph and encryption password → recovery kit downloads automatically → tutorial. Desktop or web setup is required before iPhone. Platforms: web, desktop/macOS, iOS, iPad, Chrome, Safari (Windows implied by shortcuts). Two-week free trial, no credit card.

V2 notes: setup is tightly coupled to encryption; recovery-kit education must be very clear; password loss is catastrophic without the kit, an active session, keychain, or local backups; mobile-first onboarding may need rethinking for parity.

### 5.2 Editor and Notes

The editor supports text, bullets, headings, lists, todos, tasks, backlinks, tags, hyperlinks, templates, images/files, markdown content via deep links, published-note rendering, and AI selection processing. Recommended usage is bullet-heavy daily notes.

V2 notes: the editor must stay fast under heavy keyboard use; backlinks are core, not plugins; tasks and checklists must be distinct in the data model; markdown import/export and deep-link content need robust serialization.

### 5.3 Journaling

`/journal` in a daily note inserts a default, customizable journaling template. Daily templates support habit formation and should be first-class snippets with the full editor feature set.

### 5.4 Backlinks and Graph Organization

`[[Person Name]]` creates or references a note, which then shows incoming backlinks.

V2 notes: creation must be fast; autocomplete should cover contacts, notes, and possibly AI/entity suggestions; case sensitivity and full-name guidance are brittle, so consider aliases, canonical entities, fuzzy merge, and normalization; incoming backlinks are key context; semantics may need to distinguish entities, concepts, dates, projects, and tags.

### 5.5 Tags

Mostly user-authored labels, but some features depend on specific tags. V2 must decide labels vs typed metadata, and make behavior-driving tags (`#person`, `#company`, `#book`) explicit product concepts.

### 5.6 Search

Quick search and advanced search. Filters: created/updated date, daily notes, backlinked to/from notes, tags, pinned. Semantic and fuzzy search find notes without exact text matches (e.g. "meat dishes" finds recipes).

V2 notes: search combines structured, graph, lexical, fuzzy, and semantic search with command execution, and is the primary retrieval UX. E2EE complicated server-side search in V1. V2 is local-first: lexical and semantic search run locally over markdown-derived indexes, with local embeddings.

### 5.7 AI Palette

`cmd j` with or without a selection; pick a built-in prompt (action items, key takeaways, edit, outline, summarize, fix grammar, improve writing) or type a request; save custom prompts. Docs list GPT-4o and Claude 3.5 Sonnet. Selected text goes to external model servers; audio transcription sends raw audio to an external API.

V2 notes: V1 AI is mostly prompt-based; V2 could add agentic workflows (meeting summaries, entity and task extraction, backlink suggestions, memory queries). V2 decisions: BYOK generative AI, local embeddings for semantic search, transparent context, and `private: true` hard blocks for cloud AI. Custom prompts are a power-user primitive worth keeping.

### 5.8 Templates

Reusable slash-menu snippets with the full editor (tags, backlinks, headers, lists), for daily structure, journaling, meetings, and boilerplate. V2 could add variables (dates, contacts, event fields, attendees, projects). Templates bridge unstructured notes and structured workflows.

### 5.9 Web Bookmarking and Highlight Capture

Chrome and Safari extensions (`cmd shift p`, the icon, or right-click) save the link, optional selected text, and a description into the daily note. On iOS, Reflect appears in the share menu and saves highlighted text with the site.

V2 notes:

- Web capture is a searchable, linkable ingestion stream into the daily note.
- V2 shipped the desktop Chrome-extension path (native host/inbox bridge). Full article clipping, Safari, and mobile share targets are deferred.
- The desktop app owns markdown writes, screenshot assets, BYOK AI calls, keychain access, and privacy checks. No hosted link-description API.
- Captures append to today's daily note, with a dedicated note for richer captures. Enrich with metadata, summaries, provenance, backlinks, and deduplication; read-later and article extraction come later.
- `private: true` captures save locally without sending anything to cloud AI.

### 5.10 Publishing Notes

Publish under note actions makes the note public behind a long hard-to-guess URL, copied to the clipboard, with minimal branding; it can be unpublished. Publishing decrypts the note client-side and sends it to Reflect servers to render.

V2 notes: publishing needs explicit user action under E2EE; published artifacts need access-control decisions (secret URL, password, expiry, unlisted, indexed, custom domain) and should be modeled as separate public artifacts.

### 5.11 Calendar and Contacts

Connects Google, iCloud, and Office 365 (Google Calendar, Google Contacts, iCal). Calendar events go into daily notes; Google Contacts sync into the backlink menu. Docs say the data is not shared with third parties.

V2 notes: meetings are a major daily-note use case and contact backlinks are crucial for a personal-CRM memory graph. Permissions should be narrow, explainable, and revocable. Meeting notes could become first-class (attendees, agenda, transcript, tasks, decisions, follow-ups).

### 5.12 Audio Memos

Record on desktop (microphone icon), iPhone/iPad (plus → "Transcribe audio"), or the iOS lock-screen widget. Audio uploads and transcribes in the background, and the transcript lands in the daily note after a few minutes. Users can add helper text for hard words/names in preferences. macOS caches raw recordings in `~/Library/Caches/app.reflect.AudioRecorder/` for recovery if transcription fails. Uses: end-of-day reflection, ideas on the go, assistant-like workflows, article outlines.

V2 notes:

- Audio is a strong mobile wedge. V2 shipped desktop audio memos in the first wave, ahead of the original deferral: raw-first local recordings with async BYOK cloud transcription.
- V2 uses cloud transcription, not local-only, so Mac and mobile share capability and quality. Raw audio is external cloud-processing data, and the product must say so before upload.
- `private: true` blocks cloud transcription and transcript cleanup unless the user changes the setting.
- Transcription should yield structured output (summary, tasks, entities, links, cleaned transcript, retention policy). Formalize local recording recovery.

### 5.13 Integrations

Philosophy: keep the UI simple and gain power through other apps. Integrations: Google Calendar/Contacts, iCal/iCloud, Office 365, Zapier, Readwise, Kindle, Chrome and Safari extensions, iOS share, REST API, deep links. Zapier examples: Trello/Asana tasks, Google Docs, Slack, emails, Tweets, Strava. Readwise examples: bookmarked Tweets, Kindle/Apple Books highlights, podcasts, physical books, Reader.

V2 notes: integrations are ingestion and automation, not extras. Define one pipeline (source → capture artifact → daily/target note → backlinks/entities → search index), and map Zapier, the API, and deep links onto one command/action layer instead of three systems.

### 5.14 Kindle Sync

Books, highlights, and comments import as individual notes tagged `#book`, with authors backlinked. Setup needs the Chrome extension and an Amazon login. Sync runs every five hours, with manual sync. No direct Apple Books support; only US Amazon stores (Amazon limitation).

V2 notes: an opinionated domain importer that could become a typed source/importer framework with source metadata, stable IDs, deduplication, quotes vs comments, and provenance.

### 5.15 API

A REST API appends to notes, lists bookmarked links, and does "a few other things." Note endpoints are append-only because the server cannot read encrypted content. Auth is OAuth 2: credentials from developer settings, user-generated access tokens (like API keys), PKCE for secretless clients, and `Authorization: Bearer YOUR_ACCESS_TOKEN`.

V2 notes: V1's API is append-first automation, not data access. V2 starts with a read/discovery CLI (`reflect search`, `reflect show`, `reflect today`, path lookup); markdown edits are the write path; local servers and broader automation wait until the markdown, sync, and permission model is clearer.

### 5.16 Deep Links

```text
reflect://reflect?command=<command_name>&<parameter1>=<value1>&...
```

Commands: `append-to-daily-note`, `create-task`, `create-note`, `edit-notes`. They append to today's note, create a task (in the task view and today's note), create a blank note, open/edit a note by ID or subject (creating it by subject if missing), pass markdown content, and open two notes side by side.

V2 notes: deep links are an external command API and should share a typed command registry with the palette and the API, to remove duplication across UI, shortcuts, automation, and links.

### 5.17 Import, Export, and Backups

Imports: Apple Notes HTML, Evernote ENEX (no attachments), Markdown, Roam JSON, Workflowy OPML, Mem.ai JSON (beta), Logseq JSON (beta), other Reflect instances. Exports: Reflect JSON, Reflect CSV, Markdown zip, HTML zip. Notes sync to the cloud when online, and Reflect makes daily backups to the user's drive, which help if servers fail or the password is lost.

V2 notes: portability is a value, not a checkbox. V2 gets it from markdown and assets as the source of truth: copying or zipping the graph folder is the export path, with no dedicated import/export suite. V1 exports now use a V2-compatible graph shape, so no V1 importer is needed. Backup and recovery still need a clear architecture across local files, GitHub backup, optional encrypted layers, and conflict recovery.

### 5.18 Security and Encryption

Note contents, images, and files are end-to-end encrypted client-side with XChaCha20-Poly1305. The password is the key and never leaves the machine; the server stores blobs Reflect cannot read. The library is public as `team-reflect/kiss-crypto`. Doyensec audited the design and found it well-architected with sound primitive usage.

Caveats: AI sends selected text to external servers; transcription sends raw audio to an external API; publishing sends decrypted content to Reflect; users must ultimately trust the client, which can be updated; password loss can lock users out permanently without a recovery path.

V2 notes: E2EE constrained every server-side feature in V1. V2 replaces it with explicit trust boundaries: local plaintext markdown, local indexes and embeddings, optional encrypted backup/sync, BYOK or cloud AI processing, `private: true` lockouts, published content, integrations, backups, and API reads/writes. An AI-first V2 must not quietly weaken the privacy model.

### 5.19 Note History

Reflect continually records edits. Users can view changes and restore a revision to a new note, preserving the existing one. History matters for trust; "restore to new note" avoids destructive rollback. It interacts with conflict resolution, local-first storage, checkpoints, and encrypted backup/sync.

### 5.20 Tasks

A Tasks tab aggregates tasks from daily and regular notes for editing, completing, archiving, and scheduling. The docs say note-taking stays the first priority; recurrence and advanced management are left to dedicated task managers.

V2 notes: tasks are a light layer over notes. Either keep them lightweight (aggregation and simplicity), or add recurrence, reminders, priorities, projects, statuses, dependencies, calendar, and external sync carefully.

---

## 6. Data Model Inferences

**Entities:** graph, note, daily note, backlink, tag, task, checklist item, template, bookmark, highlight, calendar event, contact, audio memo, transcript, published note, import/export job, integration connection, API client/OAuth credential, deep link command, revision, attachment.

**Relationships:** notes belong to a graph; a daily note is a note keyed by date; notes link through backlinks and have incoming backlinks and tags; tasks originate in notes but appear globally, while checklist items stay local; bookmarks/highlights and calendar events insert into daily notes; contacts are suggested as backlinks; Kindle imports create tagged notes with author backlinks; published notes derive from decrypted content; revisions belong to notes; import/export is graph-level; API appends write without server read access.

**Pressure points for V2:**

1. **E2EE vs search/AI/API**: the privacy model limits the server.
2. **Graph UX vs entity normalization**: canonical people/companies/projects may need aliases and merging.
3. **Daily note as universal inbox**: powerful, but clutters without extraction and resurfacing.
4. **Tasks as note-native objects**: completion, scheduling, archiving, and source preservation need clear semantics.
5. **Capture surfaces**: browser, mobile, audio, calendar, API, and integrations need one ingestion path.
6. **Publishing** sits outside the private encrypted model.
7. **Sync and history**: offline edits, encryption, history, and conflicts are central complexity.

---

## 7. Typical V1 Workflows

- **Daily capture**: open today's note, add bullets, meetings, tasks, and links, `[[`-link entities, tag categories, recall later via search or backlinks.
- **Meeting**: a calendar event appears near the daily note and is inserted; attendees autocomplete as contact backlinks; the AI palette extracts action items; tasks aggregate in the Tasks tab.
- **Web research**: the extension appends a link/highlight to the daily note; the user backlinks topics.
- **Books**: Kindle or Readwise imports highlights into `#book` notes with author backlinks.
- **Audio**: record, upload, transcribe into the daily note, optionally summarize with AI.
- **Automation**: the API, Zapier, or a deep link appends to the daily note or creates notes/tasks.

---

## 8. V2 Design Recommendations

- **Preserve the core identity.** Not a generic Notion, Linear, or Apple Notes: fast personal capture, a daily-note timeline, associative backlinks, minimal UI, search as recall, and a trusted, user-owned knowledge graph.
- **Make ingestion a first-class pipeline.** V1 ingestion is spread across the editor, extensions, iOS share, audio, calendar, contacts, Kindle, Readwise, Zapier, the API, and deep links. Define one pipeline:

  ```text
  source → raw capture → normalized object → daily note insertion / target note → entity extraction → backlinks/tags/tasks → search index → history/sync
  ```

- **Unify commands across UI, API, and deep links.** V1 commands live in `cmd k`, the slash menu, deep links, the API, the extension, task creation, and the AI palette. A typed registry entry would carry: id, argument schema, permissions, availability, shortcut, UI action, API/deep-link mapping, undo/history behavior, and sync semantics.
- **Treat privacy as architecture, not marketing.** In V1, E2EE touched search, semantic search, AI, the API, publishing, integrations, backups, recovery, sync, enrichment, and transcription. V2 is local-first and AI-native, not E2EE-first, but must still separate local plaintext operations, optional encrypted backup/sync, external AI/transcription, published content, integration data, local indexes, and cloud indexes.
- **Revisit the entity model.** Users create entities (person, company, project, book, location, meeting, idea, topic, date) through note-to-note links. Optional typing could stay light: `[[Alice]]` stays simple, Reflect suggests a type, aliases and canonicalization fix case and abbreviation problems, and merge/split handles messy usage.
- **Upgrade AI from text transform to memory agent**: questions over notes, summaries of a person/project from backlinks, task extraction, backlink and tag suggestions, daily/weekly reviews, transcript cleanup, structuring raw captures, duplicate detection, follow-up drafts, outlines from scattered notes. All of it must fit V2's privacy model: local ownership, `private: true` locks, transparent context.
- **Keep tasks lightweight unless there is a clear strategy.** Option A: aggregate, schedule, complete/archive, keep note context, AI extraction. Option B: a serious system with recurrence, reminders, priorities, projects, statuses, dependencies, and integrations. The worst path is half-building a complex task manager and losing the note-taking simplicity.
- **Preserve portability through markdown**, not a parallel import/export area: plain Markdown files (Reflect-created dailies in `daily/`, regular notes in `notes/`, adopted vault notes at the root or in visible nested folders); attachments as normal files in `assets/` with relative links; backlinks, tags, tasks, and dates readable in markdown; `.reflect/` outside the portability contract except documented durable tables such as `chat_*`; users copy or zip the folder; V1 migration relies on the V1 exporter producing a V2-compatible graph.
- **Make mobile capture excellent.** Audio memos, iOS share, the lock-screen widget, and daily capture are already strong. Mobile should be a first-class capture product, not only a viewer.

---

## 9. Open Questions for V2

### Resolved Direction

- **V1 graph compatibility**: V1 exports produce a V2-compatible graph shape. No generalized Obsidian/folder import surface unless the portability premise changes.
- **Data model**: note-first, with readable markdown files, stable IDs, aliases, and case-insensitive backlink resolution.
- **Entities**: no typed entity layer in the first wave; canonical entities can emerge later as projections over notes and aliases.
- **AI model**: BYOK/cloud generative AI first; local generative models later; local embeddings separate from generative AI.
- **API and automation**: read/discovery CLI first; markdown edits are the write path; no Reflect-hosted APIs for the core.
- **Tasks**: deferred from the first release; now planned as a post-release add-on (Plan 18) as lightweight markdown-backed projections (GFM checkboxes + a `tasks` table + a Tasks view), not a full task system.
- **Contacts and calendar**: deferred as first-wave surfaces, kept as future memory context for meetings, backlinks, dailies, and AI.
- **Daily AI automation**: opt-in background extraction into reviewable suggestions only. Never silently mutate notes with summaries, entities, backlinks, or tasks.
- **Links**: basic Chrome capture shipped (Plan 11: URL/title/selection/screenshot via the native host/inbox bridge; desktop owns BYOK AI and writes; no hosted link-description API). Safari, mobile share, and article clipping remain later work.
- **Audio**: **shipped in the first release** (ahead of the original deferral): raw-first memos with async BYOK cloud transcription, explicit privacy UX, and `private: true` lockouts.
- **Publishing and templates**: deferred; they must not block the editor, storage, search, sync, and AI foundation.

### Remaining Open Questions

1. What is the exact V1 migration path, and how much conversion fidelity is required?
2. What is the exact alias/frontmatter schema, and how should case-insensitive title or alias collisions be resolved?
3. What source-provenance schema should web, book, and audio captures use?
4. What template variable model should V2 use when templates return?
5. Which opt-in AI background extractions are safe enough to ship, and what review UI do they require?
6. How should sync, conflict resolution, and note history evolve beyond the GitHub-first adapter?

---

## 10. Source Map

The main Notion pages browsed and summarized:

- Reflect Academy — `https://app.notion.com/p/1a9f144d807f48cb881659dcb6ec4122`
- Getting started with Reflect — `https://app.notion.com/p/794d18568c3b49e69316c6c02d6880ce`
- How to use Reflect — `https://app.notion.com/p/0d71231504634ff9add4f08c0bc75764`
- Using backlinks and tags — `https://app.notion.com/p/f066808e9f984295ae62923f20d5be64`
- Keyboard shortcuts — `https://app.notion.com/p/2029970fc8da44e49e1dfdaea42eddab`
- Split pane view — `https://app.notion.com/p/e8f4d8e854484127bf6e00522eba8cfe`
- Security and encryption — `https://app.notion.com/p/89450e351e724893b72898d9acc663fe`
- Note history — `https://app.notion.com/p/7e2ab43ad4474188858125fb03800d7d`
- Import, export, backups — `https://app.notion.com/p/ceb44e87b9ad4124915726c6869e45aa`
- Advanced Search — `https://app.notion.com/p/a19a9bfd005b40ecb5302d24e674c48f`
- Artificial Intelligence — `https://app.notion.com/p/af251514e9e14244ad64eca86c7211f7`
- Using templates — `https://app.notion.com/p/5858bf5a80ca4ba89ba22c7e29553228`
- Bookmarking websites — `https://app.notion.com/p/b87b759b644d4a2988c0563910167577`
- Publishing notes — `https://app.notion.com/p/54036ac72e0e4113a1e292a914d2cc10`
- Calendar and contacts — `https://app.notion.com/p/b60006ecd1ad4ee8b60855a40c8a9f24`
- Audio memos — `https://app.notion.com/p/bc4d3a87c2af4d77aaf152c851999981`
- Integrations — `https://app.notion.com/p/2ae49a86ba5d4ddb93fbfae4bfbeea37`
- Kindle sync — `https://app.notion.com/p/ddb5feaa90b441d58b637cdfe0ee66e4`
- API — `https://app.notion.com/p/49686f8195fa423f8ba42721914b3672`
- Tasks — `https://app.notion.com/p/5ccdd956e82b4372b1bd5c82d4777ceb`
- Reflect Tasks Beta — `https://app.notion.com/p/feb4413a201a41599826aff40468e916`
- Deep links — `https://app.notion.com/p/0fe21ab7b08580c88c1bfb1e3a7400be`
- Roadmap — `https://app.notion.com/p/3f958dc8917e40e698af2898bead7104`

---

## 11. Bottom Line for the V2 Agent

> An end-to-end encrypted personal memory graph centered on daily notes, backlinks, fast capture, and recall, extended through AI, search, integrations, audio transcription, publishing, tasks, and import/export.

V2 should not start from a generic notes-app architecture, but from what makes Reflect distinct: daily notes as time-based memory, backlinks as associative memory, a minimal keyboard-first interface, trusted local-first user-owned data, search as the retrieval layer, capture from everywhere, AI as an assistant over personal context, and markdown-folder portability.

The highest-leverage V2 work is architectural, not cosmetic: unified ingestion, typed commands, better entity/backlink semantics, privacy-preserving AI/search, robust sync/history, and a markdown graph that is easy to copy, inspect, and recover.
