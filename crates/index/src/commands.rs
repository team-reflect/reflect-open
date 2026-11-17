//! The index commands: one method per `index_write` and `index_read` row of
//! the command table in `reflect_types::commands`, and the router from a
//! command name to its method.

use rusqlite::Connection;
use serde_json::{Map, Value};

use reflect_types::{
    AppError, AppResult, Backlink, BacklinkPage, BacklinkSourceCursor, ChatConversation,
    ChatMessageRow, ChunkHash, DailyNoteRow, EmbeddedChunk, GraphStats, IndexTouch, IndexedNote,
    MovedNoteAddress, NoteFileFacts, NoteId, NoteListEntry, NoteRow, PinnedNoteRow, RecentNoteRow,
    TagFacet, TaskRow, TemplateEntry, WikiClaimMatch, WikiTitleCandidate,
};

use crate::read;
use crate::session::{Applied, IndexSession};

/// Where a committed write is announced.
pub trait IndexEvents {
    /// Rows of the index changed.
    fn index_written(&self);

    /// The rows of the note at `from` moved to `to`.
    fn note_moved(&self, from: &str, to: &str);
}

/// The index commands of one session.
pub struct IndexCommands<'a> {
    session: &'a IndexSession,
    events: &'a dyn IndexEvents,
    read_generation: u64,
}

impl<'a> IndexCommands<'a> {
    /// `read_generation` is the reader generation that a read command is
    /// pinned to: [`IndexSession::read_generation`] at the time the command
    /// was issued.
    pub fn new(
        session: &'a IndexSession,
        events: &'a dyn IndexEvents,
        read_generation: u64,
    ) -> Self {
        Self {
            session,
            events,
            read_generation,
        }
    }

    fn read<T>(&self, body: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        self.session.read(self.read_generation, body)
    }

    fn announce(&self, applied: Applied) {
        if applied == Applied::Committed {
            self.events.index_written();
        }
    }

    /// Applies one note's projection in one transaction. A stale generation
    /// writes nothing.
    fn index_apply(&self, note: IndexedNote, generation: u64) -> AppResult<()> {
        self.announce(
            self.session
                .apply(generation, std::slice::from_ref(&note))?,
        );
        Ok(())
    }

    /// Applies many notes' projections in one transaction.
    fn index_apply_batch(&self, notes: Vec<IndexedNote>, generation: u64) -> AppResult<()> {
        self.announce(self.session.apply(generation, &notes)?);
        Ok(())
    }

    /// Removes a note and its embedding rows.
    fn index_remove(&self, path: String, generation: u64) -> AppResult<()> {
        self.announce(self.session.remove(generation, &path)?);
        Ok(())
    }

    /// Wipes all derived tables. Chat history stays.
    fn index_clear(&self, generation: u64) -> AppResult<()> {
        self.announce(self.session.clear(generation)?);
        Ok(())
    }

    /// Moves a note's projection rows only.
    fn index_move(
        &self,
        from: String,
        to: String,
        generation: u64,
        to_address: MovedNoteAddress,
    ) -> AppResult<()> {
        if self
            .session
            .move_rows(generation, &from, &to, &to_address)?
            == Applied::Committed
        {
            self.events.index_written();
            self.events.note_moved(&from, &to);
        }
        Ok(())
    }

    /// Re-stamps stored mtimes for notes whose content already matches disk.
    fn index_touch(&self, entries: Vec<IndexTouch>, generation: u64) -> AppResult<()> {
        self.session.touch(generation, &entries).map(drop)
    }

    /// Upserts one `index_meta` key.
    fn index_meta_set(&self, key: String, value: String, generation: u64) -> AppResult<()> {
        self.session.set_meta(generation, &key, &value).map(drop)
    }

    /// Upserts one chat message and its conversation row.
    fn chat_message_save(
        &self,
        conversation: ChatConversation,
        message: ChatMessageRow,
        generation: u64,
    ) -> AppResult<()> {
        self.session
            .save_chat_message(generation, &conversation, &message)
            .map(drop)
    }

    /// Deletes a conversation and its messages.
    fn chat_conversation_delete(&self, id: String, generation: u64) -> AppResult<()> {
        self.session
            .delete_chat_conversation(generation, &id)
            .map(drop)
    }

    /// Replaces a note's embedding chunk set.
    fn embed_apply(
        &self,
        path: String,
        chunks: Vec<EmbeddedChunk>,
        generation: u64,
    ) -> AppResult<()> {
        self.session
            .apply_embeddings(generation, &path, &chunks)
            .map(drop)
    }

    /// Drops a note's chunks and vectors.
    fn embed_remove(&self, path: String, generation: u64) -> AppResult<()> {
        self.session.remove_embeddings(generation, &path).map(drop)
    }

    /// The value of one `index_meta` key.
    fn index_meta_get(&self, key: String) -> AppResult<Option<String>> {
        self.read(|conn| read::meta::meta(conn, &key))
    }

    /// The aggregates of the graph, private notes excluded.
    fn index_graph_stats(&self, tag_limit: u32) -> AppResult<GraphStats> {
        self.read(|conn| read::stats::graph_stats(conn, tag_limit))
    }

    /// The row of the note at `path`.
    fn index_note(&self, path: String) -> AppResult<Option<NoteRow>> {
        self.read(|conn| read::notes::note(conn, &path))
    }

    /// Every pinned note, in shelf order.
    fn index_pinned_notes(&self) -> AppResult<Vec<PinnedNoteRow>> {
        self.read(read::notes::pinned_notes)
    }

    /// Every template, by folded title.
    fn index_templates(&self) -> AppResult<Vec<TemplateEntry>> {
        self.read(read::notes::templates)
    }

    /// The stored hash and mtime of each indexed path in `paths`.
    fn index_file_facts(&self, paths: Vec<String>) -> AppResult<Vec<NoteFileFacts>> {
        self.read(|conn| read::notes::file_facts(conn, &paths))
    }

    /// The frontmatter `id` of each indexed path in `paths`.
    fn index_note_ids(&self, paths: Vec<String>) -> AppResult<Vec<NoteId>> {
        self.read(|conn| read::notes::note_ids(conn, &paths))
    }

    /// The path of a uniformly random note.
    fn index_random_note(&self) -> AppResult<Option<String>> {
        self.read(read::notes::random_note)
    }

    /// Resolves a free-form note target to a path.
    fn index_resolve_target(
        &self,
        target: String,
        daily_path: Option<String>,
        key: String,
    ) -> AppResult<Option<String>> {
        self.read(|conn| read::notes::resolve_target(conn, &target, daily_path, &key))
    }

    /// Whether a note is indexed at `path`.
    fn index_path_taken(&self, path: String) -> AppResult<bool> {
        self.read(|conn| read::notes::path_taken(conn, &path))
    }

    /// The notes that reference any of `asset_paths`.
    fn index_asset_owners(&self, asset_paths: Vec<String>) -> AppResult<Vec<String>> {
        self.read(|conn| read::assets::note_paths(conn, &asset_paths))
    }

    /// The notes with the tag `tag_key` that carry any of `email_keys`.
    fn index_person_owners(
        &self,
        email_keys: Vec<String>,
        tag_key: String,
    ) -> AppResult<Vec<String>> {
        self.read(|conn| read::notes::person_owners(conn, &email_keys, &tag_key))
    }

    /// The path of every note that gets embeddings, ascending.
    fn index_embeddable_paths(&self) -> AppResult<Vec<String>> {
        self.read(read::notes::embeddable_paths)
    }

    /// The hash and model of each stored chunk of the note at `path`.
    fn embed_chunk_hashes(&self, path: String) -> AppResult<Vec<ChunkHash>> {
        self.read(|conn| read::embed::chunk_hashes(conn, &path))
    }

    /// The All Notes list: every note, or the notes and dailies with a tag.
    fn index_list_notes(&self, tag_key: Option<String>) -> AppResult<Vec<NoteListEntry>> {
        self.read(|conn| read::lists::list_notes(conn, tag_key.as_deref()))
    }

    /// The most recently changed non-private notes.
    fn index_recent_notes(
        &self,
        limit: u32,
        tag_key: Option<String>,
    ) -> AppResult<Vec<RecentNoteRow>> {
        self.read(|conn| read::lists::recent_notes(conn, limit, tag_key.as_deref()))
    }

    /// The tag facets over non-daily notes, by tag key.
    fn index_note_tags(&self) -> AppResult<Vec<TagFacet>> {
        self.read(read::lists::note_tags)
    }

    /// The open or the completed tasks of every note but templates.
    fn index_tasks(&self, checked: bool) -> AppResult<Vec<TaskRow>> {
        self.read(|conn| read::tasks::tasks(conn, checked))
    }

    /// The note that wins the wiki key `key`.
    fn index_resolve_wiki(&self, key: String) -> AppResult<Option<String>> {
        self.read(|conn| read::wiki::resolve(conn, &key))
    }

    /// The notes that claim `key` in its strongest tier.
    fn index_wiki_target_match(&self, key: String) -> AppResult<Option<WikiClaimMatch>> {
        self.read(|conn| read::wiki::claim_match(conn, &key))
    }

    /// The notes whose folded path is `path_key`, by path.
    fn index_notes_by_path_key(&self, path_key: String) -> AppResult<Vec<String>> {
        self.read(|conn| read::wiki::notes_by_path_key(conn, &path_key))
    }

    /// The notes with a link to the wiki key `target_key`, by path.
    fn index_link_sources(&self, target_key: String) -> AppResult<Vec<String>> {
        self.read(|conn| read::wiki::link_sources(conn, &target_key))
    }

    /// The notes with a link to the folded path `target_path_key`, by path.
    fn index_path_link_sources(&self, target_path_key: String) -> AppResult<Vec<String>> {
        self.read(|conn| read::wiki::path_link_sources(conn, &target_path_key))
    }

    /// The note at `path` as a suggestion candidate; templates have none.
    fn index_wiki_address_note(&self, path: String) -> AppResult<Option<WikiTitleCandidate>> {
        self.read(|conn| read::wiki::address_note(conn, &path))
    }

    /// Every link that points at the note at `path`, by source path.
    fn index_backlinks(&self, path: String) -> AppResult<Vec<Backlink>> {
        self.read(|conn| read::backlinks::backlinks(conn, &path))
    }

    /// One page of the sources that link to the note at `path`.
    fn index_backlink_page(
        &self,
        path: String,
        limit: i64,
        cursor: Option<BacklinkSourceCursor>,
    ) -> AppResult<BacklinkPage> {
        self.read(|conn| read::backlinks::page(conn, &path, limit, cursor.as_ref()))
    }

    /// The dates in `start..=end` whose daily note has content, ascending.
    fn index_daily_dates(&self, start: String, end: String) -> AppResult<Vec<String>> {
        self.read(|conn| read::daily::dates_in_range(conn, &start, &end))
    }

    /// The non-private daily notes in `start..=end`, newest first.
    fn index_daily_notes(
        &self,
        start: String,
        end: String,
        limit: u32,
    ) -> AppResult<Vec<DailyNoteRow>> {
        self.read(|conn| read::daily::notes_in_range(conn, &start, &end, limit))
    }

    /// The most recently active conversations first.
    fn chat_conversations(&self, limit: u32) -> AppResult<Vec<ChatConversation>> {
        self.read(|conn| read::chat::conversations(conn, limit))
    }

    /// The messages of one conversation, in order.
    fn chat_messages(&self, conversation_id: String) -> AppResult<Vec<ChatMessageRow>> {
        self.read(|conn| read::chat::messages(conn, &conversation_id))
    }

    /// Executes a read query that the frontend compiled with Kysely.
    fn db_query(&self, sql: String, params: Vec<Value>) -> AppResult<Vec<Map<String, Value>>> {
        self.session.query(self.read_generation, &sql, &params)
    }
}

/// Defines the command lists and [`IndexCommands::dispatch`] from the
/// `index_write` and `index_read` rows of the command table.
macro_rules! index_dispatch {
    (
        core { $( $core:tt )* }
        index_write { $( $write:ident ( $( $write_arg:ident : $write_ty:ty ),* ) -> $write_ret:ty ),* $(,)? }
        index_read { $( $read:ident ( $( $read_arg:ident : $read_ty:ty ),* ) -> $read_ret:ty ),* $(,)? }
        desktop { $( $desktop:tt )* }
        shell { $( $shell:tt )* }
    ) => {
        /// The commands that write the index.
        pub const INDEX_WRITE_COMMANDS: &[&str] = &[$( stringify!($write) ),*];

        /// The commands that read the index.
        pub const INDEX_READ_COMMANDS: &[&str] = &[$( stringify!($read) ),*];

        impl IndexCommands<'_> {
            /// Runs `command` with `args_json`, a JSON object of camelCase
            /// arguments. The reply is JSON text.
            pub fn dispatch(&self, command: &str, args_json: &[u8]) -> AppResult<String> {
                match command {
                    $( stringify!($write) => {
                        let reflect_types::commands::$write::Args { $( $write_arg ),* } =
                            parse_args(command, args_json)?;
                        let value: reflect_types::commands::$write::Result =
                            self.$write($( $write_arg ),*)?;
                        json_reply(&value)
                    } )*
                    $( stringify!($read) => {
                        let reflect_types::commands::$read::Args { $( $read_arg ),* } =
                            parse_args(command, args_json)?;
                        let value: reflect_types::commands::$read::Result =
                            self.$read($( $read_arg ),*)?;
                        json_reply(&value)
                    } )*
                    other => Err(AppError::not_found(format!("unknown command: {other}"))),
                }
            }
        }
    };
}

reflect_types::commands!(index_dispatch);

/// Whether [`IndexCommands::dispatch`] has `command`.
pub fn is_index_command(command: &str) -> bool {
    INDEX_WRITE_COMMANDS.contains(&command) || INDEX_READ_COMMANDS.contains(&command)
}

fn parse_args<T: serde::de::DeserializeOwned>(command: &str, args_json: &[u8]) -> AppResult<T> {
    serde_json::from_slice(args_json)
        .map_err(|err| AppError::parse(format!("invalid arguments for {command}: {err}")))
}

fn json_reply<T: serde::Serialize>(value: &T) -> AppResult<String> {
    serde_json::to_string(value).map_err(|err| AppError::io(err.to_string()))
}
