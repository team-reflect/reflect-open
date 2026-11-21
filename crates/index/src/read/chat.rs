//! Reads of the durable `chat_*` tables.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Order, Query};

use reflect_types::{AppResult, ChatConversation, ChatMessageRow};

use crate::schema::{ChatConversations, ChatMessages};
use crate::sql;

/// The most recently active conversations first, at most `limit`.
pub(crate) fn conversations(conn: &Connection, limit: u32) -> AppResult<Vec<ChatConversation>> {
    sql::query(
        conn,
        Query::select()
            .columns([
                ChatConversations::Id,
                ChatConversations::Title,
                ChatConversations::CreatedMs,
                ChatConversations::UpdatedMs,
            ])
            .from(ChatConversations::Table)
            .order_by(ChatConversations::UpdatedMs, Order::Desc)
            .limit(u64::from(limit)),
        |row| {
            Ok(ChatConversation {
                id: row.get(0)?,
                title: row.get(1)?,
                created_ms: row.get(2)?,
                updated_ms: row.get(3)?,
            })
        },
    )
}

/// The messages of one conversation, in `seq` order. The JSON columns stay
/// text: the frontend owns their shapes.
pub(crate) fn messages(conn: &Connection, conversation_id: &str) -> AppResult<Vec<ChatMessageRow>> {
    sql::query(
        conn,
        Query::select()
            .columns([
                ChatMessages::Id,
                ChatMessages::ConversationId,
                ChatMessages::UserText,
                ChatMessages::Attachments,
                ChatMessages::Parts,
                ChatMessages::ResponseMessages,
                ChatMessages::CreatedMs,
            ])
            .from(ChatMessages::Table)
            .and_where(Expr::col(ChatMessages::ConversationId).eq(conversation_id))
            .order_by(ChatMessages::Seq, Order::Asc),
        |row| {
            Ok(ChatMessageRow {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                user_text: row.get(2)?,
                attachments: row.get(3)?,
                parts: row.get(4)?,
                response_messages: row.get(5)?,
                created_ms: row.get(6)?,
            })
        },
    )
}
