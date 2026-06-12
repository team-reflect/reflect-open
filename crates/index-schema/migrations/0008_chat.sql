-- Chat history (Plan 10 follow-up): conversations and their turns, persisted
-- so chats survive relaunches. UNLIKE every other table in this database,
-- these rows are DURABLE — they are not derived from markdown and cannot be
-- rebuilt. `index_clear` and future projection-wipe migrations must leave
-- `chat_conversations` / `chat_messages` untouched.

CREATE TABLE chat_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  -- First user message, truncated; set once at creation.
  title TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

-- One row per exchange: the user message and everything the assistant did in
-- response (matching the engine's settle granularity). The JSON columns are
-- opaque here — the TS layer owns their shapes and validates on read.
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  user_text TEXT NOT NULL,
  attachments TEXT NOT NULL,        -- JSON ChatAttachment[]
  parts TEXT NOT NULL,              -- JSON AssistantPart[]
  response_messages TEXT NOT NULL,  -- JSON ChatModelMessage[]
  created_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX chat_messages_conversation_seq ON chat_messages(conversation_id, seq);
CREATE INDEX chat_conversations_updated ON chat_conversations(updated_ms);
