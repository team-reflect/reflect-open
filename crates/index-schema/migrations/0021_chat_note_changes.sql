-- AI note-write audit and recovery state. Like the existing chat tables these
-- rows are durable, device-local data: they are not derived from Markdown and
-- must survive projection rebuilds.

ALTER TABLE chat_messages ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read'
  CHECK (permission_mode IN ('read', 'readWrite'));

-- NULL means a legacy turn whose provenance was never recorded. The chat
-- history builder treats that as unknown instead of incorrectly assuming the
-- turn had no note or asset sources.
ALTER TABLE chat_messages ADD COLUMN source_provenance TEXT;

CREATE TABLE chat_note_changes (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  path TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  operation TEXT NOT NULL CHECK (operation IN ('edit', 'append', 'create')),
  before_source TEXT,
  after_source TEXT NOT NULL,
  before_revision TEXT,
  after_revision TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'applied', 'undoing', 'undone', 'failed', 'uncertain')),
  -- Native graph-session token backed by an OS advisory lease file. A
  -- prepared/undoing row is in flight while its owner lease is locked; an
  -- unlocked owner is abandoned recovery work and cannot block deletion.
  owner_session TEXT NOT NULL,
  error_message TEXT,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  UNIQUE(message_id, seq),
  UNIQUE(message_id, tool_call_id)
);

CREATE INDEX chat_note_changes_message ON chat_note_changes(message_id, seq);
CREATE INDEX chat_note_changes_recovery
  ON chat_note_changes(state, owner_session, created_ms);
