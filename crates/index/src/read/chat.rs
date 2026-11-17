//! Reads of the durable `chat_*` tables.

use rusqlite::Connection;

use reflect_types::{AppResult, ChatConversation, ChatMessageRow};

/// The most recently active conversations first, at most `limit`.
pub(crate) fn conversations(conn: &Connection, limit: u32) -> AppResult<Vec<ChatConversation>> {
    let conversations = conn
        .prepare_cached(
            "SELECT id, title, created_ms, updated_ms FROM chat_conversations
             ORDER BY updated_ms DESC
             LIMIT ?1",
        )?
        .query_map([limit], |row| {
            Ok(ChatConversation {
                id: row.get(0)?,
                title: row.get(1)?,
                created_ms: row.get(2)?,
                updated_ms: row.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(conversations)
}

/// The messages of one conversation, in `seq` order. The JSON columns stay
/// text: the frontend owns their shapes.
pub(crate) fn messages(conn: &Connection, conversation_id: &str) -> AppResult<Vec<ChatMessageRow>> {
    let messages = conn
        .prepare_cached(
            "SELECT id, conversation_id, user_text, attachments, parts, response_messages, created_ms
             FROM chat_messages
             WHERE conversation_id = ?1
             ORDER BY seq",
        )?
        .query_map([conversation_id], |row| {
            Ok(ChatMessageRow {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                user_text: row.get(2)?,
                attachments: row.get(3)?,
                parts: row.get(4)?,
                response_messages: row.get(5)?,
                created_ms: row.get(6)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(messages)
}
