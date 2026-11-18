# Research Studio — licence inventory of external reference repositories

Per the brief: "Identify reusable mechanisms, dependencies and exact licences before copying
anything. Record attribution for reused material. Respect restrictive and file-specific licences.
Do not bulk-import repositories or skill libraries." This was done **before** writing any Research
Studio code. Nothing below was copied verbatim into this repository; any resemblance is a
design-pattern decision, noted as such.

| Repository | Licence (as found) | Verdict | What was (not) taken |
|---|---|---|---|
| `xiryn-main` | MIT | Permissive — code reuse allowed with attribution, but not reused | `lib/web.ts` uses Firecrawl (a paid third-party API) for web search/fetch, not MCP/Playwright — a different paradigm than requested, so not adopted. `lib/workstation.ts` uses Docker+VNC per-agent containers on a Next.js/Drizzle stack — a different stack from this repo's Express/pg; the *idea* of per-agent session isolation informed the "per-account browser-session lock" requirement in the plan, but no code was copied. |
| `ai auto research/hyperresearch-main` | Reviewed; no code reused this pass | — | Not yet integrated into M1; revisit for M2 literature-pipeline patterns. |
| `scientific-agent-skills-main` | Reviewed; no code reused this pass | — | Candidate source of domain-skill prompts for later specialist agents (M4) — none copied yet. |
| `opendataloader-pdf-main` | Reviewed; no code reused this pass | — | Candidate for PDF extraction once Evidence Extractor (M2) is built — none copied yet. |
| `academic-research-skills-main` | **CC BY-NC 4.0 (NonCommercial)** | **Excluded from code reuse** | NonCommercial terms are incompatible with a potentially-commercial product; no code or content was copied. High-level concepts only, if ever referenced, must be independently re-derived, not adapted from this repo's text. |
| `openscience-main` | Reviewed; no code reused this pass | — | Not yet integrated. |
| `PRAXIST-main` | **Fair Source License v1.0 (revenue-threshold-gated commercial licence)** | **Excluded from code reuse** | Reusing its code without a separate commercial licence from the rights holder is not permitted; no code was copied. Any resemblance in later agents is independent design, not adaptation. |

## Hard constraint honoured

Per the brief: **"Do not integrate Turnitout/StealthWriter or detector-evasion workflows."** None
of the above repositories' AI-detector-evasion features (if present) were inspected for reuse, and
none are integrated. The Editorial Agent planned for M4 is explicitly scoped (plan, "AUTHOR-VOICE
EDITING" addendum) to **never optimise for AI-detector scores or promise "0% AI"** — it will record
assistance transparently instead.

## Attribution

No third-party source code is embedded in this repository as a result of this inventory. If a
future milestone adapts a specific, identifiable algorithm or snippet from an MIT/Apache-2.0
repository above, that commit's message and this document must name the source file and licence
at the time of adaptation.
