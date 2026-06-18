import sqlite3
import os
from datetime import datetime, timedelta, timezone

BASE = r"X:\db analysis"
OUT_DIR = r"X:\db analysis\report"
SCRIBES = [
    d for d in os.listdir(BASE)
    if os.path.isdir(os.path.join(BASE, d))
    and os.path.isfile(os.path.join(BASE, d, "app.db"))
]

TZ_OFFSET_HOURS = 5.5          # IST = UTC+5:30
SHIFT_START_HOUR = 20          # 8 PM local
SHIFT_END_HOUR   = 5           # 5 AM local next day
FILTER_DATE_FROM = "2026-06-01"
FILTER_DATE_TO   = "2026-06-15"

# Per-scribe filter: "shift" = Mon/Wed shift window only
SCRIBE_FILTER = {
    "niyaz": "shift",
}

IST = timezone(timedelta(hours=TZ_OFFSET_HOURS))
_from_dt = datetime.fromisoformat(FILTER_DATE_FROM).replace(tzinfo=IST)
_to_dt   = datetime.fromisoformat(FILTER_DATE_TO).replace(tzinfo=IST) + timedelta(days=1)


def is_in_shift(recorded_at_utc):
    """Return True if the case falls within a Mon or Wed evening shift (local time)."""
    if not recorded_at_utc:
        return False
    try:
        s = recorded_at_utc.rstrip("Z")
        utc_dt = datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
        local = utc_dt.astimezone(IST)
    except Exception:
        return False

    # Must be within the overall date range
    if local < _from_dt or local >= _to_dt:
        return False

    wd   = local.weekday()   # 0=Mon, 2=Wed, 1=Tue, 3=Thu
    hour = local.hour + local.minute / 60

    # Evening leg: Mon(0) or Wed(2) at or after 20:00
    if wd in (0, 2) and hour >= SHIFT_START_HOUR:
        return True
    # Overnight leg: Tue(1) or Thu(3) before 05:00
    if wd in (1, 3) and hour < SHIFT_END_HOUR:
        return True
    return False


def q(db, sql, params=()):
    cur = db.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def to_seconds(val):
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val)
    val = str(val).strip()
    parts = val.split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return float(val)


def fmt_seconds(seconds):
    if seconds is None:
        return None
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


def fmt_duration(val):
    return fmt_seconds(to_seconds(val))


def fmt_ms(ms):
    return fmt_seconds(ms / 1000) if ms is not None else None


def round6(v):
    return round(float(v), 6) if v is not None else None


def analyze_doctor(db, doc, scribe_folder, filtered_cases=None, filter_label=None):
    did = doc["id"]

    # ── Cases ────────────────────────────────────────────────────────────────
    all_cases = filtered_cases if filtered_cases is not None else q(db, "SELECT * FROM cases WHERE doctor_id = ?", (did,))
    total_cases    = len(all_cases)
    completed      = sum(1 for c in all_cases if c["status"] == "completed")
    failed         = sum(1 for c in all_cases if c["status"] == "failed")
    other          = total_cases - completed - failed

    # Audio time (HH:MM:SS strings — aggregate in Python)
    raw_audio = [to_seconds(c["audio_duration"]) for c in all_cases if c["audio_duration"] is not None]
    if raw_audio:
        total_audio_s = sum(raw_audio)
        avg_audio_s   = total_audio_s / len(raw_audio)
        min_audio_s   = min(raw_audio)
        max_audio_s   = max(raw_audio)
    else:
        total_audio_s = avg_audio_s = min_audio_s = max_audio_s = None

    # Turnaround: recorded_at → completed_at
    turnarounds = []
    for c in all_cases:
        if c["recorded_at"] and c["completed_at"]:
            from datetime import datetime, timezone
            def parse_dt(s):
                s = s.rstrip("Z")
                if "." in s:
                    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
                return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)
            try:
                diff = (parse_dt(c["completed_at"]) - parse_dt(c["recorded_at"])).total_seconds()
                if diff >= 0:
                    turnarounds.append(diff)
            except Exception:
                pass

    avg_turnaround = sum(turnarounds) / len(turnarounds) if turnarounds else None
    max_turnaround = max(turnarounds) if turnarounds else None

    # Date range
    dates = [c["recorded_at"] for c in all_cases if c["recorded_at"]]
    first_date = min(dates) if dates else None
    last_date  = max(dates) if dates else None

    # ── Sessions ─────────────────────────────────────────────────────────────
    sessions = q(db, "SELECT * FROM sessions WHERE doctor_id = ?", (did,))
    total_sessions = len(sessions)
    case_counts = [s["case_count"] for s in sessions if s["case_count"] is not None]
    avg_cases_per_session = sum(case_counts) / len(case_counts) if case_counts else None

    # ── Processing events ────────────────────────────────────────────────────
    case_ids = [c["id"] for c in all_cases]
    if case_ids:
        placeholders = ",".join("?" * len(case_ids))
        events = q(db, f"SELECT * FROM processing_events WHERE case_id IN ({placeholders})", case_ids)
    else:
        events = []

    # Cost
    cost_events = [e for e in events if e["cost_usd"] is not None]
    total_cost = sum(float(e["cost_usd"]) for e in cost_events) if cost_events else None
    avg_cost_per_event = total_cost / len(cost_events) if cost_events else None
    avg_cost_per_case  = total_cost / total_cases if total_cost and total_cases else None

    # Cost by job_kind
    job_kinds = sorted(set(e["job_kind"] for e in cost_events))
    cost_by_job = []
    for jk in job_kinds:
        jk_events = [e for e in cost_events if e["job_kind"] == jk]
        cost_by_job.append({
            "job_kind":  jk,
            "runs":      len(jk_events),
            "successes": sum(1 for e in jk_events if e["status"] == "success"),
            "failures":  sum(1 for e in jk_events if e["status"] == "failed"),
            "total_usd": round6(sum(float(e["cost_usd"]) for e in jk_events)),
            "avg_usd":   round6(sum(float(e["cost_usd"]) for e in jk_events) / len(jk_events)),
        })
    cost_by_job.sort(key=lambda x: x["total_usd"] or 0, reverse=True)

    # Cost by model
    models = sorted(set(e["model_used"] for e in cost_events if e["model_used"]))
    cost_by_model = []
    for m in models:
        m_events = [e for e in cost_events if e["model_used"] == m]
        cost_by_model.append({
            "model":     m,
            "runs":      len(m_events),
            "total_usd": round6(sum(float(e["cost_usd"]) for e in m_events)),
            "avg_usd":   round6(sum(float(e["cost_usd"]) for e in m_events) / len(m_events)),
        })
    cost_by_model.sort(key=lambda x: x["total_usd"] or 0, reverse=True)

    # Tokens
    def tok_sum(key):
        return int(sum(float(e[key]) for e in events if e[key] is not None))

    total_tokens = {
        "input":         tok_sum("input_tokens"),
        "output":        tok_sum("output_tokens"),
        "cache_read":    tok_sum("cache_read_tokens"),
        "cache_created": tok_sum("cache_created_tokens"),
    }
    total_tokens["total"] = sum(total_tokens.values())

    # Processing time
    dur_events = [e for e in events if e["duration_ms"] is not None]
    total_proc_ms = sum(float(e["duration_ms"]) for e in dur_events) if dur_events else None
    avg_proc_ms   = total_proc_ms / len(dur_events) if dur_events else None

    all_job_kinds = sorted(set(e["job_kind"] for e in dur_events))
    duration_by_job = []
    for jk in all_job_kinds:
        jk_dur = [float(e["duration_ms"]) for e in dur_events if e["job_kind"] == jk]
        duration_by_job.append({
            "job_kind": jk,
            "runs":     len(jk_dur),
            "avg":      fmt_ms(sum(jk_dur) / len(jk_dur)),
            "total":    fmt_ms(sum(jk_dur)),
            "min":      fmt_ms(min(jk_dur)),
            "max":      fmt_ms(max(jk_dur)),
        })
    duration_by_job.sort(key=lambda x: x["runs"], reverse=True)

    na = "—"

    def val(v):
        return str(v) if v is not None else na

    def usd(v):
        return f"${float(v):.4f}" if v is not None else na

    def avg_tok(key):
        return int(total_tokens[key] / total_cases) if total_cases else 0

    lines = []
    a = lines.append

    a(f"# Analysis Report — {doc['name']}")
    a("")
    if filter_label:
        a(f"> {filter_label}")
        a("")
    a("## Doctor")
    a("")
    a(f"| Field | Value |")
    a(f"|---|---|")
    a(f"| Name | {doc['name']} |")
    a(f"| Lastname | {doc['lastname']} |")
    a(f"| Specialty | {val(doc['specialty'])} |")
    a(f"| CDI Enabled | {'Yes' if doc['enable_cdi'] else 'No'} |")
    a(f"| Scribe Folder | {scribe_folder} |")
    a("")

    a("## Date Range")
    a("")
    a(f"| | Date |")
    a(f"|---|---|")
    a(f"| First Case | {val(first_date)[:10] if first_date else na} |")
    a(f"| Last Case  | {val(last_date)[:10] if last_date else na} |")
    a("")

    a("## Sessions")
    a("")
    a(f"| Metric | Value |")
    a(f"|---|---|")
    a(f"| Total Sessions | {total_sessions} |")
    a(f"| Avg Cases per Session | {round(avg_cases_per_session, 1) if avg_cases_per_session else na} |")
    a("")

    a("## Cases")
    a("")
    a(f"| Status | Count |")
    a(f"|---|---|")
    a(f"| Total | {total_cases} |")
    a(f"| Completed | {completed} |")
    a(f"| Failed | {failed} |")
    a(f"| Other | {other} |")
    success_rate = round(completed / total_cases * 100, 1) if total_cases else None
    a(f"| Success Rate | {val(success_rate)}{'%' if success_rate is not None else ''} |")
    a("")

    a("## Audio Time")
    a("")
    a(f"| Metric | Value |")
    a(f"|---|---|")
    a(f"| Total | {val(fmt_seconds(total_audio_s))} |")
    a(f"| Average per Case | {val(fmt_seconds(avg_audio_s))} |")
    a(f"| Shortest | {val(fmt_seconds(min_audio_s))} |")
    a(f"| Longest | {val(fmt_seconds(max_audio_s))} |")
    a("")

    a("## Turnaround Time (Recorded → Completed)")
    a("")
    a(f"| Metric | Value |")
    a(f"|---|---|")
    a(f"| Average | {val(fmt_seconds(avg_turnaround))} |")
    a(f"| Worst Case | {val(fmt_seconds(max_turnaround))} |")
    a("")

    a("## Cost")
    a("")
    a(f"| Metric | Value |")
    a(f"|---|---|")
    a(f"| Total | {usd(total_cost)} |")
    a(f"| Avg per Case | {usd(avg_cost_per_case)} |")
    a(f"| Avg per Event | {usd(avg_cost_per_event)} |")
    a("")
    a("### Cost by Job Kind")
    a("")
    a("| Job Kind | Runs | Successes | Failures | Total Cost | Avg Cost |")
    a("|---|---|---|---|---|---|")
    for r in cost_by_job:
        a(f"| {r['job_kind']} | {r['runs']} | {r['successes']} | {r['failures']} | {usd(r['total_usd'])} | {usd(r['avg_usd'])} |")
    a("")
    a("### Cost by Model")
    a("")
    a("| Model | Runs | Total Cost | Avg Cost |")
    a("|---|---|---|---|")
    for r in cost_by_model:
        a(f"| {r['model']} | {r['runs']} | {usd(r['total_usd'])} | {usd(r['avg_usd'])} |")
    a("")

    a("## Token Usage")
    a("")
    a(f"| Token Type | Total | Avg per Case |")
    a(f"|---|---|---|")
    a(f"| Input | {total_tokens['input']:,} | {avg_tok('input'):,} |")
    a(f"| Output | {total_tokens['output']:,} | {avg_tok('output'):,} |")
    a(f"| Cache Read | {total_tokens['cache_read']:,} | {avg_tok('cache_read'):,} |")
    a(f"| Cache Created | {total_tokens['cache_created']:,} | {avg_tok('cache_created'):,} |")
    a(f"| **Total** | **{total_tokens['total']:,}** | **{avg_tok('total'):,}** |")
    a("")

    a("## Processing Time")
    a("")
    a(f"| Metric | Value |")
    a(f"|---|---|")
    a(f"| Total | {val(fmt_ms(total_proc_ms))} |")
    a(f"| Average per Event | {val(fmt_ms(avg_proc_ms))} |")
    a("")
    a("### By Job Kind")
    a("")
    a("| Job Kind | Runs | Avg | Total | Min | Max |")
    a("|---|---|---|---|---|---|")
    for r in duration_by_job:
        a(f"| {r['job_kind']} | {r['runs']} | {val(r['avg'])} | {val(r['total'])} | {val(r['min'])} | {val(r['max'])} |")
    a("")

    return "\n".join(lines)


sections = ["# AI Medical Scribe — Cost & Time Analysis Report\n"]

for scribe in SCRIBES:
    db_path = os.path.join(BASE, scribe, "app.db")
    db = sqlite3.connect(db_path)
    doctors = q(db, "SELECT * FROM doctors")

    print(f"\n[{scribe}] — {len(doctors)} doctor(s)")
    for doc in doctors:
        did = doc["id"]
        all_cases = q(db, "SELECT * FROM cases WHERE doctor_id = ?", (did,))
        filter_label = None

        if SCRIBE_FILTER.get(scribe) == "shift":
            filtered = [c for c in all_cases if is_in_shift(c["recorded_at"])]
            filter_label = (
                f"Filtered to Mon & Wed shifts, {FILTER_DATE_FROM} to {FILTER_DATE_TO} (IST UTC+5:30). "
                f"{len(filtered)} of {len(all_cases)} total cases matched."
            )
            all_cases = filtered

        sections.append(analyze_doctor(db, doc, scribe, filtered_cases=all_cases, filter_label=filter_label))
        sections.append("---\n")
        print(f"  Analysed: {doc['name']}" + (f" ({len(all_cases)} shift cases)" if filter_label else ""))

    db.close()

out_path = os.path.join(OUT_DIR, "all_doctors_analysis.md")
with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(sections))

print(f"\nWritten: {out_path}")
print("Done.")
