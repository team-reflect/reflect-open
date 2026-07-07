# Reflect V1 Overview

This document is a handoff for an agent or engineer building a second version of Reflect. It summarizes what the existing app does, what product concepts it is built around, and which architectural choices shaped the V1 implementation.

For deeper implementation notes, see:

- [Mobile app](./reflect-v1-mobile-overview.md)
- [Search](./search.md)
- [Note sync](./note-sync.md)
- [SQLite persistence](./sqlite-persistence.md)
- [Mobile audio memos](./reflect-v1-mobile-audio-memos.md)

## Product Summary

Reflect V1 is a local-first, graph-based note-taking app. Its core idea is that users capture most of life into daily notes, then use backlinks, tags, search, tasks, calendar context, and AI to turn that stream into a connected personal knowledge graph.

The product has three strong centers of gravity:

1. **Daily capture**: the daily note is the default place to write journals, meeting notes, tasks, bookmarks, voice notes, and stray thoughts.
2. **Associative organization**: backlinks replace folders as the primary organizing system. Notes form a graph of concepts, people, companies, meetings, and ideas.
3. **Fast recall**: the app invests heavily in keyboard shortcuts, local search, semantic search, AI chat over search results, note history, and local persistence.

Reflect V1 runs as a Next.js web app, a desktop app integration, and a Capacitor-based mobile/tablet experience. It uses Firebase/Firestore as the remote backend and local SQLite as the client-side source for fast reads, offline use, indexing, and sync.

## How to Think About V1

Reflect V1 is best understood as four loops running on top of the same note graph:

1. **Capture loop**: daily note, editor, voice memo, browser extension, mobile share/deep links, meeting import, Readwise/book imports.
2. **Structuring loop**: backlinks, aliases, tags, tasks, note templates, prompt templates, duplicate-note merge, suggested backlinks, suggested contacts.
3. **Recall loop**: note list, search, semantic search, command palette, graph map, similar notes, AI chat, note history.
4. **Reliability loop**: local SQLite, Yjs commits, pending commits, Firestore sync, local store persistence, backups, export, encryption unlock, migration/version gates.

Most V1 features are not isolated. A captured link can become a note, create backlinks, be indexed into FTS/vector search, appear in map, contribute to AI answers, and be exported. A task is text inside a note, but it also becomes a task item in the user's mental model through derived parsing. A daily note is a normal note with special date semantics, but it drives navigation, scheduling, calendar context, audio insertion, and onboarding.

For V2, keep this shape in mind: the product's power comes from treating notes as the substrate, then deriving multiple useful views from them.

## Core User Model

Reflect is organized around **graphs**. A graph is a user-owned workspace with notes, tags, backlinks, assets, books, templates, backups, and feature flags. Users can have multiple graphs and switch between them from the account menu.

Important domain objects:

- **User**: authentication, billing state, preferences, AI provider settings, transcription preferences, and account-level data.
- **Graph**: a named, encrypted workspace with ACLs, versioning, tags, and per-graph stores.
- **Note**: rich-text document with subject, body, backlinks, tags, tasks, assets, public sharing state, history, sync metadata, and optional daily date.
- **Daily note**: a note tied to a date. The app opens here by default and supports infinite scrolling through past/future days.
- **Backlink**: a typed connection from one note to another, generated from editor links.
- **Task**: a task embedded in note content and collected in the Tasks view.
- **Credential**: a connected Google, Microsoft, or Apple account used for contacts and calendars.
- **Asset**: uploaded files/images/documents whose text can be extracted and indexed.

### Graph as Boundary

The graph is the main product, security, sync, and UI boundary:

- Graph ID scopes local SQLite tables such as notes, backlinks, assets, books, and vector rows.
- Graph ACLs decide owner/read/write/public access.
- Graph encryption key gates access to content.
- Graph version controls migration and client compatibility.
- Graph flags enable debug or experimental behavior.
- Graph stores are instantiated per graph, even when backed by shared SQLite tables.

This means a V2 rewrite should decide early whether "graph" remains the top-level user workspace or is renamed/simplified. Removing it later would touch routing, sync, storage, sharing, backups, and UX.

## Main App Surfaces

### Daily Notes

Daily notes are the primary writing flow. The UI presents a virtualized stream of date-based notes that extends backward and forward. New users are guided to put journals, meeting notes, bookmarks, and tasks in today's daily note.

Key behaviors:

- Today is the default selected note.
- Users can navigate to relative dates from search, commands, and backlinks.
- Daily notes support the same rich editor as regular notes.
- Voice recordings are inserted into daily notes after transcription.
- Calendar context can appear on daily notes when credentials are connected.

Daily notes also act as the product's "inbox." Browser captures, audio transcripts, meetings, and quick task creation all gravitate back to the daily note. Future dates are valid destinations, so daily notes double as lightweight scheduling.

### All Notes

The All Notes view is a dense table-style list with subject, snippet, tags, and updated date. It supports keyboard navigation, multi-selection, filtering by query/tag, new-note creation, and trash/delete flows.

This view works as both a library and a filtered result view. For example, clicking a tag opens All Notes with a tag query.

The list is backed by virtualized placeholder rows from the local model pool. This lets the app show large graphs without hydrating every note model at once. The tradeoff is complexity around placeholder loading, scroll restoration, and keeping derived fields current.

### Note Editor

The editor is built on `@team-reflect/reflect-editor` and ProseMirror/Yjs document state. It is the core interaction surface of the app.

Important editor capabilities:

- Rich text, bullets, nested lists, collapsible list items, code blocks, formatting, highlights, underline, strikethrough, links, and images.
- Backlink creation with `[[...]]`, backlink opening, backlink hover previews, and selected-text backlinking.
- Tags and tag clicks.
- Tasks embedded directly in notes.
- Note merge suggestions for duplicate subjects.
- Templates, including slash-style workflows such as journal templates.
- File upload/download/save handlers.
- Link metadata lookup.
- Image preview.
- Incoming backlinks below notes.
- AI palette actions via prompt templates.
- Real-time transcription support when enabled.
- Print support.
- Primary and secondary editor panes for split-note workflows.

The editor tries to preserve a high-speed writing feel. Most app navigation has keyboard shortcuts, focus restoration, and scroll/cursor persistence.

The editor integration is also where many product systems meet:

- `NoteEditMain` wires note state, Yjs updates, editor focus, keyboard toolbar state, templates, prediction, file handlers, backlinks, tags, transcription, previews, and printing.
- `useNoteDocumentView` mediates the editable document, offline state, incoming updates, and editor keying.
- The note model owns document transforms for adding contacts, meetings, tasks, backlinks, and imported content.
- Selection and focus state live outside the editor so routing, split panes, and command palette interactions can restore the user's cursor.

V2 should treat the editor boundary as a first-class architecture decision. If the editor remains rich and collaborative, it needs clear ownership for document state, derived metadata, and side effects.

### Note Context Sidebar

The right sidebar surfaces context and actions for the selected note:

- Pin or unpin a note.
- Move to trash, permanently delete, or restore.
- Publish or unpublish a shareable private link.
- Copy the current note link.
- Show note history.
- See public URL details.
- Suggested contact linking.
- Book metadata.
- Meeting context.
- Suggested backlinks.
- Similar notes.
- Daily-note calendar context.

This is an important V1 pattern: the editor stays relatively clean while secondary intelligence and actions live in the context sidebar.

The sidebar intelligence is mostly local and opportunistic:

- Suggested backlinks search for aliases of the current note's subject, then propose backlinks from matching notes that mention those aliases.
- Similar notes run semantic search against the note subject and first-line content.
- Suggested contacts look up connected contacts when a note subject resembles a contact name and the note does not already contain contact data.
- Events appear for daily notes when credentials are connected, and adding a meeting mutates the daily note content.

This gives V1 a "quiet assistant" feel without requiring all intelligence to be generated by an LLM.

### Search and AI Chat

Search opens from `Cmd/Ctrl+K`. V1 search is both a command palette and a note retrieval system.

Search supports:

- Keyword/full-text search over note subjects, note text, and extracted asset text.
- Semantic/vector search over local note chunks.
- Exact/fuzzy/semantic strategies.
- Filters such as tags, dates, booleans, and linked-note/backlink conditions.
- Basic navigation commands such as daily note, relative dates, and random note.
- Preview snippets and note opening.
- AI chat over the current search result set.

The local search stack uses SQLite FTS and vector tables where supported. AI chat sends the chosen search context to the configured AI provider and returns cited answers.

Search has three jobs in V1:

- **Find**: locate notes by title/body/asset text.
- **Navigate**: jump to daily notes, relative dates, random notes, and filtered note lists.
- **Reason**: chat over the current result set with citations.

The search modal can toggle between results and chat with `Cmd+J`. This means the AI chat is not a global chatbot in V1. It is intentionally grounded in an explicit retrieval set chosen by the user.

Important implementation details:

- Text search uses local SQLite FTS tables for notes and assets.
- Semantic search uses locally stored note chunks and embeddings where sqlite-vec support is available.
- Search filters are represented as UI badges and transformed into query constraints.
- Asset text is indexed separately and mapped back to parent notes.
- AI answers are server-side completions over selected result context, subject to provider/quota logic.

### Tasks

Tasks are not a separate database-first object in the product experience. They are embedded in notes and then collected into the Tasks tab.

User-facing behavior:

- A task can be created in any note.
- Tasks appear with circular check controls.
- Plain checkboxes are intentionally distinct from tasks.
- The Tasks tab groups, filters, schedules, edits, and completes tasks.
- Deep links can create tasks and append them to the daily note context.

This gives tasks local context while still supporting a centralized task workflow.

Under the hood, each `Task` wraps a task node in a note document. The task ID is the ProseMirror node GUID. Editing a task in the Tasks view updates a pending inline task document, then syncs it back into the source note. Scheduling a task is implemented by adding or updating a backlink to a daily note inside the task content.

Task groups are derived from note/task state:

- **Current**: scheduled for today or attached to today's daily context.
- **Overdue**: scheduled before today.
- **Upcoming**: scheduled in the future.
- **Other**: unscheduled and not pinned.
- **Pinned**: task belongs to a pinned note.
- **Archived**: checked tasks that have been hidden.

The code comments note a V1 limitation: the Tasks view loads all notes that have tasks into the pool. That is a strong signal for V2 to design a task index or projection explicitly if tasks remain a central surface.

### Map

The Map tab visualizes the note graph. It generates a graph from notes/backlinks and renders it with `@team-reflect/pixi-graph`, `graphology`, and layout helpers.

Behavior:

- Nodes represent notes.
- Edges represent relationships/backlinks.
- Hovering a node shows a note preview.
- Clicking a node opens the note.
- Filters can narrow the graph.

The map is a product expression of Reflect's "association instead of hierarchy" philosophy.

The map appears visually separate, but it depends on the same backlink and note-derived indexes as search and sidebar intelligence. If V2 changes backlink semantics, the map, suggested backlinks, incoming backlinks, similar notes, and note previews should be reviewed together.

## Navigation and App State

V1 has a custom route-state layer over Next.js routes. `RouterView` derives paths from the MobX root state and can also apply incoming route state back into stores.

Examples:

- `/g/:graphId/:noteId` opens a note or daily note.
- `/g/:graphId/list/:query` opens All Notes with a query.
- `/g/:graphId/map` opens the graph map.
- `/g/:graphId/tasks` opens tasks.
- `/preferences/:preferenceScreen` opens preferences.

The browser history stack is integrated with app state, and `Cmd+[`, `Cmd+]` behave like browser back/forward. Deep links can append text to daily notes, create tasks, create notes, or open split-note editing contexts.

The loading gate is also state-driven:

1. Auth required.
2. SQLite migrating or migration failed.
3. Graph setup required.
4. Graph/user loading.
5. Encryption setup required.
6. Graph version unsupported.
7. Main app ready.

For V2, route state should be designed alongside the data model. V1's routes are useful because they are product routes, not just page names.

## Capture and Import Workflows

### Audio Notes

The app can record voice notes from desktop/web/mobile, upload them, transcribe them, and insert the result into a daily note.

The V1 flow is:

1. User starts recording from the sidebar microphone or shortcut.
2. Browser or native recording APIs capture audio.
3. The recording is cached locally to avoid data loss.
4. The uploader creates Firestore metadata and uploads the audio blob.
5. Backend transcription processes the file.
6. The transcript is synced into the associated daily note.

Preferences include transcription language, formatting, and prompt hints for names or terminology.

Audio has two modes in the broader product:

- **Recorded memo**: explicit microphone recording, cached locally, uploaded, transcribed, and inserted into the daily note.
- **Live transcription**: editor-level `Transcriber` integration when real-time transcription is enabled for the graph.

Both modes reinforce daily capture, but they touch different parts of the stack. V2 should decide whether transcription is an editor primitive, an import primitive, or both.

### Browser Extensions and Links

Reflect supports web capture through extension OAuth routes and link APIs. Link notes can include metadata and optional AI-generated summaries. The public seed docs encourage users to install Chrome and Safari extensions for bookmarks and highlights.

Link capture is backed by server helpers and client operations. Operations are Firestore-backed work items that the client listens for and applies locally, with locking, retries, failure counts, and bad-operation cleanup. Existing handlers include link creation, list append, Readwise sync, and book sync.

This gives V1 a pattern for asynchronous server/client cooperation: the server can enqueue work for a graph, and the client eventually applies it to the encrypted/local note graph.

### Imports and Exports

Graph settings include import, export, backups, graph editing, and deletion.

Supported exports:

- Reflect JSON.
- CSV.
- Markdown ZIP.
- HTML ZIP.

Supported imports:

- Reflect JSON.
- Third-party formats exposed by `@team-reflect/reflect-import`, such as note exports from other tools.

Automated daily graph backups are visible in graph preferences.

Import goes through a prepare/import modal flow with states for pending, preparing, prepared, importing, imported, graph error, and preparing error. Export is intentionally user-facing and portable, which matters because the app stores rich encrypted content locally and remotely.

For V2, export should not be treated as an afterthought. It is part of the trust model.

## AI Feature Surface

AI is not a single product feature in V1. It appears in several places:

- **AI palette editor**: prompt templates applied to selected editor text through `Cmd+J`.
- **System prompt templates**: built-in operations like continue writing, summarize, fix grammar, rephrase, simplify, copy edit, generate titles, write tweets, outline, action items, and meeting-note cleanup.
- **Custom prompt templates**: user-created templates stored per user/graph context and managed in Preferences.
- **Search chat**: chat over current search results with cited answers.
- **Link summaries**: optional AI-generated summaries for saved links.
- **Transcription cleanup**: audio transcript formatting and prompt hints.
- **Provider abstraction**: server-side provider selection for Anthropic, OpenAI, and Google.
- **Quota enforcement**: free/paid/custom-key quota checks for predictions.

The V1 UX splits these into editor commands, search chat, background enrichments, and preferences. A V2 agent should decide whether the user should experience these as separate tools or as one assistant layer with multiple entry points.

## Integrations

Reflect V1 integrates with:

- **Google**: OAuth, contacts, calendars.
- **Microsoft/Office 365**: OAuth, contacts, calendars.
- **Apple/iCloud**: credential flow and calendar/contact support.
- **Stripe**: checkout, portal, subscription state, and webhooks.
- **AI providers**: Anthropic, OpenAI, and Google Gemini via server helper abstractions.
- **Transcription providers**: server transcription helpers plus client live transcription.
- **Firebase**: auth, Firestore, storage, rules-based tests, and local emulator support in CI/test flows.
- **Sentry** and analytics/logging services for production diagnostics.

Connections are managed from Preferences > Connections. Calendar and contact data feed note context, meeting notes, suggested contacts, and meeting imports.

Calendar/contact integrations are not merely settings. They shape note content:

- Contacts can become suggested note context.
- Meetings can be imported into daily notes.
- Meeting attendees can become backlinks or contact notes.
- Daily notes can act as the natural home for a day's events.

Readwise/book-like import flows are similar: external structured data becomes notes and backlinks rather than living in a separate integration silo.

## Preferences and Account Settings

Preferences are a full-screen split view with personal settings and graph settings.

Personal settings:

- Profile.
- Connections.
- Note templates.
- Prompt templates.
- Billing.

Graph settings:

- Rename/color/edit graph.
- Import notes.
- Export notes.
- View backups.
- Delete graph.
- Create/switch graphs.

The account menu also exposes graph switching, Preferences, Billing, and Sign out.

Preferences also persist a meaningful amount of app behavior: theme, editor sizing, date/time format, spellcheck, keyboard layout map, AI provider/custom keys, transcription settings, graph selection, and UI sizes. Some of this state lives in Firestore-backed user preferences, and some lives in local MobX snapshot persistence.

## Authentication, Billing, and Access

V1 includes:

- Email authentication and OAuth callback routes.
- OTP/password-related auth helpers.
- Graph ACLs for owner/read/write/public access.
- Trial and subscription state.
- Paid-only features such as note publishing.
- Stripe checkout and customer portal flows.
- Admin tools for users, graph flags, user flags, trials, reset, copy graph, rename graph, change email, and disabling users.

The app distinguishes trialing, paying, and out-of-standing users and can make the editor read-only when a user is not in good standing.

Authentication and graph loading are intertwined. The user can be authenticated but still blocked by graph setup, graph encryption, unsupported graph version, or subscription standing. Note publishing is paid-gated, while local writing requires the user to be in good standing.

V2 should model these gates explicitly as product states, because they are not just technical loading states. They are user-facing moments where trust can be won or lost.

## Data, Sync, and Offline Model

Reflect V1 is local-first on the client:

- MobX Keystone models manage app state.
- SQLite stores notes, backlinks, contacts, books, assets, FTS indexes, vector indexes, commit backups, sync cursors, and job queue state.
- Kysely provides typed SQL access.
- Firestore is the canonical remote backend.
- Metadata sync uses table-level sync abstractions.
- Rich note content sync uses Yjs updates committed through a commit/change manager.
- Local changes can be queued while offline and synced later.
- Service worker caching and native platform helpers support offline-friendly behavior.

The note model stores both the ProseMirror document JSON and Yjs update state. Derived fields such as document text, tags, emails, link hrefs, backlink IDs, daily date, task presence, aliases, and content metadata are indexed locally for fast UI and search.

Encryption matters in V1. Graphs are treated as encrypted, and users must provide the graph encryption password/key before the app can load note content. Passwords are presented as local encryption credentials and should not leave the machine.

### Sync Layers

V1 has several distinct sync/persistence layers:

- **Remote graph/user snapshots**: Firestore listeners keep graph, tags, user, credentials, templates, and similar metadata current.
- **SQLite table sync down**: Firestore documents are converted into local SQLite rows.
- **SQLite table sync up**: local metadata changes are debounced and uploaded to Firestore.
- **Yjs content commits**: rich note body changes are saved as Yjs update commits and applied by `ChangeManager`.
- **Pending commits**: local unsaved content changes live in `ChangeStore` and persist across reloads/unload.
- **Derived indexes**: backlinks, FTS rows, vector rows, task flags, asset text, and note metadata are recalculated from note content.
- **Local MobX persistence**: preferences, current user/graph shell, credentials, UI state, task filters, map filters, and change-store snapshots persist to platform storage.
- **Background uploads/reloads**: online state triggers background upload/reload behavior and app update notification.

The important V1 lesson is that "sync" is not one mechanism. V2 should name each layer and its consistency guarantees.

### Local SQLite Tables

The local SQLite schema is a projection of the user's workspace:

- `notes`: canonical local note rows and derived note metadata.
- `noteBacklinks`: backlinks derived from note documents.
- `contacts`: synced contact data.
- `books`: book/highlight-style data.
- `assets`: uploaded/extracted files and text.
- `assetsFts`: searchable asset text.
- `notesFts`: searchable note subjects and document text.
- `notesVec`: vector chunks and embeddings for semantic search.
- `commitBackups`: local/remote commit backup data.
- `lastSyncs`: per-table sync cursors.
- `jobs`: local job queue state.

This is why the app can feel fast: many product views are reads against local projections, not remote API calls.

### Derived Note Fields

A note row is more than a saved document. V1 derives and stores:

- Plain text for search.
- Tags.
- Email addresses and phone numbers.
- Link hrefs and domains.
- Backlink target IDs.
- Daily date.
- Task presence.
- Blank/oversize status.
- Normalized subject.
- Subject aliases split by `//`.
- Content metadata such as book ASIN.

These fields power search, filters, suggested contacts, link/book metadata, tasks, map, note list, and sidebar context. In V2, if note documents are the source of truth, plan the projection pipeline from day one.

### Backlinks and Aliases

Backlinks are both explicit editor nodes and derived rows. The backlink store observes note changes and pending commits, extracts expected backlinks from documents, and updates `noteBacklinks` transactionally.

Subject aliases use `//` inside note titles. For example, `Charlotte MacCaw // Mum` lets either alias match or be suggested. This small convention matters because it makes backlinks work for people, nicknames, companies, and alternate names without a separate alias UI.

Suggested backlinks build on this: aliases from the destination note become search queries, matching notes are scanned for unlinked mentions, and the user can add suggested incoming backlinks.

### History and Recovery

V1 stores every content change as commits, exposes note history from the context sidebar, tracks commit backups, supports automated graph backups, and has debug/recovery screens for problematic Yjs or note states. This reflects a real product need: personal notes are high-trust data, and users expect recovery paths.

## Backend and API Surface

Next.js `pages/api` routes proxy into `server/` modules. Major backend areas include:

- Auth client token and OTP flows.
- Graph creation, listing, suggestion, deletion, and setup.
- Note CRUD and daily note updates.
- Backlink listing.
- Link creation/deletion/listing and async link enrichment.
- Book and Readwise-style highlight sync.
- Credential auth and revocation.
- Meeting listing and calendar helpers.
- Prediction/AI completion.
- Search answer generation.
- Transcription creation.
- Stripe checkout, portal, and webhooks.
- Newsletter endpoints.
- OAuth client and token flows for developer access.
- Admin tools.

Shared request/response schemas live in `shared/` where possible. New V2 APIs should preserve the idea of keeping transport contracts lightweight and explicit.

The backend is mostly a collection of narrow route handlers and helpers rather than one monolithic API server. The client still performs substantial local work. That split is important:

- Server handles auth-sensitive operations, provider secrets, billing, OAuth, AI completions, transcriptions, public downloads, and admin work.
- Client handles local note editing, local sync, indexes, backlinks, tasks, and encrypted content projections.
- Firestore mediates many real-time and background flows.

If V2 changes encryption or local-first assumptions, the client/server responsibility split will change dramatically.

## Platform Support

V1 targets several environments:

- Web app on Next.js/Vercel.
- Desktop app behavior through Electron-style helpers and renderer RPC.
- Mobile/tablet via Capacitor.
- Browser extensions via OAuth/callback routes.

Platform-specific behaviors include keyboard shortcuts, native recording streams, native file handling, iPad keyboard toolbar behavior, app-region dragging, and desktop navigation shortcuts.

The platform abstraction is not cosmetic. It affects:

- Recording stream choice.
- SQLite implementation and capabilities.
- Keyboard shortcuts and OS-reserved shortcuts.
- Electron renderer RPC and native app commands.
- File upload/download/save behavior.
- Mobile keyboard toolbar and safe-area layout.
- Offline/cache behavior.

V2 should decide whether it is one app across platforms or several platform-specific shells around a shared model.

## Notable Product Principles

These principles are visible in both the product and code:

- **Daily notes first**: users should not need to decide where everything goes.
- **Association over hierarchy**: backlinks, aliases, and graph view are core, folders are absent.
- **Local speed**: SQLite, FTS, vector search, virtualization, and local caches keep common interactions fast.
- **Offline resilience**: notes should remain writable and searchable even with poor connectivity.
- **Keyboard-native UX**: command palette, shortcuts, focus restoration, and editor commands are central.
- **Contextual intelligence**: AI, suggested backlinks, similar notes, contacts, meetings, and search chat augment notes without replacing the editor.
- **User-owned archives**: import/export/backups are first-class graph settings.
- **Encrypted personal data**: graph encryption is a core constraint, not a later add-on.

## Common User Journeys

### First-Week User Journey

1. Sign up and create/unlock a graph.
2. Land in today's daily note.
3. Read seeded onboarding notes such as "How to use Reflect."
4. Connect calendar/contacts.
5. Install desktop/mobile/browser extension.
6. Import old notes.
7. Start using daily notes, backlinks, tasks, search, and audio transcription.

### Daily Capture Journey

1. Open app into today's daily note.
2. Type bullets, journal entries, meeting notes, links, and tasks.
3. Add backlinks inline as concepts/people appear.
4. Record voice memo if typing is too slow.
5. Use AI palette to clean up or structure raw notes.
6. Search or link out to older notes as memory surfaces.

### Recall Journey

1. Open search with `Cmd/Ctrl+K`.
2. Search by keywords, fuzzy title, tag, date, or semantic meaning.
3. Preview and open notes.
4. Switch to AI chat if the question needs synthesis.
5. Open similar notes or map for associative browsing.

### Meeting Journey

1. Connect calendar credentials.
2. Open today's daily note.
3. See events in note context.
4. Add a meeting to the note, optionally backlinking attendees or the meeting.
5. Use AI prompt templates to format notes or extract action items.
6. Tasks appear in the Tasks tab while retaining note context.

### Maintenance Journey

1. Use Preferences to adjust profile, theme, editor, templates, AI, and billing.
2. Manage graph import/export/backups.
3. Review note history if content needs recovery.
4. Export notes for portability or backup.

## V2 Design Notes

Things likely worth preserving:

- Daily notes as the default capture surface.
- Backlinks as the core organization primitive.
- Fast local search with keyword and semantic modes.
- AI palette and AI chat as accelerators over user-owned notes.
- Tasks embedded in notes but collected into a task view.
- Graph-level import/export/backups.
- Context sidebar for secondary note intelligence.
- Keyboard-first workflows.
- Offline/local-first behavior.
- Document-derived projections that make many views feel unified.
- Routeable app states for notes, lists, tasks, map, and preferences.
- Explicit export/backup/recovery affordances.

Things worth reconsidering for V2:

- The current app spans web, desktop, mobile, extensions, Firebase, SQLite, Yjs, search, AI, billing, and admin in one repo. A V2 could define cleaner product and service boundaries early.
- The split between ProseMirror JSON, Yjs state, commits, metadata sync, derived fields, FTS, and vector indexes is powerful but complex. A V2 agent should treat sync architecture as a first-order design problem.
- AI capabilities evolved around prompt templates, search chat, summaries, and transcription. V2 can make these feel like one coherent assistant layer instead of separate features.
- The graph model is central, but the user-facing distinction between graph, note, daily note, tag, backlink, task, and meeting can be simplified.
- Many powerful features are hidden behind keyboard commands or sidebars. V2 should decide deliberately what remains power-user only and what deserves visible affordances.
- Billing, auth, encryption recovery, and graph setup are deeply intertwined with app loading. V2 should make onboarding and recovery flows explicit and testable.
- Tasks are powerful because they live inside notes, but expensive because the task list is a derived projection. V2 should choose between embedded tasks, independent task records, or a hybrid projection with clear sync rules.
- Search is doing command palette, retrieval, filtering, and AI grounding. V2 may want separate mental models while sharing one index.
- Sidebar intelligence is valuable but scattered. V2 could define a single "note context engine" that owns suggestions, similar notes, contacts, meetings, and backlinks.
- The current public/private link publishing model is paid-gated and note-level. V2 should revisit whether sharing is per note, per graph, per collection, or temporary.
- Graph encryption, public sharing, AI processing, and search indexing can pull in different directions. V2 should define privacy boundaries before implementing feature surfaces.

Questions a V2 agent should answer before building:

- What is the source of truth for note content: CRDT updates, structured JSON, markdown, or something else?
- Which projections must be local, durable, and queryable offline?
- Which projections can be rebuilt, and which must sync?
- Are tasks first-class records, note nodes, or both?
- Is the assistant centered on selected text, search results, current note, daily note, or graph-wide context?
- Does encryption happen before or after indexing, AI, sharing, and backup?
- What does a graph mean to a non-power user?
- Which workflows must work offline on day one?
- What is the recovery story if sync, encryption, or editor state breaks?
- Which features need to exist in V2 immediately versus migrate later?

## Code Map for V2 Readers

Useful starting points:

- `client/screens/main/notes-sidebar/notes-sidebar.tsx`: primary app navigation.
- `client/screens/main/main-tabgroup.tsx`: main screen selection.
- `client/screens/main/note-edit/note-edit-main.tsx`: editor integration.
- `client/screens/main/notes-daily/`: daily notes UI.
- `client/screens/main/notes-list/`: all-notes table UI.
- `client/screens/main/notes-search/`: search modal and AI chat.
- `client/screens/main/tasks/`: task list experience.
- `client/screens/main/notes-map/`: graph visualization.
- `components/note-context-sidebar/`: right sidebar note context.
- `client/models/store/root-store.ts`: top-level client state.
- `client/models/graph/graph.ts`: graph-level stores and flags.
- `client/models/note/note.ts`: note domain model.
- `services/db/sqlite/schema.ts`: local SQLite schema.
- `services/api/change-manager/`: Yjs commit sync.
- `client/models/change/`: pending commits and local content-change state.
- `client/models/backlink/`: backlink derivation and alias helpers.
- `client/models/task/`: task projection from note document nodes.
- `services/api/operations/`: asynchronous graph operations applied by the client.
- `services/store-persistence/`: MobX snapshot persistence and migrations.
- `services/search/`: local text/vector search.
- `helpers/import/`: import prepare/import workflow.
- `helpers/prompt-templates/`: system/custom AI editor prompts.
- `server/`: API implementations.
- `shared/`: shared API contracts and lightweight types.

## Suggested V2 Starting Architecture

A V2 agent should avoid beginning with screens. Start by defining these contracts:

1. **Document model**: editor format, collaboration format, serialization, migration, and import/export format.
2. **Workspace model**: graph/workspace ownership, encryption, ACL, sharing, and billing gates.
3. **Projection model**: backlinks, tags, tasks, plain text, assets, contacts, semantic chunks, and search indexes.
4. **Sync model**: offline queue, conflict resolution, metadata sync, content sync, background operations, and recovery.
5. **Assistant model**: selected-text actions, note-level actions, search-grounded chat, transcription, and background summaries.
6. **Route model**: stable URLs for daily notes, regular notes, filtered lists, tasks, map, and preferences.

Once those contracts are explicit, the V1 screens map naturally onto V2 surfaces.

## One-Sentence Product Brief

Reflect V1 is a fast, encrypted, local-first daily-notes app where users capture everything into a chronological stream, connect ideas with backlinks, retrieve knowledge through search and AI, and keep tasks, meetings, imports, exports, and backups tied to the same personal graph.
