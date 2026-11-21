-- When this device last opened each note, for the palette's Recent list.
-- DURABLE like chat_* (0008): not derived from markdown, so `index_clear` and
-- projection-wipe migrations must leave it alone. No FK to `notes`: a cascade
-- would empty it on every rebuild. Reads join `notes` to drop deleted paths.

CREATE TABLE note_visits (
  path TEXT PRIMARY KEY NOT NULL,
  visited_ms INTEGER NOT NULL
);

CREATE INDEX note_visits_visited ON note_visits(visited_ms);
