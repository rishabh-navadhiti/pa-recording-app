'use strict'

// Single source for every regex used to classify claude / ElevenLabs / Python
// child-process output. Previously duplicated 6× across the spawn functions.
//
// Two distinct rate-limit regexes — keep them separate:
//   CLAUDE_RATE_LIMITED   → Claude CLI stdout/stderr
//   ELEVENLABS_RATE_LIMITED → ElevenLabs transcription stderr

/** Claude CLI / Anthropic rate-limit / overload signals. */
const CLAUDE_RATE_LIMITED = /rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i

/** ElevenLabs API rate-limit / quota signals (transcription stderr). */
const ELEVENLABS_RATE_LIMITED = /429|quota.exceeded|rate.limit|insufficient.credit/i

/**
 * MCP connector auth / connection failure signals (ICD-10 connector).
 * Matches "Needs authentication", bare 401, or MCP connect/refuse errors.
 * NOTE: the pattern is deliberately anchored to MCP context to avoid
 * false-positives on clinical notes that mention "401" or "unauthorized".
 */
const MCP_AUTH_ERROR = /Needs authentication|unauthorized|\b401\b|MCP.*(connect|connection).*(fail|error|refused)/i

/** ElevenLabs API key invalid (401 / unauthorized on transcription). */
const ELEVENLABS_AUTH_ERROR = /401|invalid\.api\.key|unauthorized/i

/** record.py stdout — audio duration after WAV→MP3 conversion. */
const DURATION_SECONDS = /DURATION_SECONDS:\s*([\d.]+)/

/** edit-note skill output — path of the backup created before overwrite. */
const BACKUP_OK = /BACKUP_OK:\s*(.+)/

module.exports = {
  CLAUDE_RATE_LIMITED,
  ELEVENLABS_RATE_LIMITED,
  MCP_AUTH_ERROR,
  ELEVENLABS_AUTH_ERROR,
  DURATION_SECONDS,
  BACKUP_OK,
}
