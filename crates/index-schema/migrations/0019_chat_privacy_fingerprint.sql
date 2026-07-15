-- A settled chat turn may be resent only while the live set of private or
-- privacy-uncertain notes matches the set captured when the turn was sent.
-- Existing rows remain NULL and therefore fail closed for model history.
ALTER TABLE chat_messages ADD COLUMN privacy_fingerprint TEXT;
