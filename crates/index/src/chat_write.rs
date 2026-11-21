//! The chat history write path: conversation + message upserts.
//!
//! Unlike every other table in the index, `chat_conversations`/`chat_messages`
//! are **durable** — chat history is not derived from markdown and cannot be
//! rebuilt, so `clear_index` and projection-wipe migrations must leave these
//! rows alone. Mutations are plain functions over a [`Connection`]; the
//! command layer ([`super`]) owns transactions and generation gating.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Func, OnConflict, Query};

use reflect_types::{AppResult, ChatConversation, ChatMessageRow};

use crate::schema::{ChatConversations, ChatMessages};
use crate::sql::{self, lit};

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
    sql::execute(
        conn,
        Query::insert()
            .into_table(ChatConversations::Table)
            .columns([
                ChatConversations::Id,
                ChatConversations::Title,
                ChatConversations::CreatedMs,
                ChatConversations::UpdatedMs,
            ])
            .values_panic([
                conversation.id.as_str().into(),
                conversation.title.as_str().into(),
                conversation.created_ms.into(),
                conversation.updated_ms.into(),
            ])
            .on_conflict(
                OnConflict::column(ChatConversations::Id)
                    .update_column(ChatConversations::UpdatedMs)
                    .to_owned(),
            ),
    )?;
    let conversation_id = message.conversation_id.as_str();
    let next_seq = Query::select()
        .expr(Func::coalesce([
            Expr::col(ChatMessages::Seq).max().add(lit(1)),
            lit(0),
        ]))
        .from(ChatMessages::Table)
        .and_where(Expr::col(ChatMessages::ConversationId).eq(conversation_id))
        .take();
    sql::execute(
        conn,
        Query::insert()
            .into_table(ChatMessages::Table)
            .columns([
                ChatMessages::Id,
                ChatMessages::ConversationId,
                ChatMessages::Seq,
                ChatMessages::UserText,
                ChatMessages::Attachments,
                ChatMessages::Parts,
                ChatMessages::ResponseMessages,
                ChatMessages::CreatedMs,
            ])
            .values_panic([
                message.id.as_str().into(),
                conversation_id.into(),
                next_seq.into(),
                message.user_text.as_str().into(),
                message.attachments.as_str().into(),
                message.parts.as_str().into(),
                message.response_messages.as_str().into(),
                message.created_ms.into(),
            ])
            .on_conflict(
                OnConflict::column(ChatMessages::Id)
                    .update_columns([
                        ChatMessages::UserText,
                        ChatMessages::Attachments,
                        ChatMessages::Parts,
                        ChatMessages::ResponseMessages,
                    ])
                    .to_owned(),
            ),
    )?;
    Ok(())
}

/// Delete a conversation; its messages cascade.
pub(super) fn delete_conversation(conn: &Connection, id: &str) -> AppResult<()> {
    sql::execute(
        conn,
        Query::delete()
            .from_table(ChatConversations::Table)
            .and_where(Expr::col(ChatConversations::Id).eq(id)),
    )?;
    Ok(())
}
