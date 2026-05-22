# Analytics opportunities

A running catalogue of things we *could* measure once the SQLite state store (and later phases) ship. **Nothing here is built.** Treat this as a parking lot — pick from it when there's time and the underlying data exists.

Organised by theme, not by table. Each entry anchors to a data source so it's clear whether the data already exists or needs new instrumentation.

---

## Volume & throughput

- **Cases per day / week / month.** Pure activity baseline; simplest "is the app being used?" answer.
- **Cases per session.** How productive a scribe is per Start→Stop cycle. Median over mean — one massive session distorts the average.
- **Cases per doctor.** Who's the heaviest user; spotlights doctors whose template investment pays back the most.
- **Active doctors per period.** How many distinct doctors get notes scribed in any rolling 30-day window. Indicates fleet breadth.
- **Recordings vs uploads.** What share of work comes from live recordings vs ad-hoc audio uploads. Reveals whether the upload flow is loved or ignored.
- **Multi-patient batches.** How often a single recording produces multiple patient subfolders. If common, the `detectPatientFolders` flow deserves more polish.
- **First-launch vs returning-user activity.** If we ever track install age, separate brand-new installs from established ones for clearer retention signals.

## Time & latency

- **End-to-end pipeline duration per case.** Recording timestamp → completed timestamp; what the scribe "feels" as the wait. Headline performance number.
- **Per-stage latency.** Transcribe vs SOAP vs ICD vs DOCX — avg, p50, p95. Spotlights the slowest step in a given week.
- **Audio-to-transcription ratio.** Real seconds spent transcribing ÷ seconds of audio. Should hover near a stable constant; anomalies suggest API issues.
- **Consultation length distribution.** Histogram of audio length per case — surprising what doctors actually average.
- **Time-of-day pipeline pressure.** Latency by hour-of-day; reveals when Claude / ElevenLabs are slowest for our usage pattern.
- **Day-of-week activity heatmap.** When scribes are busiest; useful when planning maintenance windows or capacity.

## Cost & token economics

- **Total spend over time.** Daily / weekly / monthly cost; the budget conversation. Just sum `cost_usd` from `processing_events`.
- **Cost per case.** All stages summed per case — the unit-economics number.
- **Cost per minute of audio.** Normalised so longer consultations don't look more expensive per minute than they are.
- **Cost per doctor.** Some templates / case styles consume more tokens than others; useful when discussing per-doctor pricing.
- **Cost split by `job_kind`.** What share goes to SOAP vs template-create vs prechart vs ICD. Decides which stage to optimise first.
- **Cache hit rate.** `cache_read_tokens ÷ total input tokens`. Direct measure of how well prompt caching is working — low = easy savings being missed.
- **Rate-limit incidence over time.** % of SOAP runs hitting Claude rate limits in a given period. Drives capacity / model-choice decisions.
- **Template creation ROI.** Cost of building a doctor's template (Opus max-effort) vs the per-case savings after the template exists (template prompts beat ad-hoc instructions). Justifies — or doesn't — the heavy template-create model.
- **Model comparison.** If users start mixing models (Sonnet vs Opus, version bumps), compare cost-per-case and time-per-case across them.
- **Pre-chart cost amplification.** Extra cost per case from edits — sum of prechart `cost_usd` divided by base SOAP cost. Tells you the "price of corrections".

## Reliability & failure patterns

- **Pipeline completion rate.** % of cases that reach `status='completed'`. Headline reliability number.
- **Failure rate by stage.** Which step fails most. Tells you where to invest in error handling next.
- **Common error families.** Cluster `error_message` strings (rate limit, MCP auth, ENOENT, ElevenLabs 401, etc.) and rank them.
- **Retry success rate.** When a stage failed and was re-run, did the retry succeed? Tells you which errors are transient vs persistent.
- **Time-to-failure distribution.** When jobs fail, do they fail fast or fail slow? Slow failures = wasted spend.
- **Unclosed sessions.** Sessions with `started_at > 1 day ago AND ended_at IS NULL` — implies app force-quit. Frequency is an app-stability signal.
- **Stale temp files in OS temp dir.** Leftovers matching `rec_*.mp3` / `prechart_*.md` patterns that weren't cleaned up. Implies a crash path missed cleanup. (Filesystem observation; not in DB.)
- **Rate-limit clustering.** Do rate limits hit in bunches (Claude having a bad afternoon) or spread out (sustained over-quota)? Different problems, different responses.

## Doctor profile signals

- **Template age.** Days since template was last created or updated. Old templates may have drifted from the doctor's current style.
- **Template update frequency.** How often a doctor's template gets Update-with-AI corrections. High frequency means the original Create flow didn't capture style well — feed that back into the Create skill prompt.
- **Template effectiveness proxy.** Per-doctor average `cases.revision`. High = scribes correcting Claude often = the template needs improving.
- **Inferred specialty.** If we ever parse template content for specialty markers (ortho terms, derm vocabulary, etc.), back-fill `doctors.specialty`. Useful for CDI rule-routing in Phase 2.
- **Note-style drift over time.** Compare a doctor's most-recent N notes to their template — increasing divergence suggests it's time to refresh.
- **Template length / complexity over time.** As a template gets refined, does it grow or shrink? Either pattern is informative.

## Pre-chart / editing patterns

- **Revision distribution.** What % of cases never get edited (`revision=1`) vs heavily edited (`revision≥3`). Tells you whether pre-chart is power-user behaviour or daily-driver.
- **Time-to-first-edit.** Hours between `recorded_at` and the first prechart event. Same-day = quick scribe correction; weeks-later = backfilled context (lab results came in, etc.).
- **Pre-chart by doctor.** Which doctors' notes need the most editing — often tracks template quality.
- **Backup .md count per case.** Disk-usage signal and a "should we prune?" trigger. Filesystem-derivable.
- **Attachment-vs-instructions split.** What % of prechart runs include file attachments vs instructions-only. Tells you whether the multi-file extract pipeline is earning its keep. (Would need light extra logging — attachment count isn't captured in `processing_events` today.)
- **Editing chains.** Cases that get pre-charted 3+ times in a row — likely incomplete information at recording time. Could nudge users to wait until labs/imaging are back before recording.

## Audio characteristics

- **Audio length distribution.** Histogram of `audio_duration_seconds` — what's a "normal" consultation length in this practice?
- **File size vs duration outliers.** A 60-second clip that's 50 MB or a 60-minute clip that's 2 MB suggests an encoding problem.
- **Zero-byte / corrupt recordings.** `audio_size_bytes` below a small threshold. Surfaces silent `record.py` failures the user might not notice until they look for the .docx.
- **Long-tail outliers.** Recordings beyond N hours (likely Stop button forgotten). UI could warn at recording time.
- **Pause/resume frequency.** If we ever log pause/resume separately, count them per case — high pause rate may correlate with poor audio quality.

## Quality signals (proxies for "is the note good?")

- **Output note length ÷ audio length.** Sanity check that SOAPs aren't being silently truncated. Outliers either way are interesting.
- **ICD code count per case.** Average codes generated. Zero or 20+ codes are both worth flagging — either the diagnoses section is thin or the model is over-coding.
- **Speaker count in transcript.** Number of distinct speakers diarised. A 2-speaker consult that shows 5 speakers suggests transcription noise; 1 speaker suggests audio routing.
- **SOAP section completeness.** Do generated notes always include the sections defined in the template? Missing sections = template prompt failing in some cases.
- **Note revision count as quality proxy.** If a case never needs a prechart, the original SOAP was good enough. If it needs three, something didn't land.

## System health (operational, not analytical)

- **App restart frequency.** How often the user opens the app — not in DB today; would need install-side instrumentation.
- **Auto-update success rate.** `git pull` outcomes across installs. Parseable from `app.log`; not in DB.
- **Disk usage growth in `NOTES_DIR`.** Sum of case-folder sizes over time. Helps users plan storage.
- **WAL file growth between checkpoints.** If WAL grows large between auto-checkpoints, indicates long-running transactions or high write rate.
- **`.template_job.json` orphan recovery rate.** How often startup finds a stale `running` job from a crash. Indicates how often the app dies during background work.

## Phase 2 / future signals (placeholder)

To be populated as CDI, evaluation, and feedback features ship.

- **CDI flag rate per doctor / case / specialty.** How often the CDI engine raises a flag and what kind.
- **Provider query response rate.** Of queries sent back to the doctor, how many get answered within X days.
- **Manual edit fingerprint clusters.** What scribes change most often after AI generation — feeds back into template improvements.
- **Evaluation scores over time.** If we score each note against a rubric, track per-doctor / per-model trends.
- **Cross-version model drift.** When we upgrade `soapModel`, does revision rate go up or down? Did the new model actually do better?

---

## UI surfaces these could power

When data exists and someone has time:

- **Per-doctor dashboard.** Volume, cost, revision rate, template age, recent failures.
- **Per-scribe dashboard.** Sessions per week, cases per session, time-of-day patterns, completion rate.
- **Global ops dashboard.** Pipeline reliability, cost per day, rate-limit incidence, slowest stage.
- **Per-case detail panel.** Pipeline timeline (Gantt-style), token breakdown, edit history with backup diff viewer.
- **Alert / nudge surfaces:**
  - Doctor's template hasn't been updated in 90 days → suggest a refresh.
  - Audio duration > 2× rolling median for this doctor → warn before processing.
  - Failure-rate spike in last 24h → surface in tray.
  - Monthly cost burn rate exceeding a budget → quiet notification.

---

## Adding to this list

Rules of thumb:

1. Keep entries short (1–2 lines). Anything bigger is a `plans/` candidate.
2. Anchor each entry to a data source. If the data doesn't exist yet, say so explicitly.
3. Group by theme, not by table.
4. No SQL, no schema, no implementation detail. Save that for the plan when one is needed.
5. When an entry becomes work — promote it into `docs/plans/`, leave a one-line breadcrumb here.
