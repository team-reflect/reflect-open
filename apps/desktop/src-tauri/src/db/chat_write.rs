//! Durable chat history and AI note-change journal writes.
//!
//! Unlike every other table in the index, `chat_conversations`/`chat_messages`
//! are **durable** — chat history is not derived from markdown and cannot be
//! rebuilt, so `clear_index` and projection-wipe migrations must leave these
//! rows alone. Mutations are plain functions over a [`Connection`]; the
//! command layer ([`super`]) owns transactions and generation gating.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// A conversation's metadata, sent with every message save so the row can be
/// created lazily on the first message. Mirrors the zod contract in
/// `packages/core/src/ai/chat/store.ts` field-for-field.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatConversation {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) created_ms: i64,
    pub(super) updated_ms: i64,
}

/// One persisted exchange: the user message and everything the assistant did
/// in response. The JSON columns are opaque strings here — the TS store owns
/// their shapes and validates them on read.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRow {
    pub(super) id: String,
    pub(super) conversation_id: String,
    pub(super) user_text: String,
    pub(super) attachments: String,
    pub(super) parts: String,
    pub(super) response_messages: String,
    #[serde(default = "default_permission_mode")]
    pub(super) permission_mode: String,
    pub(super) source_provenance: Option<String>,
    pub(super) created_ms: i64,
}

fn default_permission_mode() -> String {
    "read".to_string()
}

/// Upsert the conversation row and the message row. The conversation keeps its
/// original `title`/`created_ms` (set once, on insert) and bumps `updated_ms`;
/// the message updates by **primary key** — deliberately not `INSERT OR
/// REPLACE`, which deletes any row violating *any* unique constraint and would
/// silently destroy another turn on a `(conversation_id, seq)` collision.
///
/// `seq` is assigned **here**, inside the insert (`MAX(seq) + 1` over the
/// conversation), never by the caller: the frontend's view of a conversation
/// can undercount the table (the read path drops rows it cannot parse), so a
/// TS-derived counter could collide with a row it never saw. A settle-time
/// re-save conflicts on `id` and leaves `seq` untouched.
pub(super) fn save_message(
    conn: &Connection,
    conversation: &ChatConversation,
    message: &ChatMessageRow,
) -> AppResult<()> {
    conn.prepare_cached(
        "INSERT INTO chat_conversations(id, title, created_ms, updated_ms)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET updated_ms = excluded.updated_ms",
    )?
    .execute(params![
        conversation.id,
        conversation.title,
        conversation.created_ms,
        conversation.updated_ms,
    ])?;
    conn.prepare_cached(
        "INSERT INTO chat_messages(
            id, conversation_id, seq, user_text, attachments, parts,
            response_messages, permission_mode, source_provenance, created_ms)
         VALUES (
            ?1, ?2,
            (SELECT COALESCE(MAX(seq) + 1, 0) FROM chat_messages WHERE conversation_id = ?2),
            ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            user_text = excluded.user_text,
            attachments = excluded.attachments,
            parts = excluded.parts,
            response_messages = excluded.response_messages,
            permission_mode = excluded.permission_mode,
            source_provenance = excluded.source_provenance",
    )?
    .execute(params![
        message.id,
        message.conversation_id,
        message.user_text,
        message.attachments,
        message.parts,
        message.response_messages,
        message.permission_mode,
        message.source_provenance,
        message.created_ms,
    ])?;
    Ok(())
}

/// The note mutation represented by one journal row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatNoteChangeOperation {
    Edit,
    Append,
    Create,
}

impl ChatNoteChangeOperation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Edit => "edit",
            Self::Append => "append",
            Self::Create => "create",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "edit" => Ok(Self::Edit),
            "append" => Ok(Self::Append),
            "create" => Ok(Self::Create),
            _ => Err(crate::error::AppError::io(format!(
                "invalid chat note change operation: {value}"
            ))),
        }
    }
}

/// Durable lifecycle of a journaled mutation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatNoteChangeState {
    Prepared,
    Applied,
    Undoing,
    Undone,
    Failed,
    Uncertain,
}

impl ChatNoteChangeState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Prepared => "prepared",
            Self::Applied => "applied",
            Self::Undoing => "undoing",
            Self::Undone => "undone",
            Self::Failed => "failed",
            Self::Uncertain => "uncertain",
        }
    }

    fn parse(value: &str) -> AppResult<Self> {
        match value {
            "prepared" => Ok(Self::Prepared),
            "applied" => Ok(Self::Applied),
            "undoing" => Ok(Self::Undoing),
            "undone" => Ok(Self::Undone),
            "failed" => Ok(Self::Failed),
            "uncertain" => Ok(Self::Uncertain),
            _ => Err(crate::error::AppError::io(format!(
                "invalid chat note change state: {value}"
            ))),
        }
    }

    fn can_transition_to(self, next: Self) -> bool {
        self == next
            || matches!(
                (self, next),
                (
                    Self::Prepared,
                    Self::Applied | Self::Failed | Self::Uncertain
                ) | (Self::Applied, Self::Undoing | Self::Uncertain)
                    | (
                        Self::Undoing,
                        Self::Undone | Self::Applied | Self::Uncertain
                    )
                    | (Self::Uncertain, Self::Applied | Self::Failed | Self::Undone)
            )
    }
}

/// Input persisted before an AI-driven filesystem or editor mutation begins.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatNoteChangeInput {
    pub(super) id: String,
    pub(super) conversation_id: String,
    pub(super) turn_id: String,
    pub(super) tool_call_id: String,
    pub(super) path: String,
    pub(super) sequence: i64,
    pub(super) operation: ChatNoteChangeOperation,
    pub(super) before_source: Option<String>,
    pub(super) after_source: String,
    pub(super) before_revision: Option<String>,
    pub(super) after_revision: String,
    pub(super) created_ms: i64,
}

/// One durable checkpoint returned to the frontend for review or recovery.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatNoteChangeRow {
    pub id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    pub path: String,
    pub sequence: i64,
    pub operation: ChatNoteChangeOperation,
    pub before_source: Option<String>,
    pub after_source: String,
    pub before_revision: Option<String>,
    pub after_revision: String,
    pub state: ChatNoteChangeState,
    pub error_message: Option<String>,
    pub created_ms: i64,
    pub updated_ms: i64,
}

fn row_from_sql(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatNoteChangeRow> {
    let operation: String = row.get(6)?;
    let state: String = row.get(11)?;
    let operation = ChatNoteChangeOperation::parse(&operation).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            6,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other(format!("{error:?}"))),
        )
    })?;
    let state = ChatNoteChangeState::parse(&state).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            11,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other(format!("{error:?}"))),
        )
    })?;
    Ok(ChatNoteChangeRow {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        turn_id: row.get(2)?,
        tool_call_id: row.get(3)?,
        path: row.get(4)?,
        sequence: row.get(5)?,
        operation,
        before_source: row.get(7)?,
        after_source: row.get(8)?,
        before_revision: row.get(9)?,
        after_revision: row.get(10)?,
        state,
        error_message: row.get(12)?,
        created_ms: row.get(13)?,
        updated_ms: row.get(14)?,
    })
}

const CHANGE_COLUMNS: &str =
    "id, conversation_id, message_id, tool_call_id, path, seq, operation, \
     before_source, after_source, before_revision, after_revision, state, \
     error_message, created_ms, updated_ms";

fn load_change(conn: &Connection, id: &str) -> AppResult<Option<ChatNoteChangeRow>> {
    let sql = format!("SELECT {CHANGE_COLUMNS} FROM chat_note_changes WHERE id = ?1");
    Ok(conn
        .prepare_cached(&sql)?
        .query_row(params![id], row_from_sql)
        .optional()?)
}

fn input_matches_row(input: &ChatNoteChangeInput, row: &ChatNoteChangeRow) -> bool {
    input.id == row.id
        && input.conversation_id == row.conversation_id
        && input.turn_id == row.turn_id
        && input.tool_call_id == row.tool_call_id
        && input.path == row.path
        && input.sequence == row.sequence
        && input.operation == row.operation
        && input.before_source == row.before_source
        && input.after_source == row.after_source
        && input.before_revision == row.before_revision
        && input.after_revision == row.after_revision
        && input.created_ms == row.created_ms
}

/// Persist an immutable prepared checkpoint. Retrying the identical input is
/// idempotent; reusing an id for different source bytes fails loudly.
pub(super) fn prepare_note_change(
    conn: &Connection,
    input: &ChatNoteChangeInput,
    owner_session: &str,
) -> AppResult<ChatNoteChangeRow> {
    let belongs_to_conversation: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM chat_messages WHERE id = ?1 AND conversation_id = ?2)",
        params![input.turn_id, input.conversation_id],
        |row| row.get(0),
    )?;
    if !belongs_to_conversation {
        return Err(crate::error::AppError::not_found(format!(
            "chat message {} does not belong to conversation {}",
            input.turn_id, input.conversation_id
        )));
    }
    conn.prepare_cached(
        "INSERT INTO chat_note_changes(
            id, conversation_id, message_id, tool_call_id, path, seq, operation,
            before_source, after_source, before_revision, after_revision, state,
            owner_session, error_message, created_ms, updated_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'prepared', ?12, NULL, ?13, ?14)
         ON CONFLICT(id) DO NOTHING",
    )?
    .execute(params![
        input.id,
        input.conversation_id,
        input.turn_id,
        input.tool_call_id,
        input.path,
        input.sequence,
        input.operation.as_str(),
        input.before_source,
        input.after_source,
        input.before_revision,
        input.after_revision,
        owner_session,
        input.created_ms,
        input.created_ms,
    ])?;
    let row = load_change(conn, &input.id)?.ok_or_else(|| {
        crate::error::AppError::io(format!("failed to persist chat note change {}", input.id))
    })?;
    if !input_matches_row(input, &row) {
        return Err(crate::error::AppError::io(format!(
            "chat note change id {} was reused with different contents",
            input.id
        )));
    }
    let stored_owner: String = conn.query_row(
        "SELECT owner_session FROM chat_note_changes WHERE id = ?1",
        params![input.id],
        |sql_row| sql_row.get(0),
    )?;
    if stored_owner != owner_session {
        return Err(crate::error::AppError::io(format!(
            "chat note change {} belongs to another graph session; recover it before retrying",
            input.id
        )));
    }
    Ok(row)
}

/// Result of a compare-and-transition journal update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum ChatNoteChangeUpdateOutcome {
    Updated { change: ChatNoteChangeRow },
    StateMismatch { change: ChatNoteChangeRow },
    Missing,
}

pub(super) fn set_note_change_state(
    conn: &Connection,
    id: &str,
    expected_state: ChatNoteChangeState,
    state: ChatNoteChangeState,
    error_message: Option<&str>,
    updated_ms: i64,
    owner_session: &str,
) -> AppResult<ChatNoteChangeUpdateOutcome> {
    if !expected_state.can_transition_to(state) {
        return Err(crate::error::AppError::io(format!(
            "invalid chat note change transition: {} -> {}",
            expected_state.as_str(),
            state.as_str()
        )));
    }
    let changed = conn
        .prepare_cached(
            "UPDATE chat_note_changes
             SET state = ?3,
                 owner_session = CASE WHEN ?3 = 'undoing' THEN ?6 ELSE owner_session END,
                 error_message = ?4,
                 updated_ms = ?5
             WHERE id = ?1 AND state = ?2",
        )?
        .execute(params![
            id,
            expected_state.as_str(),
            state.as_str(),
            error_message,
            updated_ms,
            owner_session,
        ])?;
    let Some(change) = load_change(conn, id)? else {
        return Ok(ChatNoteChangeUpdateOutcome::Missing);
    };
    if changed == 1 {
        Ok(ChatNoteChangeUpdateOutcome::Updated { change })
    } else {
        Ok(ChatNoteChangeUpdateOutcome::StateMismatch { change })
    }
}

/// All-or-none compare-and-transition result for a group of journal rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum ChatNoteChangesUpdateOutcome {
    Updated { changes: Vec<ChatNoteChangeRow> },
    StateMismatch { changes: Vec<ChatNoteChangeRow> },
    Missing { missing_ids: Vec<String> },
}

/// Atomically claim or finish every row in an Undo group. The caller's
/// transaction makes the read/check/update sequence all-or-none.
pub(super) fn set_note_changes_state(
    conn: &Connection,
    ids: &[String],
    expected_state: ChatNoteChangeState,
    state: ChatNoteChangeState,
    error_message: Option<&str>,
    updated_ms: i64,
    owner_session: &str,
) -> AppResult<ChatNoteChangesUpdateOutcome> {
    if ids.is_empty() {
        return Err(crate::error::AppError::io(
            "chat note change batch must not be empty",
        ));
    }
    let unique: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    if unique.len() != ids.len() {
        return Err(crate::error::AppError::io(
            "chat note change batch contains duplicate ids",
        ));
    }
    if !expected_state.can_transition_to(state) {
        return Err(crate::error::AppError::io(format!(
            "invalid chat note change transition: {} -> {}",
            expected_state.as_str(),
            state.as_str()
        )));
    }

    let mut changes = Vec::with_capacity(ids.len());
    let mut missing_ids = Vec::new();
    for id in ids {
        match load_change(conn, id)? {
            Some(change) => changes.push(change),
            None => missing_ids.push(id.clone()),
        }
    }
    if !missing_ids.is_empty() {
        return Ok(ChatNoteChangesUpdateOutcome::Missing { missing_ids });
    }
    if changes.iter().any(|change| change.state != expected_state) {
        return Ok(ChatNoteChangesUpdateOutcome::StateMismatch { changes });
    }

    for id in ids {
        let changed = conn
            .prepare_cached(
                "UPDATE chat_note_changes
                 SET state = ?2,
                     owner_session = CASE WHEN ?2 = 'undoing' THEN ?5 ELSE owner_session END,
                     error_message = ?3,
                     updated_ms = ?4
                 WHERE id = ?1 AND state = ?6",
            )?
            .execute(params![
                id,
                state.as_str(),
                error_message,
                updated_ms,
                owner_session,
                expected_state.as_str(),
            ])?;
        if changed != 1 {
            return Err(crate::error::AppError::io(format!(
                "chat note change {id} changed during an atomic batch transition"
            )));
        }
    }
    let updated = ids
        .iter()
        .map(|id| {
            load_change(conn, id)?.ok_or_else(|| {
                crate::error::AppError::io(format!(
                    "chat note change {id} disappeared during batch transition"
                ))
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(ChatNoteChangesUpdateOutcome::Updated { changes: updated })
}

pub(super) fn note_changes_for_message(
    conn: &Connection,
    message_id: &str,
) -> AppResult<Vec<ChatNoteChangeRow>> {
    let sql = format!(
        "SELECT {CHANGE_COLUMNS} FROM chat_note_changes WHERE message_id = ?1 ORDER BY seq"
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let rows = statement.query_map(params![message_id], row_from_sql)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(super) fn pending_note_changes(
    conn: &Connection,
    mut owner_is_live: impl FnMut(&str) -> bool,
) -> AppResult<Vec<ChatNoteChangeRow>> {
    let sql = format!(
        "SELECT {CHANGE_COLUMNS}, owner_session FROM chat_note_changes \
         WHERE state IN ('prepared', 'undoing', 'uncertain') \
         ORDER BY created_ms, message_id, seq"
    );
    let mut statement = conn.prepare_cached(&sql)?;
    let rows = statement.query_map([], |row| {
        Ok((row_from_sql(row)?, row.get::<_, String>(15)?))
    })?;
    let candidates = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(candidates
        .into_iter()
        .filter_map(|(change, owner)| {
            (change.state == ChatNoteChangeState::Uncertain || !owner_is_live(&owner))
                .then_some(change)
        })
        .collect())
}

/// Delete a conversation; its messages cascade.
pub(super) fn delete_conversation(
    conn: &Connection,
    id: &str,
    mut owner_is_live: impl FnMut(&str) -> bool,
) -> AppResult<()> {
    let mut statement = conn.prepare_cached(
        "SELECT DISTINCT owner_session FROM chat_note_changes
         WHERE conversation_id = ?1 AND state IN ('prepared', 'undoing')",
    )?;
    let owners = statement
        .query_map(params![id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    if owners.iter().any(|owner| owner_is_live(owner)) {
        return Err(crate::error::AppError::io(
            "conversation has unfinished note changes",
        ));
    }
    conn.prepare_cached("DELETE FROM chat_conversations WHERE id = ?1")?
        .execute(params![id])?;
    Ok(())
}
