-- Rename audio_duration_seconds (REAL) to audio_duration (TEXT) to store hh:mm:ss format.
ALTER TABLE cases RENAME COLUMN audio_duration_seconds TO audio_duration;

PRAGMA user_version = 2;
