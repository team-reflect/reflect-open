# Reflect V2 Grounding Brief

**Purpose:** Provide a broad, implementation-oriented overview of the current Reflect app so a V2 agent can understand the existing product model, feature surface, UX assumptions, constraints, and likely migration implications.

**Decision status:** This brief is grounding material from the V1/Academy docs. It is not the source of truth for V2 product decisions. When this brief conflicts with the newer V2 decision docs, defer to [Reflect V2 Product Vision](./reflect-v2-product-vision.md), [Reflect V2 Indexing Strategy](./reflect-v2-indexing-strategy.md), and [Reflect V2 Sync Strategy](./reflect-v2-sync-strategy.md).

**Primary sources:** Reflect Academy / Notion pages browsed via the Notion connector on 2026-06-08. Source links are listed at the end.

---

## 1. Executive Summary

Reflect is a personal note-taking and knowledge-management app built around a deliberately simple model:

- **Daily notes are the default capture surface.** Users are encouraged to put journals, meeting notes, bookmarks, tasks, and loose thoughts into today's daily note.
- **The product is graph-first, not hierarchy-first.** Reflect explicitly rejects folder hierarchy as the core organization system. Its model is association: notes link to other notes using backlinks, with tags layered on for categorization.
- **The interface is minimal but keyboard-driven.** The product emphasizes speed, command palette usage, slash commands, backlinks, and keyboard shortcuts.
- **Reflect is not just an editor.** It also includes capture surfaces, AI actions, search, publishing, integrations, tasks, audio transcription, import/export, and an API.
- **Security and data ownership are core constraints.** Notes, images, and files are end-to-end encrypted client-side. This affects API design, server capability, search/indexing, AI, publishing, and recovery.
- **The app tries to stay narrow in core UI and outsource breadth to integrations.** Calendar, contacts, Zapier, Readwise, Kindle, browser extensions, iOS share sheet, and deep links extend Reflect without cluttering the main interface.

V2 should preserve the strong parts of the product's mental model—fast capture, daily notes, backlinks, graph-based recall, trust, and data portability—while revisiting old constraints around encryption, AI, task depth, sync architecture, mobile parity, local-first behavior, and structured knowledge extraction. Current V2 direction intentionally does not preserve V1's E2EE-first architecture.

---

## 2. Current Product Philosophy

Reflect's underlying philosophy is that memory is associative and temporal. The app mirrors that through two primitives:

1. **Time:** daily notes form an infinite chronological spine.
2. **Association:** backlinks connect entities, concepts, people, companies, places, books, meetings, and ideas.

The app's docs explicitly say:

- Users should put everything into today's daily note by default.
- Reflect has "no hierarchy, only association."
- Backlinks are the main mechanism for organization.
- Tags are separate from backlinks: tags categorize; backlinks associate.
- The product aims to be minimal and avoid feature clutter.

This implies Reflect is closer to a **personal memory graph** than a document workspace. It is designed for fast personal capture and later recall, not team collaboration or database-heavy project management.

---

## 3. Core Information Architecture

### 3.1 Graphs

During setup, users create a **graph** and an encryption password. The graph appears to be the main encrypted knowledge container. The docs refer to graph preferences, graph export/import, and multiple graph creation for imports.

Implications for V2:

- Graph is likely the top-level data boundary.
- Encryption password is graph-level.
- Import/export and recovery flows are graph-scoped.
- Multiple graphs may exist, though the docs mostly assume a default graph such as "My Brain."

### 3.2 Notes

A note is the main content object. Notes can be regular notes or daily notes. They can contain:

- Plain text
- Bullets
- Headings
- Backlinks
- Tags
- Tasks
- Checklists
- Templates
- Bookmarks
- Highlights
- Images / files
- AI-generated output
- Audio transcription output

Notes support revision history and publishing.

### 3.3 Daily Notes

Daily notes are the primary workflow anchor. Users are told to put:

- Journals
- Meeting notes
- Bookmarks
- Tasks
- Captured ideas
- Audio transcriptions

into today's daily note.

Daily notes can be accessed via keyboard shortcut and command palette commands. Search supports natural-ish navigation commands such as "go to daily note" or "5 days from now."

### 3.4 Backlinks

Backlinks are created by typing `[[` and then selecting or creating a note. They are meant to be used whenever an entity appears in a note, such as a person, company, location, project, or idea.

Important details:

- Backlinks are links between notes.
- The docs recommend linking full entity names, not abbreviations.
- Backlinks are case-sensitive.
- Incoming backlinks appear at the bottom of linked notes.
- Backlinks organize notes automatically by creating a graph of associations.
- Split-pane editing exists primarily to edit backlinks without losing the context of the daily note.

### 3.5 Tags

Tags categorize notes. The docs distinguish tags from backlinks:

- **Backlinks:** associate two notes.
- **Tags:** categorize notes.

Known tag examples include:

- `#book` for Kindle-imported book notes
- `#person` and `#company` for contact/company enrichment behavior

### 3.6 Tasks vs Checklists

Reflect distinguishes tasks from checklists:

- **Tasks** are concrete todo items. They appear in the Tasks tab.
- **Checklists** are temporary lists such as shopping lists. They do not appear in the Tasks tab.
- Tasks use round checkboxes.
- Checklists use square checkboxes.
- Tasks can be created via slash command, `+` followed by space, or conversion from bullets.
- Tasks can be aggregated, edited, completed, archived, and scheduled.

The docs frame tasks as intentionally simple: enough to cover the common case, not a full dedicated task-manager replacement.

---

## 4. Main UX Model

### 4.1 Fast Keyboard-First Operation

Reflect is designed to be usable almost entirely from the keyboard. Important shortcuts include:

- `[[` — create backlink
- `cmd k` — search / command overlay
- `cmd d` — go to daily note
- `cmd n` — new note
- `cmd /` — show keyboard shortcuts
- `cmd enter` — turn list item into a todo/checklist item
- `cmd shift return` — convert bullet to task in the tasks beta docs
- `cmd shift f` — no-distraction mode
- `cmd ,` — preferences
- `cmd j` — AI palette
- `cmd shift p` — browser capture extension
- `cmd + click` on backlink — open split pane
- `command enter` on selected backlink — open split pane
- `escape` — close split pane
- `command option left/right` — move focus between split panes

V2 implication: keyboard shortcuts are not incidental. They are part of the product identity. Any V2 rewrite should treat command routing, focus management, and keyboard ergonomics as first-class architecture.

### 4.2 Command Palette

The `cmd k` search/command overlay is a central navigation and retrieval surface. It supports:

- Finding notes
- Searching notes
- Basic commands
- Date-oriented navigation
- Likely command execution beyond search

Advanced search also appears to be accessed through this same surface.

### 4.3 Slash Menu

The slash menu is used to insert templates and tasks. It likely functions as the editor's block/action insertion mechanism.

### 4.4 Split Pane

Split pane lets users view and edit two notes simultaneously. It is specifically positioned as useful for editing linked notes while staying in the daily-note context.

Core behavior:

- Command/control-click a backlink to open linked note in split view.
- Keyboard selection plus command-enter also opens split view.
- Escape closes split view.
- Focus can move between panes via keyboard.

V2 implication: split-pane is a direct response to the graph/backlink workflow. It should not be treated as a generic productivity feature only.

---

## 5. Feature Inventory

## 5.1 Onboarding and Account Setup

Current setup flow:

1. Authenticate with email, Google, or Apple.
2. Create graph and encryption password.
3. Download a password recovery kit automatically.
4. Complete onboarding tutorial.
5. Desktop or web setup is required before iPhone setup.

Platforms mentioned:

- Web app
- Desktop app
- macOS
- iOS
- iPad
- Chrome
- Safari
- Windows support is implied in keyboard shortcuts, but docs emphasize macOS/iOS clients.

Trial:

- Two-week free trial.
- No credit card required.

V2 considerations:

- Setup is tightly coupled to encryption.
- Recovery-kit education must be very clear.
- Mobile-first onboarding may need reconsideration if V2 aims for parity.
- Password loss is catastrophic unless user has recovery kit, active session, keychain, or local backups.

---

## 5.2 Editor and Notes

The editor supports:

- Plain text
- Bullets
- Headings
- Lists
- Todo/checklist items
- Tasks
- Backlinks
- Tags
- Hyperlinks
- Templates
- Images and files
- Markdown content via deep links
- Published-note rendering
- AI-selected text processing

Recommended usage is bullet-heavy daily notes.

V2 considerations:

- The editor must be fast and reliable under heavy keyboard use.
- Backlink creation and resolution are core, not plugins.
- Tasks/checklists must be represented distinctly in the data model.
- Markdown import/export and deep-link content require robust serialization.

---

## 5.3 Journaling

Reflect includes a default journaling template accessible by typing `/journal` in a daily note. Users can customize templates in preferences.

V2 considerations:

- Daily note templates are part of habit formation.
- Templates should likely be first-class reusable snippets with the full editor feature set.

---

## 5.4 Backlinks, Incoming References, and Graph Organization

Backlinks organize the app. A user typing `[[Person Name]]` creates or references a note. The linked note then shows incoming backlinks back to the daily note or other source note.

V2 considerations:

- Backlinks should be fast to create.
- Backlink autocomplete should handle contacts, existing notes, and probably AI/entity suggestions.
- Case sensitivity and full-name guidance may be brittle. V2 could consider aliases, canonical entities, fuzzy merge, and entity normalization.
- Incoming backlink rendering is key to surfacing context.
- Backlink semantics may need to distinguish entities, concepts, dates, projects, and tags.

---

## 5.5 Tags

Tags categorize notes and can be used in search filters. `#person` and `#company` also trigger enrichment behavior through Clearbit-like enrichment in current docs.

V2 considerations:

- Tags currently appear to be mostly user-authored labels, but some features depend on specific tags.
- V2 should decide whether tags are merely labels or typed metadata.
- Special tags such as `#person`, `#company`, and `#book` should be explicit product concepts if they drive behavior.

---

## 5.6 Search

Reflect has both quick search and advanced search.

Advanced search filters include:

- Date created or updated
- Daily notes
- Notes backlinked to/from other notes
- Tags
- Pinned notes

Search also supports semantic and fuzzy search, allowing queries that do not match exact note text. The docs give an example of searching recipes for "meat dishes" even if notes do not contain those words.

V2 considerations:

- Search has to combine structured filters, graph filters, lexical search, fuzzy search, semantic search, and command execution.
- E2EE complicates server-side search. V1's privacy model requires deliberate local/client-side or encrypted-index strategies.
- Current V2 direction is local-first rather than E2EE-first: lexical search and semantic search should run locally over markdown-derived indexes, with local embeddings for first-wave semantic search.
- Search should be treated as the primary retrieval UX, not a secondary feature.

---

## 5.7 AI Palette

Reflect includes an AI palette accessible with `cmd j`.

Workflow:

1. Highlight text and press `cmd j`, or invoke AI without text selected.
2. Pick from built-in prompts or type an open-ended request.
3. Use AI to transform, summarize, extract, outline, or improve content.
4. Save custom prompts for reuse.
5. Users can choose between GPT-4o and Claude 3.5 Sonnet according to current docs.

Built-in prompt examples:

- List action items
- List key takeaways
- Edit writing
- Generate article outlines
- Summarize articles
- Fix grammar and spelling
- Improve writing
- Save custom prompts

Security caveat:

- Selected text sent to the AI feature is sent to external model servers according to the current security docs.
- Audio transcription sends raw audio to an external transcription API before storing transcription.

V2 considerations:

- AI should be deeply integrated with notes, tasks, search, and entity extraction.
- Current AI appears mainly command/prompt-based. V2 could move toward agentic workflows: automatic meeting summaries, entity extraction, task extraction, auto-backlink suggestions, document distillation, and memory query.
- Current V2 decisions are BYOK generative AI, local embeddings for first-wave semantic search, transparent context, and `private: true` notes that are hard-blocked from cloud AI.
- Custom prompts are an important power-user primitive and should likely be preserved.

---

## 5.8 Templates

Templates are reusable snippets inserted through the slash menu. They support the full editor, including:

- Tags
- Backlinks
- Headers
- Lists
- Other editor elements

Use cases:

- Daily note structure
- Journaling
- Meeting notes
- Repeated boilerplate

V2 considerations:

- Templates should be structured but easy to edit.
- Consider variable support: dates, contacts, calendar event fields, meeting attendees, linked projects, etc.
- The template system is a natural bridge between unstructured notes and structured workflows.

---

## 5.9 Web Bookmarking and Highlight Capture

Reflect supports web capture via:

- Chrome extension
- Safari extension
- iOS share menu

Browser capture behavior:

- User browses to website.
- Presses `cmd shift p` or clicks extension icon / right-click menu.
- Saves the link.
- Optionally selects text and adds a description.
- Link and highlights are automatically added to the daily note.

Mobile capture:

- If iOS app is installed, Reflect appears in the iOS share menu.
- Highlighted text is saved along with the website.

V2 considerations:

- Daily note is again the capture destination.
- Web capture creates an information-ingestion stream that should be searchable and linkable.
- V2 link capture is implemented for the desktop Chrome-extension path; full article clipping, Safari, and mobile share targets are deferred further still.
- The shipped desktop path is a Chrome extension talking to the installed desktop app through the native host/inbox bridge.
- The desktop app should own markdown writes, screenshot asset storage, BYOK AI calls, keychain access, and privacy checks.
- V2 should not host a link-description API; enrichment calls should go directly from the app to the user's chosen model provider.
- Captured links should append to today's daily note by default, with a dedicated markdown note when the capture includes richer description, highlights, or screenshot context.
- V2 should enrich captures with metadata, summaries, source preservation, backlinks, and deduplication. Read-later state and full article extraction can come later.
- `private: true` captures should save locally without sending URL contents, screenshots, selected text, or note content to cloud AI.

---

## 5.10 Publishing Notes

Reflect has one-click publishing:

- User clicks publish under note actions.
- Note becomes publicly available behind a long hard-to-guess URL.
- URL is copied to clipboard.
- User can unpublish.
- Published note style is intended to be clean with minimal branding.

Important encryption implication:

- Publishing requires decrypting the note client-side and sending it to Reflect servers so they can render it publicly.

V2 considerations:

- Publishing is incompatible with pure server-invisible E2EE unless there is explicit user action to decrypt/publish.
- Published artifacts need access control decisions: secret URL only, password, expiry, unlisted, indexed, custom domain, etc.
- V2 should model published notes as separate public artifacts, not simply normal encrypted notes.

---

## 5.11 Calendar and Contacts

Reflect can connect:

- Google
- iCloud
- Office 365
- Google Calendar
- Google Contacts
- iCal / iCloud calendar

Capabilities:

- Pull calendar events into daily notes.
- Add meetings easily to daily notes.
- Auto-populate backlink menu with Google Contacts.
- Google Contacts can be synced and available when backlinking.

Docs state data is not shared with third parties and only used for listed functionality.

V2 considerations:

- Meetings are a major daily-note use case.
- Contact-backed backlinks are crucial for a personal CRM-like memory graph.
- Contact/calendar permissions should be narrow, explainable, and revocable.
- V2 could make meeting notes first-class: attendees, agenda, transcript, tasks, decisions, follow-ups, backlinks.

---

## 5.12 Audio Memos

Reflect supports audio memos through transcription.

Capabilities:

- Desktop recording via microphone icon.
- iPhone/iPad recording via plus icon → "Transcribe audio."
- iOS lock-screen widget for one-tap recording.
- Audio uploads and transcribes in background.
- Transcript is added to daily note after a few minutes.
- Users can add helper text for difficult words/names in profile preferences.
- macOS caches raw audio recordings locally in `~/Library/Caches/app.reflect.AudioRecorder/`, allowing recovery if transcription fails.

Use cases mentioned:

- End-of-day reflection
- Capturing ideas on the go
- Executive-assistant-like workflows
- Generating article outlines

V2 considerations:

- Audio capture is a strong wedge for mobile. (V2 shipped desktop audio memos in the first wave, ahead of the original deferral: raw-first local recordings with async BYOK cloud transcription.)
- V2 audio transcription uses cloud transcription providers rather than local-only transcription so Mac and mobile can share the same capability and quality expectations.
- Raw audio should be treated as external cloud-processing data, similar to BYOK/cloud AI context. The product must make this clear before upload.
- `private: true` notes and captures should block cloud transcription and cloud transcript cleanup unless the user explicitly changes the privacy setting.
- Transcription should produce structured outputs, not just raw text: summary, tasks, entities, linked notes, cleaned transcript, original audio retention policy.
- Local recording recovery is useful and should be formalized.

---

## 5.13 Integrations

Reflect's integration philosophy is explicit: keep the UI simple, integrate with other apps to gain power without clutter.

Current integrations include:

- Google Calendar
- Google Contacts
- iCal / iCloud
- Office 365
- Zapier
- Readwise
- Kindle sync
- Chrome extension
- Safari extension
- iOS share menu
- REST API
- Deep links

Zapier examples:

- Add Trello cards or Asana tasks to the daily note.
- Add Google Docs and Slack notes to Reflect.
- Save emails and Tweets to notes.
- Sync Strava data with Reflect.

Readwise examples:

- Sync bookmarked Tweets.
- Import Kindle or Apple Books highlights through Readwise.
- Save podcast highlights.
- Gather highlights from physical books.
- Use Readwise Reader highlights.

V2 considerations:

- Integrations are part of ingestion and automation, not optional extras.
- V2 should define an explicit ingestion pipeline: source → capture artifact → daily note / target note → backlinks/entities → search index.
- Zapier/API/deep links should not be three inconsistent systems; they should map to a unified command/action layer.

---

## 5.14 Kindle Sync

Reflect can sync Kindle books, highlights, and comments. Current behavior:

- Books, highlights, and comments are imported as individual notes.
- Imported book notes are tagged `#book`.
- Authors are backlinked.
- Setup requires Chrome extension and Amazon login.
- Sync runs every five hours.
- Manual sync exists.
- Current docs say Apple Books and other services are not supported directly.
- Current docs say only US-based Amazon stores are supported due to Amazon limitations.

V2 considerations:

- Kindle sync is a domain-specific importer with opinionated structure: books as notes, authors as backlinks, `#book` tag.
- V2 could generalize this as a typed source/importer framework.
- Book/highlight ingestion benefits from source metadata, stable IDs, deduplication, quotes vs comments, and export provenance.

---

## 5.15 API

Reflect has a REST API.

Capabilities described:

- Append data to notes.
- Return a list of bookmarked links.
- "A few other things."

Major constraint:

- Note-related endpoints are append-only/write-only because note contents are end-to-end encrypted and the server cannot read note contents.

Auth:

- OAuth 2.
- OAuth credentials are created through Reflect developer settings.
- Users can generate an access token from the interface, effectively like an API key.
- PKCE is supported for clients without shipping secret keys.
- Requests use `Authorization: Bearer YOUR_ACCESS_TOKEN`.

V2 considerations:

- Existing V1 API behavior should be treated as append-first automation rather than full data access.
- Current V2 direction is read/discovery CLI first through commands such as `reflect search`, `reflect show`, `reflect today`, and note path lookup.
- Manual edits to markdown files are the write path. A separate write CLI is not needed initially.
- Local servers and broader automation surfaces should be deferred until the markdown, sync, and permission model is clearer.

---

## 5.16 Deep Links

Reflect supports custom URL deep links using:

```text
reflect://reflect?command=<command_name>&<parameter1>=<value1>&...
```

Supported commands documented:

- `append-to-daily-note`
- `create-task`
- `create-note`
- `edit-notes`

Capabilities:

- Append text to today's daily note.
- Create task in task view and today's daily note.
- Create blank note.
- Open/edit note by ID or subject.
- Create note by subject if not found.
- Provide Markdown content when creating notes.
- Open two notes side-by-side using split-pane arguments.

V2 considerations:

- Deep links are effectively an external command API.
- These should be unified with internal command palette actions and public API actions.
- A typed command registry would reduce duplication across UI, API, shortcuts, automation, and deep links.

---

## 5.17 Import, Export, and Backups

Reflect emphasizes data portability.

Imports supported:

- Apple Notes HTML
- Evernote ENEX
- Markdown files
- Roam JSON
- Workflowy OPML
- Roam Research JSON
- Mem.ai JSON beta
- Logseq JSON beta
- Other Reflect instances JSON

Export formats:

- Reflect JSON
- Reflect CSV
- Markdown zip
- HTML zip

Backups:

- Notes sync securely to cloud when online.
- Reflect also makes daily backups to the user's hard drive.
- Local backups may help if servers fail or the user loses their password.

Caveat:

- Evernote attachment import is not supported according to the docs.

V2 considerations:

- Data portability is an explicit value, not a checkbox.
- V2 preserves portability by making markdown files and assets the source of truth.
- No dedicated import/export suite is planned for V2; copying or zipping the graph folder is the export path.
- Reflect V1 exports now use a V2-compatible graph shape, so no dedicated V1 importer is needed.
- Backup and recovery need a clear architecture, especially with local-first files, GitHub backup, optional encrypted layers, and sync conflict recovery.

---

## 5.18 Security and Encryption

Reflect's docs state:

- Note contents are end-to-end encrypted.
- Notes are encrypted client-side before being sent to servers.
- The cipher is XChaCha20-Poly1305.
- The user's encryption password is the key and never leaves the machine.
- Server-side note data is an encrypted blob that Reflect cannot read.
- Images and files added to notes are also end-to-end encrypted.
- The encryption library is public on GitHub under `team-reflect/kiss-crypto`.
- Doyensec audited the security and encryption design and found it well-architected at the design level, with sound cryptographic primitive usage.

Important caveats:

- AI processing sends selected text to external AI servers.
- Audio transcription sends raw audio to an external transcription API.
- Publishing requires sending decrypted note content to Reflect servers.
- The docs acknowledge that users must ultimately trust the client, because web/desktop clients can be updated.
- Password loss can permanently lock users out unless they have recovery kit, active session, keychain backup, or local backup.

V2 considerations:

- E2EE is a central V1 product promise and constrains server-side functionality.
- Current V2 direction replaces the E2EE-first premise with explicit trust boundaries:
  - local plaintext markdown files
  - local indexes and embeddings
  - optional encrypted backup/sync layers
  - BYOK or cloud-provider AI/cloud processing
  - `private: true` cloud-AI lockouts
  - published public content
  - integrations
  - backups
  - API reads/writes
- Any AI-first V2 must avoid quietly weakening the privacy model.

---

## 5.19 Note History

Reflect continually records edits to notes. Users can:

- View all note changes.
- Restore a revision to a new note.
- Preserve the existing note when restoring to a new note.

V2 considerations:

- History is important for trust.
- "Restore to new note" avoids destructive rollback.
- This feature interacts with sync conflict resolution, local-first storage, local checkpoints, and optional encrypted backup/sync layers.

---

## 5.20 Tasks

Reflect has a Tasks tab aggregating tasks across notes. Capabilities:

- View tasks across daily and regular notes.
- Edit tasks.
- Complete tasks.
- Archive completed tasks.
- Schedule tasks for later.
- Create tasks via slash command, `+` space, or keyboard conversion.
- Distinguish tasks from checklists.

Product positioning:

- The docs state Reflect's first priority remains note-taking.
- Tasks are intentionally simple.
- Advanced task management such as recurring tasks is left to dedicated task managers.

V2 considerations:

- Current tasks are a light layer over notes.
- V2 should decide whether to keep tasks lightweight or make them a major primitive.
- If lightweight, preserve simplicity and aggregation.
- If deeper, add recurrence, reminders, priorities, projects, statuses, dependencies, calendar integration, and external task sync carefully.

---

## 6. Data Model Inferences

The docs imply the following conceptual model.

### 6.1 Entities

Potential entities:

- Graph
- Note
- Daily note
- Backlink
- Tag
- Task
- Checklist item
- Template
- Bookmark
- Highlight
- Calendar event
- Contact
- Audio memo
- Transcript
- Published note
- Import job
- Export job
- Integration connection
- API client / OAuth credential
- Deep link command
- Revision / note history event
- Attachment / image / file

### 6.2 Relationships

Important relationships:

- Note belongs to graph.
- Daily note is a note keyed by date.
- Note links to note through backlink.
- Note has incoming backlinks.
- Note has tags.
- Task originates in note but appears in global task view.
- Checklist item remains local to note and does not appear globally.
- Bookmark/highlight is inserted into daily note.
- Calendar event can be added to daily note.
- Contact can be suggested as a backlink.
- Kindle book/highlight creates notes, tags them, and backlinks authors.
- Published note is derived from decrypted note content.
- Revision belongs to note.
- Export/import operates at graph level.
- API append writes into graph/note/daily note without server read access.

### 6.3 Architecture Pressure Points

The major hard parts for V2:

1. **E2EE vs search/AI/API.** Reflect's privacy model limits what the server can do.
2. **Graph UX vs entity normalization.** Backlinks are easy, but canonical people/companies/projects may need aliases and merging.
3. **Daily note as universal inbox.** Powerful, but can become cluttered without good extraction and resurfacing.
4. **Tasks as note-native objects.** Need clear semantics around completion, scheduling, archiving, and source note preservation.
5. **Capture surfaces.** Browser, mobile, audio, calendar, API, and integrations all need a unified ingestion path.
6. **Publishing.** Public notes sit outside the private encrypted model.
7. **Sync and history.** Local edits, offline use, encryption, history, and conflict resolution are likely central complexity.

---

## 7. Product Surface Summary Table

| Area              | Current capability                                       | V2 implication                                          |
| ----------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| Daily notes       | Default capture surface for everything                   | Preserve as temporal inbox; consider extraction/cleanup |
| Backlinks         | `[[` creates note associations                           | Core primitive; consider aliases/entities               |
| Tags              | Categorize notes; used in filters and enrichment         | Decide label vs typed metadata                          |
| Search            | Command palette, filters, semantic/fuzzy search          | Core retrieval surface; V2 should use local indexes     |
| AI                | Prompt palette, selected-text transforms, custom prompts | Expand carefully without weakening privacy              |
| Templates         | Slash-insert reusable editor snippets                    | Add variables/context-aware templates                   |
| Web capture       | Chrome/Safari/iOS share to daily note                    | Generalize ingestion pipeline                           |
| Publishing        | Secret public URL; decrypted content sent to server      | Model public artifacts explicitly                       |
| Calendar/contacts | Meetings into daily note; contacts in backlink menu      | Make meetings/contact memory first-class                |
| Audio memos       | Record, transcribe, append to daily note                 | Add structured transcript workflows                     |
| Integrations      | Zapier, Readwise, Kindle, calendar, contacts             | Unify action/ingestion system                           |
| Kindle sync       | Book notes, highlights, `#book`, author backlinks        | Generalize source-specific importers                    |
| API               | OAuth, append-only due to E2EE                           | Read/discovery CLI first; markdown files are write path |
| Deep links        | External command URLs                                    | Unify with command registry                             |
| Import/export     | Multiple imports; JSON/CSV/Markdown/HTML export          | Superseded by markdown-folder portability               |
| Security          | E2EE with XChaCha20-Poly1305; Doyensec audit             | Treat trust boundaries explicitly                       |
| Note history      | Continuous revisions; restore to new note                | Preserve for trust and sync safety                      |
| Tasks             | Aggregate, schedule, complete, archive                   | Choose lightweight vs serious task system               |
| Split pane        | Edit linked note beside current note                     | Core graph-navigation affordance                        |

---

## 8. Likely Current User Workflows

### 8.1 Daily Capture Workflow

1. Open today's daily note.
2. Add bullets, meeting notes, journal entries, tasks, links, or thoughts.
3. Use `[[` to link people, companies, projects, places, and concepts.
4. Use tags for categories.
5. Use search or backlinks later to recover context.

### 8.2 Meeting Workflow

1. Calendar event appears near daily note.
2. User inserts meeting into daily note.
3. Attendees may autocomplete as contact backlinks.
4. User takes notes.
5. AI palette can extract action items / takeaways.
6. Tasks are aggregated in Tasks tab.

### 8.3 Web Research Workflow

1. User reads webpage.
2. Browser extension captures link/highlight.
3. Link/highlight is appended to daily note.
4. User backlinks relevant people/topics.
5. Later retrieval happens through search, tags, or backlinks.

### 8.4 Book / Highlight Workflow

1. Kindle or Readwise sync imports highlights.
2. Books become notes tagged `#book`.
3. Authors are backlinked.
4. User can connect highlights to other notes via backlinks.

### 8.5 Audio Capture Workflow

1. User records memo on desktop/mobile/lock screen.
2. Reflect uploads and transcribes.
3. Transcript appears in daily note.
4. User optionally uses AI palette to summarize or extract article outline/action items.

### 8.6 Automation Workflow

1. External system calls API, Zapier, or deep link.
2. Reflect appends content to daily note or creates tasks/notes.
3. User later organizes through backlinks/tags/search.

---

## 9. V2 Design Recommendations

### 9.1 Preserve the Core Identity

Do not turn Reflect into generic Notion, Linear, or Apple Notes. The strongest identity is:

- Fast personal capture
- Daily-note timeline
- Associative backlinks
- Minimal UI
- Search as memory recall
- Trusted personal knowledge graph with user-owned data

### 9.2 Make Ingestion a First-Class Pipeline

Current ingestion is spread across:

- Manual editor
- Browser extensions
- iOS share
- Audio memos
- Calendar events
- Contacts
- Kindle sync
- Readwise
- Zapier
- API
- Deep links

V2 should define one internal pipeline:

```text
source → raw capture → normalized object → daily note insertion / target note → entity extraction → backlinks/tags/tasks → search index → history/sync
```

### 9.3 Unify Commands Across UI, API, and Deep Links

Reflect currently has commands in:

- `cmd k`
- Slash menu
- Deep links
- API
- Browser extension
- Task creation
- AI palette

V2 should have a typed command registry:

```text
command id
arguments schema
permissions
availability
keyboard shortcut
UI action
API/deep-link mapping
undo/history behavior
sync semantics
```

### 9.4 Treat Privacy as Architecture, Not Marketing

In V1, E2EE affects almost every feature:

- Search
- Semantic search
- AI
- API
- Publishing
- Integrations
- Backups
- Recovery
- Sync
- Contact enrichment
- Audio transcription

V2 still needs explicit trust boundaries, but the current V2 decision is local-first and AI-native rather than E2EE-first. V2 should clearly separate:

- Local plaintext operations
- Optional encrypted backup/sync layers
- External AI/transcription operations
- Public/published content
- Integration data
- Local indexes
- Cloud indexes

### 9.5 Revisit the Entity Model

Backlinks are currently note-to-note links, but users are really creating entities:

- Person
- Company
- Project
- Book
- Location
- Meeting
- Idea
- Topic
- Date

V2 could improve the system by adding optional entity typing without making the UI heavy.

Possible upgrade:

- Backlink remains simple: `[[Alice]]`
- Behind the scenes, Reflect can suggest type/person/contact/project/book.
- Aliases and canonicalization solve case sensitivity and abbreviation problems.
- Merging/splitting entities handles messy real-world usage.

### 9.6 Upgrade AI from Text Transform to Memory Agent

Current AI is mostly prompt palette. V2 could support:

- Ask questions over notes
- Summarize a person/company/project note from backlinks
- Extract tasks from meeting notes
- Suggest backlinks as user types
- Generate daily/weekly reviews
- Clean up audio transcripts
- Turn raw capture into structured notes
- Detect duplicate notes/entities
- Propose tags
- Create meeting follow-up drafts
- Build article outlines from scattered notes

But this must be reconciled with V2's privacy model: local ownership, `private: true` cloud-AI locks, transparent AI context, and optional encrypted backup/sync layers.

### 9.7 Keep Tasks Lightweight Unless There Is a Clear Strategy

Current docs intentionally avoid becoming a full task manager. V2 must choose:

**Option A: Lightweight tasks**

- Aggregate tasks
- Schedule
- Complete/archive
- Preserve note context
- Integrate with AI extraction

**Option B: Serious task system**

- Recurrence
- reminders
- priorities
- projects
- statuses
- dependencies
- calendar sync
- external task integrations

The worst path is half-building a complex task manager and losing the simplicity of the note-taking product.

### 9.8 Preserve Portability Through Markdown

The docs make data portability part of Reflect's values. V2 should satisfy that promise through its storage model rather than a parallel import/export product area.

Minimum viable V2 portability:

- Notes are plain markdown files under `daily/` and `notes/`.
- Attachments live as normal files under `assets/` and use relative markdown links.
- Backlinks, tags, tasks, and daily-note dates remain readable in markdown.
- `.reflect/` stays out of the durable portability contract except for deliberately documented durable local tables such as `chat_*`.
- Users can copy or zip the graph folder directly.
- Reflect V1 migration relies on the V1 exporter producing a V2-compatible graph shape, not a separate V2 import surface.

### 9.9 Make Mobile Capture Excellent

Audio memos, iOS share, lock-screen widget, and daily note capture are already strong mobile surfaces. V2 should make mobile a first-class capture product, not only a viewer.

---

## 10. Open Questions for V2

Some earlier V2 questions have now been answered in the decision docs. This section should only keep questions that are still materially unresolved.

### Resolved Direction

- **V1 graph compatibility**: Reflect V1 exports should produce a V2-compatible graph shape. Do not build a generalized Obsidian/folder import surface unless the portability premise changes.
- **Data model**: keep V2 note-first. Use readable markdown files, stable IDs, aliases, and case-insensitive backlink resolution.
- **Entities**: do not introduce a typed entity layer in the first wave. Canonical people, companies, projects, and other entities can emerge later as projections over notes and aliases.
- **AI model**: use BYOK/cloud generative AI first. Treat local generative models as a later possibility. Keep local embeddings separate from generative AI.
- **API and automation**: start with read/discovery CLI operations such as `reflect search`, `reflect show`, `reflect today`, and path lookup. Manual markdown edits are the write path. Do not introduce Reflect-hosted APIs for the V2 core product.
- **Tasks**: deferred from the first release; now planned as a post-release add-on (Plan 18). As decided here: lightweight markdown-backed projections (GFM checkboxes + a `tasks` table + a Tasks view) rather than a full task-management system.
- **Contacts and calendar**: defer as first-wave surfaces, but preserve them as future memory context for meetings, backlinks, daily notes, and AI.
- **Daily AI automation**: allow opt-in background extraction into reviewable suggestions. Do not silently mutate notes with summaries, entities, backlinks, or tasks.
- **Links**: basic Chrome link capture shipped (Plan 11: extension hands URL/title/selection/screenshot to the desktop app via the native host/inbox bridge; desktop owns BYOK AI and markdown/asset writes; no Reflect-hosted link-description API). Safari, mobile share targets, and full article clipping remain later work.
- **Audio**: **shipped in the first release** (ahead of the original deferral): raw-first audio memos with async BYOK cloud transcription, explicit privacy UX, and `private: true` cloud-processing lockouts.
- **Publishing and templates**: defer both. They should not block the first-wave editor, storage, search, sync, and AI foundation.

### Remaining Open Questions

1. What is the exact V1 migration path, and how much conversion fidelity is required?
2. What is the exact alias/frontmatter schema, and how should case-insensitive title or alias collisions be resolved?
3. What source-provenance schema should web, book, and audio captures use?
4. What template variable model should V2 use when templates return?
5. Which opt-in AI background extractions are safe enough to ship, and what review UI do they require?
6. How should sync, conflict resolution, and note history evolve beyond the GitHub-first adapter?

---

## 11. Source Map

These were the main Notion pages browsed and summarized.

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

## 12. Bottom Line for the V2 Agent

Reflect today is best understood as:

> An end-to-end encrypted personal memory graph centered on daily notes, backlinks, fast capture, and recall, extended through AI, search, integrations, audio transcription, publishing, tasks, and import/export.

The V2 rewrite should not start from a generic notes-app architecture. It should start from the constraints and promises that make Reflect distinct:

- Daily notes as time-based memory
- Backlinks as associative memory
- Minimal keyboard-first interface
- Trusted local-first, user-owned data
- Search as retrieval layer
- Capture from everywhere
- AI as an assistant over personal context
- Strong markdown-folder portability and user ownership

The highest-leverage V2 work is likely to be architectural, not cosmetic: unified ingestion, typed commands, better entity/backlink semantics, privacy-preserving AI/search, robust sync/history, and keeping the markdown graph easy to copy, inspect, and recover.
