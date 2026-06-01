# Physician Assist — Phase 2 planning

Working notes on the **next phase** of the AI Medical Scribe: extending it from "record + SOAP note + ICD codes" into the broader clinical ops platform the client (Fahd) is asking for — CDI, Workers Comp, Prior Auth, E/M scoring, etc.

This folder is shared context. New Claude sessions should read it before discussing PA scope, architecture, or roadmap.

---

## Who's who

- **Fahd** — the client. Domain expert in US scribing / healthcare admin, runs a scribing services business, non-technical. Has been exploring AI as a new avenue. Currently builds AI prototypes himself using Claude.ai (the "vibe-coding" route) — Vercel-hosted CDI Co-Pilot, local MCP server, etc.
- **Jayanth** — the tech advisor who translates between Fahd and us.
- **Us (rish + team)** — the engineering side. We build the actual production system.

**Important framing from rish:** *Fahd's technical prescriptions (architecture diagrams, MCP-vs-browser deployment, postMessage handoffs) are not binding.* He doesn't know how our recording-app actually works yet (no demo shown). Treat his materials as **a description of goals and gaps**, not as **a design spec**. The *how* is ours to figure out.

---

## File index

| File | Purpose |
|---|---|
| [01-fahd-materials.md](01-fahd-materials.md) | Inventory of everything Fahd has shipped — PDF, MCP server, standards packs, Vercel app. Where the artifacts live on disk. |
| [02-feature-landscape.md](02-feature-landscape.md) | All the features in scope, organized by status: already built in our app / new from Fahd / future. |
| [03-architecture-observations.md](03-architecture-observations.md) | Technical observations about Fahd's proposed architecture vs ours. Where they conflict, what to absorb, what to reject. |
| [04-open-questions.md](04-open-questions.md) | Things that need clarification before we can write a concrete plan. |
| [05-engines.md](05-engines.md) | The 8 engines from Fahd's PDF + Auto-Pilot orchestrator — detailed spec for each, with sub-feature deliverables tracking for the active engine (currently CDI Co-Pilot). |

---

## Reading order for a fresh session

1. Read this README.
2. Read `docs/OVERVIEW.md` first if you don't already know what the recording-app is.
3. Then `01-fahd-materials.md` → `02-feature-landscape.md` → `03-architecture-observations.md` → `04-open-questions.md` → `05-engines.md`.
4. Once a concrete plan is agreed, it should land in `docs/plans/YYYY-MM-DD-<initials>-<slug>.md` per the normal plan convention — not in this folder.

This folder is for *the messy thinking before the plan*. It's not the plan.

---

## How this exploration started

Fahd reached out at the end of April 2026 with a CDI prototype he had built (the Vercel app `cdi-copilot.vercel.app`) and started messaging rish on WhatsApp about integrating it with our recording-app. Over a few days he sent:

- A WhatsApp thread describing the workflow he envisions (audio → AI draft → CDI flags → scribe review → provider attests).
- A flow diagram (`PA flow diag.jpeg`) showing his three-column mental model (ambient tool / integration layer / Physician Assist).
- A working zip of his local MCP server (`pa-mcp-server.zip`), which he had built and tested with Claude Desktop.
- A 21-page internal feature-overview PDF (`pa-feature-overview_1.pdf`) titled "PHYSICIAN ASSIST — Clinical Operations AI Platform".
- The official FY2026 ICD-10-CM Guidelines PDF (~820 KB), with his annotations.

This planning folder is the first pass of distilling all that into something we can actually act on.

**Today's date for context:** May 14, 2026. Fahd's WhatsApp messages were Apr 29–30. His PDF is dated April 30.

---

## External materials (not in this repo)

| Where | What |
|---|---|
| `~/Development/PA/Fahd doc/pa-feature-overview_1.pdf` | The 21-page feature overview PDF |
| `~/Development/PA/Fahd doc/PA flow diag.jpeg` | The three-column flow diagram |
| `~/Development/PA/Fahd doc/pa-mcp-server/` | Fahd's working MCP server (pa_agents.py + standards packs) |
| `~/Development/PA/Fahd doc/icd_10_cm_october_2025_guidelines_0.pdf` | Official FY2026 ICD-10-CM guidelines (not yet read in depth) |
| `cdi-copilot.vercel.app` | Fahd's live Vercel deployment of the CDI engine (anyone with the URL + their own API key can use it) |
| `github.com/fahd015-PhyAssist/cdi-copilot` | Fahd's source repo for the Vercel app |

See `01-fahd-materials.md` for the deeper inventory.

---

## How Fahd works (helpful for tone-setting)

- **Non-technical domain expert.** Trained scribe / clinical-ops background. Has worked with US doctors, hospitals, and scribing teams for years. He knows CDI, billing, AHIMA, ICD-10, workers comp, prior auth at a depth we don't.
- **Builds via Claude.ai.** When he wants to prototype something, he opens Claude.ai, describes it, copies the output into a Vercel project, and ships. This is how `cdi-copilot.vercel.app` and `pa-mcp-server` came to be. He calls it "I created this on Claude". He doesn't write code himself.
- **Hasn't seen our app in detail.** The scribes who use the recording-app are *his team*, but he himself only has a vague mental picture of how it works. That's why his integration diagram assumes our app is browser-based — Claude.ai gave him a typical browser-app shape and he accepted it. **A demo of the actual app would change a lot of his assumptions.** This is on rish's to-do list.
- **Treat his materials as goals and gaps, not specs.** He's right about *what* he wants (CDI, WC, PA, summaries, the "scribe-as-gatekeeper" model). He may be wrong about *how* — the MCP server, the postMessage handoff, the dual deployment, the "agent orchestration" framing. We design our own *how* and discuss it with him via Jayanth (the tech advisor who translates between us).

---

## Where the discussion stands

Nothing has been decided. Specifically, **all of these are open**:

- Whether PA is the next phase of *our* app or a separate product
- Which of the 8 engines we ship first
- What the UI for "review CDI flags" looks like
- Whether the orchestrator is a real agent or a JS dispatcher
- The HIPAA / BAA / de-identification question (Fahd's prototypes use real-API-with-de-identified-data; the recording-app generates notes with real patient names)
- Whether the Vercel CDI app continues to exist post-integration

The most useful next move is probably **rish demoing the recording-app to Fahd** so the rest of the conversation happens on shared reality. Until then, everything is speculative.
