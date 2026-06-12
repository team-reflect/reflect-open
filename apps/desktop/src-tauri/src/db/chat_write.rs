//! The chat history write path: conversation + message upserts.
//!
//! Unlike every other table in the index, `chat_conversations`/`chat_messages`
//! are **durable** — chat history is not derived from markdown and cannot be
//! rebuilt, so `clear_index` and projection-wipe migrations must leave these
//! rows alone. Mutations are plain functions over a [`Connection`]; the
//! command layer ([`super`]) owns transactions and generation gating.

use rusqlite::{params, Connection};
use serde::Deserialize;

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
    pub(super) seq: i64,
    pub(super) user_text: String,
    pub(super) attachments: String,
    pub(super) parts: String,
    pub(super) response_messages: String,
    pub(super) created_ms: i64,
}

/// Upsert the conversation row and the message row. The conversation keeps its
/// original `title`/`created_ms` (set once, on insert) and bumps `updated_ms`;
/// the message updates by **primary key** — deliberately not `INSERT OR
/// REPLACE`, which deletes any row violating *any* unique constraint, so a
/// `(conversation_id, seq)` collision would silently destroy a different turn.
/// With `ON CONFLICT(id)` such a collision fails loudly instead.
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
            response_messages, created_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            user_text = excluded.user_text,
            attachments = excluded.attachments,
            parts = excluded.parts,
            response_messages = excluded.response_messages",
    )?
    .execute(params![
        message.id,
        message.conversation_id,
        message.seq,
        message.user_text,
        message.attachments,
        message.parts,
        message.response_messages,
        message.created_ms,
    ])?;
    Ok(())
}

/// Delete a conversation; its messages cascade.
pub(super) fn delete_conversation(conn: &Connection, id: &str) -> AppResult<()> {
    conn.prepare_cached("DELETE FROM chat_conversations WHERE id = ?1")?
        .execute(params![id])?;
    Ok(())
}
