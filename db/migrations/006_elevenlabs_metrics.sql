-- ElevenLabs per-call metrics on processing_events.
ALTER TABLE processing_events ADD COLUMN transcript_language      TEXT;
ALTER TABLE processing_events ADD COLUMN transcript_speaker_count INTEGER;

PRAGMA user_version = 6;
