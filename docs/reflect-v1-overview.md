# Reflect V1 Overview

A handoff for an agent or engineer building a second version of Reflect: what the V1 app does, the product concepts it is built around, and the architectural choices that shaped it.

Deeper notes:

- [Mobile app](./reflect-v1-mobile-overview.md)
- [Mobile audio memos](./reflect-v1-mobile-audio-memos.md)

## Product Summary

Reflect V1 is a local-first, graph-based note-taking app. Users capture most of life into daily notes, then use backlinks, tags, search, tasks, calendar context, and AI to turn that stream into a connected personal knowledge graph.

Three centers of gravity:

1. **Daily capture**: the daily note is the default place for journals, meeting notes, tasks, bookmarks, voice notes, and stray thoughts.
2. **Associative organization**: backlinks replace folders. Notes form a graph of concepts, people, companies, meetings, and ideas.
3. **Fast recall**: keyboard shortcuts, local and semantic search, AI chat over search results, note history, and local persistence.

V1 runs as a Next.js web app, a desktop app integration, and a Capacitor mobile/tablet app. Firebase/Firestore is the remote backend. Local SQLite is the client-side source for fast reads, offline use, indexing, and sync.

## How to Think About V1

Four loops run on the same note graph:

1. **Capture**: daily note, editor, voice memo, browser extension, mobile share/deep links, meeting import, Readwise/book imports.
2. **Structuring**: backlinks, aliases, tags, tasks, note and prompt templates, duplicate-note merge, suggested backlinks and contacts.
3. **Recall**: note list, search, semantic search, command palette, graph map, similar notes, AI chat, note history.
4. **Reliability**: local SQLite, Yjs commits, pending commits, Firestore sync, local store persistence, backups, export, encryption unlock, migration/version gates.

Features are not isolated. A captured link can become a note, create backlinks, enter FTS/vector search, appear in the map, feed AI answers, and be exported. A task is text in a note that becomes a task item through derived parsing. A daily note is a normal note with date semantics that drives navigation, scheduling, calendar context, audio insertion, and onboarding.

For V2: the product's power comes from treating notes as the substrate and deriving many views from them.

## Core User Model

Everything is organized around **graphs**: user-owned workspaces with notes, tags, backlinks, assets, books, templates, backups, and feature flags. Users can have several and switch from the account menu.

Domain objects:

- **User**: auth, billing, preferences, AI provider and transcription settings.
- **Graph**: a named, encrypted workspace with ACLs, versioning, tags, and per-graph stores.
- **Note**: rich-text document with subject, body, backlinks, tags, tasks, assets, public sharing state, history, sync metadata, and an optional daily date.
- **Daily note**: a note tied to a date. The app opens here and scrolls infinitely through past and future days.
- **Backlink**: a typed link between notes, generated from editor links.
- **Task**: embedded in note content and collected in the Tasks view.
- **Credential**: a connected Google, Microsoft, or Apple account for contacts and calendars.
- **Asset**: an uploaded file whose text can be extracted and indexed.

### Graph as Boundary

The graph is the main product, security, sync, and UI boundary. Graph ID scopes local SQLite tables (notes, backlinks, assets, books, vectors). ACLs decide owner/read/write/public access. The encryption key gates content. The version controls migration and client compatibility. Flags enable debug or experimental behavior. Stores are per graph, even over shared SQLite tables.

A V2 should decide early whether "graph" stays the top-level workspace. Removing it later touches routing, sync, storage, sharing, backups, and UX.

## Main App Surfaces

### Daily Notes

The primary writing flow: a virtualized stream of dated notes extending both ways. Today is selected by default. Users jump to relative dates from search, commands, and backlinks. Daily notes use the same editor as regular notes, receive transcribed voice recordings, and show calendar context when credentials are connected.

Daily notes are the product's "inbox": browser captures, audio transcripts, meetings, and quick tasks all land there. Future dates are valid destinations, so daily notes double as light scheduling.

### All Notes

A dense table of notes (subject, snippet, tags, updated date) with keyboard navigation, multi-select, tag filtering, new-note creation, and trash/delete. It is both a library and a filtered result view: a tag click opens it with a tag query. Rows are virtualized placeholders from the local model pool, so large graphs list without hydrating every note, at the cost of complexity around loading, scroll restoration, and derived fields. See [reflect-v1-all-notes.md](./reflect-v1-all-notes.md).

### Note Editor

Built on `@team-reflect/reflect-editor` with ProseMirror/Yjs document state. Capabilities:

- Rich text, nested and collapsible lists, code blocks, highlights, underline, strikethrough, links, images.
- `[[...]]` backlink creation, opening, [hover previews](./porting/backlink-hover-previews.md), and selected-text backlinking.
- Tags, embedded tasks, and merge suggestions for duplicate subjects.
- Templates (slash-style workflows such as journal templates) and AI palette actions via prompt templates.
- File upload/download/save, link metadata lookup, image preview, print.
- Incoming backlinks below notes, live transcription when enabled, and primary/secondary panes for split editing.

Most navigation has shortcuts, focus restoration, and scroll/cursor persistence, to keep a high-speed writing feel.

Many systems meet here. `NoteEditMain` wires note state, Yjs updates, focus, keyboard toolbar, templates, prediction, file handlers, backlinks, tags, transcription, previews, and printing. `useNoteDocumentView` mediates the editable document, offline state, and incoming updates. The note model owns transforms for adding contacts, meetings, tasks, backlinks, and imported content. Selection and focus live outside the editor so routing, split panes, and the palette can restore the cursor.

V2 should treat the editor boundary as a first-class decision, with clear ownership of document state, derived metadata, and side effects.

### Note Context Sidebar

The right sidebar holds actions and context for the selected note: pin, trash/delete/restore, publish a shareable link, copy the note link, history, public URL details, suggested contacts, book metadata, meeting context, suggested backlinks, similar notes, and daily calendar context.

The key V1 pattern: the editor stays clean while secondary intelligence lives in the sidebar. That intelligence is mostly local and opportunistic:

- Suggested backlinks search for aliases of the note's subject and propose links from notes that mention them.
- Similar notes run semantic search on the subject and first line.
- Suggested contacts appear when the subject resembles a contact name and the note has no contact data yet.
- Daily notes show events when credentials are connected. Adding a meeting edits the note.

This gives V1 a "quiet assistant" feel without an LLM.

### Search and AI Chat

`Cmd/Ctrl+K` opens search, which is both a command palette and note retrieval. It supports keyword/FTS search over subjects, text, and extracted asset text; semantic search over local chunks (where sqlite-vec is available); exact/fuzzy/semantic strategies; filters (tags, dates, booleans, backlink conditions) shown as badges; navigation commands (daily note, relative dates, random note); previews; and AI chat over the current result set.

Search has three jobs: **find** notes, **navigate** to dates and filtered lists, and **reason** over the result set with citations. `Cmd+J` toggles results and chat. So V1's AI chat is not a global chatbot: it is grounded in a retrieval set the user chose. Answers are server-side completions, subject to provider/quota logic. Asset text is indexed separately and mapped back to parent notes.

### Tasks

Tasks are not database-first objects. They live in notes and are collected into the Tasks tab. They show circular check controls, distinct from plain checkboxes. The Tasks tab groups, filters, schedules, edits, and completes them. Deep links can create tasks on the daily note.

Each `Task` wraps a task node in a note document; its ID is the ProseMirror node GUID. Editing in the Tasks view updates a pending inline document, then syncs back into the source note. Scheduling adds or updates a daily-note backlink inside the task.

Groups: **Current** (scheduled today or attached to today), **Overdue**, **Upcoming**, **Other** (unscheduled, not pinned), **Pinned** (in a pinned note), and **Archived** (checked and hidden).

A V1 code comment notes the Tasks view loads every note with tasks into the pool. If tasks stay central, V2 should design a task index explicitly.

### Map

The Map tab renders the note graph (notes as nodes, backlinks as edges) with `@team-reflect/pixi-graph` and `graphology`. Hover previews a note, click opens it, and filters narrow the graph. It expresses "association over hierarchy."

It depends on the same backlink and note indexes as search and the sidebar. If V2 changes backlink semantics, review the map, suggested and incoming backlinks, similar notes, and previews together.

## Navigation and App State

A custom route-state layer sits over Next.js routes. `RouterView` derives paths from MobX state and applies incoming routes back into stores:

- `/g/:graphId/:noteId`: a note or daily note.
- `/g/:graphId/list/:query`: All Notes with a query.
- `/g/:graphId/map`, `/g/:graphId/tasks`: map and tasks.
- `/preferences/:preferenceScreen`: preferences.

History is integrated with app state, and `Cmd+[` / `Cmd+]` act as back/forward. Deep links can append text to daily notes, create tasks or notes, or open split-note editing.

The loading gate is state-driven: auth required → SQLite migrating (or failed) → graph setup → graph/user loading → encryption setup → graph version unsupported → ready.

For V2, design routes with the data model. V1's routes work because they are product routes, not page names.

## Capture and Import Workflows

### Audio Notes

Voice notes record on desktop, web, or mobile:

1. The user starts recording from the sidebar microphone or a shortcut.
2. Browser or native APIs capture audio, cached locally to avoid loss.
3. The uploader creates Firestore metadata and uploads the blob.
4. The backend transcribes, and the transcript syncs into the daily note.

Preferences cover language, formatting, and prompt hints for names or terms. There are two modes: the **recorded memo** above, and **live transcription** (the editor-level `Transcriber`, when enabled for the graph). They touch different parts of the stack. V2 should decide whether transcription is an editor primitive, an import primitive, or both.

### Browser Extensions and Links

Web capture runs through extension OAuth routes and link APIs. Link notes can carry metadata and optional AI summaries. Seed docs encourage installing the Chrome and Safari extensions for bookmarks and highlights.

Link capture uses **operations**: Firestore-backed work items the client listens for and applies locally, with locking, retries, failure counts, and bad-operation cleanup. Handlers include link creation, list append, Readwise sync, and book sync. This is V1's pattern for server/client cooperation: the server enqueues work, and the client applies it to the encrypted local graph.

### Imports and Exports

Graph settings hold import, export, backups, editing, and deletion. Exports: Reflect JSON, CSV, Markdown ZIP, HTML ZIP. Imports: Reflect JSON and third-party formats via `@team-reflect/reflect-import`. Automated daily backups are visible in graph preferences. Import is a prepare/import modal flow (pending, preparing, prepared, importing, imported, plus error states).

Export is user-facing and portable on purpose, because content is stored encrypted locally and remotely. For V2, export is part of the trust model, not an afterthought.

## AI Feature Surface

AI appears in several places:

- **AI palette**: prompt templates on selected text via `Cmd+J`.
- **System prompt templates**: continue writing, summarize, fix grammar, rephrase, simplify, copy edit, titles, tweets, outline, action items, meeting-note cleanup.
- **Custom prompt templates**: user-created, managed in Preferences.
- **Search chat**: cited answers over search results.
- **Link summaries** and **transcription cleanup**.
- **Provider abstraction**: server-side selection of Anthropic, OpenAI, and Google.
- **Quota enforcement**: free/paid/custom-key checks for predictions.

V2 should decide whether these are separate tools or one assistant layer with many entry points.

## Integrations

- **Google** and **Microsoft/Office 365**: OAuth, contacts, calendars.
- **Apple/iCloud**: credentials and calendar/contact support.
- **Stripe**: checkout, portal, subscriptions, webhooks.
- **AI providers**: Anthropic, OpenAI, Google Gemini, via server helpers.
- **Transcription**: server helpers plus client live transcription.
- **Firebase**: auth, Firestore, storage, rules tests, local emulator in CI.
- **Sentry** and analytics/logging.

Connections live in Preferences > Connections. Calendar and contact data shape note content: contacts become suggested context, meetings import into daily notes, attendees become backlinks or contact notes. Readwise/book imports work the same way: external data becomes notes and backlinks, not a separate silo.

## Preferences and Account Settings

Preferences are a full-screen split view. Personal: profile, connections, note templates, prompt templates, billing. Graph: rename/color, import, export, backups, delete, create/switch. The account menu also has graph switching, Preferences, Billing, and Sign out.

Preferences persist a lot of behavior: theme, editor sizing, date/time format, spellcheck, keyboard layout map, AI provider/custom keys, transcription, graph selection, UI sizes. Some lives in Firestore user preferences, some in local MobX snapshot persistence.

## Authentication, Billing, and Access

V1 has email auth and OAuth callbacks, OTP/password helpers, graph ACLs, trial and subscription state, paid-only features (note publishing), Stripe checkout and portal, and admin tools (users, graph and user flags, trials, reset, copy/rename graph, change email, disable users).

Users are trialing, paying, or out of standing. Out of standing makes the editor read-only. Auth and graph loading are intertwined: an authenticated user can still be blocked by graph setup, encryption, an unsupported version, or standing.

V2 should model these gates as explicit product states. They are user-facing moments where trust is won or lost.

## Data, Sync, and Offline Model

V1 is local-first on the client:

- MobX Keystone models hold app state. Kysely gives typed SQL.
- SQLite stores notes, backlinks, contacts, books, assets, FTS and vector indexes, commit backups, sync cursors, and job queue state.
- Firestore is the canonical remote. Metadata syncs through table-level abstractions. Note bodies sync as Yjs updates through a commit/change manager.
- Offline changes queue and sync later. A service worker and native helpers support offline use.

The note model stores both ProseMirror JSON and Yjs state. Derived fields are indexed locally for UI and search.

Graphs are encrypted. Users must provide the graph password/key before content loads. Passwords are local encryption credentials and should not leave the machine.

### Sync Layers

- **Remote snapshots**: Firestore listeners keep graph, tags, user, credentials, templates, and similar metadata current.
- **SQLite sync down / up**: Firestore documents become local rows; local metadata changes debounce and upload.
- **Yjs content commits**: note body changes are saved as Yjs commits and applied by `ChangeManager`.
- **Pending commits**: unsaved content changes live in `ChangeStore` and persist across reloads.
- **Derived indexes**: backlinks, FTS and vector rows, task flags, asset text, and metadata recalculate from content.
- **Local MobX persistence**: preferences, user/graph shell, credentials, UI state, filters, and change-store snapshots persist to platform storage.
- **Background uploads/reloads**: going online triggers uploads, reloads, and update notification.

The lesson: "sync" is not one mechanism. V2 should name each layer and its consistency guarantees.

### Local SQLite Tables

The schema is a projection of the workspace: `notes` (rows and derived metadata), `noteBacklinks`, `contacts`, `books`, `assets`, `assetsFts`, `notesFts`, `notesVec` (chunks and embeddings), `commitBackups`, `lastSyncs` (per-table cursors), and `jobs`. Many views are local reads, not API calls, which is why the app feels fast.

### Derived Note Fields

V1 derives and stores per note: plain text, tags, emails and phone numbers, link hrefs and domains, backlink target IDs, daily date, task presence, blank/oversize status, normalized subject, `//`-split subject aliases, and content metadata such as book ASIN. These power search, filters, suggested contacts, link/book metadata, tasks, map, the note list, and the sidebar. If V2 documents are the source of truth, plan the projection pipeline from day one.

### Backlinks and Aliases

Backlinks are both editor nodes and derived rows. The backlink store watches note changes and pending commits, extracts expected backlinks, and updates `noteBacklinks` transactionally.

Subject aliases use `//` in titles: `Charlotte MacCaw // Mum` lets either name match or be suggested. This small convention makes backlinks work for people, nicknames, companies, and alternate names without an alias UI. Suggested backlinks build on it: the destination's aliases become queries, matching notes are scanned for unlinked mentions, and the user can add them.

### History and Recovery

V1 stores every content change as commits, shows note history in the sidebar, tracks commit backups, runs automated graph backups, and has debug/recovery screens for broken Yjs or note states. Personal notes are high-trust data, and users expect recovery paths.

## Backend and API Surface

Next.js `pages/api` routes proxy into `server/` modules: auth tokens and OTP; graph create/list/suggest/delete/setup; note CRUD and daily updates; backlink listing; links and async enrichment; book and Readwise sync; credential auth and revocation; meetings and calendar; prediction/AI completion; search answers; transcription; Stripe; newsletter; developer OAuth; admin. Shared request/response schemas live in `shared/`. V2 APIs should keep transport contracts light and explicit.

The backend is narrow route handlers, not a monolith, and the client does substantial work:

- Server: auth-sensitive work, provider secrets, billing, OAuth, AI completions, transcription, public downloads, admin.
- Client: editing, local sync, indexes, backlinks, tasks, encrypted content projections.
- Firestore: many real-time and background flows.

If V2 changes encryption or local-first assumptions, this split changes dramatically.

## Platform Support

V1 targets the Next.js/Vercel web app, desktop via Electron-style helpers and renderer RPC, mobile/tablet via Capacitor, and browser extensions via OAuth routes. The platform layer is not cosmetic: it affects recording streams, the SQLite implementation, shortcuts (including OS-reserved ones), native app commands, file handling, the mobile keyboard toolbar and safe areas, and offline caching.

V2 should decide: one app across platforms, or platform shells around a shared model.

## Notable Product Principles

- **Daily notes first**: users should not have to decide where everything goes.
- **Association over hierarchy**: backlinks, aliases, and the graph view; no folders.
- **Local speed**: SQLite, FTS, vectors, virtualization, and caches keep common actions fast.
- **Offline resilience**: notes stay writable and searchable on poor connections.
- **Keyboard-native UX**: palette, shortcuts, focus restoration, editor commands.
- **Contextual intelligence**: AI, suggestions, similar notes, contacts, meetings, and search chat augment notes without replacing the editor.
- **User-owned archives**: import/export/backups are first-class.
- **Encrypted personal data**: a core constraint, not an add-on.

## Common User Journeys

- **First week**: sign up and create/unlock a graph → land on today → read seeded notes ("How to use Reflect") → connect calendar/contacts → install desktop/mobile/extension → import old notes → use daily notes, backlinks, tasks, search, and audio.
- **Daily capture**: open to today → type bullets, journal, meetings, links, tasks → backlink people and concepts inline → record a memo if typing is too slow → clean up with the AI palette → search or link to older notes.
- **Recall**: `Cmd/Ctrl+K` → search by keyword, fuzzy title, tag, date, or meaning → preview and open → switch to AI chat for synthesis → browse similar notes or the map.
- **Meeting**: connect calendar → open today → see events → add a meeting, optionally backlinking attendees → format or extract action items with prompt templates → tasks appear in the Tasks tab with note context.
- **Maintenance**: adjust profile, theme, editor, templates, AI, and billing → manage import/export/backups → review history to recover content → export for portability.

## V2 Design Notes

Worth preserving:

- Daily notes as the default capture surface, and backlinks as the core organizing primitive.
- Fast local keyword and semantic search.
- AI palette and chat as accelerators over user-owned notes.
- Tasks embedded in notes, collected into a task view.
- Graph-level import/export/backups, and explicit recovery affordances.
- The context sidebar for secondary intelligence.
- Keyboard-first, offline/local-first behavior.
- Document-derived projections that unify many views.
- Routeable states for notes, lists, tasks, map, and preferences.

Worth reconsidering:

- One repo spans web, desktop, mobile, extensions, Firebase, SQLite, Yjs, search, AI, billing, and admin. V2 could set cleaner boundaries early.
- ProseMirror JSON, Yjs, commits, metadata sync, derived fields, FTS, and vectors are powerful but complex. Treat sync as a first-order design problem.
- AI grew as prompt templates, search chat, summaries, and transcription. V2 can make one coherent assistant layer.
- The distinctions between graph, note, daily note, tag, backlink, task, and meeting could be simpler for users.
- Many features hide behind shortcuts or sidebars. Decide what stays power-user only.
- Billing, auth, encryption recovery, and graph setup are tangled into loading. Make onboarding and recovery explicit and testable.
- Embedded tasks are powerful but make the task list an expensive projection. Choose embedded, independent records, or a hybrid with clear sync rules.
- Search does palette, retrieval, filtering, and AI grounding. V2 may want separate mental models over one index.
- Sidebar intelligence is valuable but scattered. A single "note context engine" could own suggestions, similar notes, contacts, meetings, and backlinks.
- Publishing is paid-gated and per note. Revisit whether sharing is per note, graph, collection, or temporary.
- Encryption, sharing, AI, and indexing pull in different directions. Define privacy boundaries before building surfaces.

Questions to answer before building:

- What is the source of truth for note content: CRDT updates, structured JSON, markdown, or something else?
- Which projections must be local, durable, and queryable offline? Which can be rebuilt, and which must sync?
- Are tasks first-class records, note nodes, or both?
- Is the assistant centered on selected text, search results, the current note, the daily note, or the whole graph?
- Does encryption happen before or after indexing, AI, sharing, and backup?
- What does a graph mean to a non-power user?
- Which workflows must work offline on day one?
- What is the recovery story if sync, encryption, or editor state breaks?
- Which features must exist in V2 at once, and which can migrate later?

## Code Map for V2 Readers

Paths in the V1 repository:

- `client/screens/main/notes-sidebar/notes-sidebar.tsx`: primary navigation.
- `client/screens/main/main-tabgroup.tsx`: main screen selection.
- `client/screens/main/note-edit/note-edit-main.tsx`: editor integration.
- `client/screens/main/notes-daily/`, `notes-list/`, `notes-search/`, `tasks/`, `notes-map/`: daily notes, all notes, search and AI chat, tasks, and map.
- `components/note-context-sidebar/`: right sidebar.
- `client/models/store/root-store.ts`: top-level client state.
- `client/models/graph/graph.ts`: graph-level stores and flags.
- `client/models/note/note.ts`: note domain model.
- `services/db/sqlite/schema.ts`: local SQLite schema.
- `services/api/change-manager/`: Yjs commit sync.
- `client/models/change/`: pending commits and local content changes.
- `client/models/backlink/`: backlink derivation and alias helpers.
- `client/models/task/`: task projection from document nodes.
- `services/api/operations/`: async graph operations applied by the client.
- `services/store-persistence/`: MobX snapshot persistence and migrations.
- `services/search/`: local text/vector search.
- `helpers/import/`: import workflow.
- `helpers/prompt-templates/`: system/custom AI prompts.
- `server/`: API implementations. `shared/`: shared contracts and types.

## Suggested V2 Starting Architecture

Do not begin with screens. Define these contracts first:

1. **Document model**: editor format, collaboration format, serialization, migration, import/export format.
2. **Workspace model**: ownership, encryption, ACL, sharing, billing gates.
3. **Projection model**: backlinks, tags, tasks, plain text, assets, contacts, semantic chunks, search indexes.
4. **Sync model**: offline queue, conflicts, metadata and content sync, background operations, recovery.
5. **Assistant model**: selected-text and note-level actions, search-grounded chat, transcription, background summaries.
6. **Route model**: stable URLs for daily notes, notes, filtered lists, tasks, map, and preferences.

With those explicit, V1 screens map naturally onto V2 surfaces.

## One-Sentence Product Brief

Reflect V1 is a fast, encrypted, local-first daily-notes app where users capture everything into a chronological stream, connect ideas with backlinks, retrieve knowledge through search and AI, and keep tasks, meetings, imports, exports, and backups tied to the same personal graph.
