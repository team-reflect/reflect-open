-- Emails a note owns through `- Email:` contact-field bullets (v1's person
-- template shape, also written by the contacts integration and the meeting
-- flow's person-note pre-fill). A pure projection like tags/aliases: rebuilt
-- per note write, ON DELETE CASCADE, moved explicitly on rename, rebuildable —
-- nothing durable here, so no chat_* concerns.
--
-- This is the substrate for attendee → person-note resolution in the calendar
-- flow: an invite email finds the note that owns it even when the calendar's
-- display name (often the bare address) doesn't match the note title.
CREATE TABLE note_emails (
  note_path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
  email     TEXT NOT NULL,
  email_key TEXT NOT NULL,
  PRIMARY KEY (note_path, email_key)
);

-- Resolution looks up by address and joins to notes for the title; the
-- covering key index serves that read directly.
CREATE INDEX note_emails_email_key ON note_emails(email_key);
