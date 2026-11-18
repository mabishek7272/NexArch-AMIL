# Engine evidence review

The existing E-LAB `POST /second-opinion` route now runs two models in sequence:

1. `google/gemini-decision-1` checks whether supplied engine evidence is sufficient
   and whether it conflicts with the proposed plan, using OpenRouter's Decisions API.
2. `google/gemma-4-26b-a4b-it` reviews that evidence and the checks, returning the
   existing second-opinion JSON fields plus `decision_checks`.

Gemma is already a mixture-of-experts model; no training or conversion is involved.
This endpoint reviews supplied outputs. It does not automatically execute docking,
simulation, or other engines, and model claims do not establish that an engine ran.

## Request and response

Existing dashboard authentication and E-LAB MFA still apply. The router is mounted
by the dashboard; append `/second-opinion` to its existing E-LAB engine base path.

```json
{
  "case_summary": "Deidentified case facts",
  "proposed_plan": "Plan to review",
  "engine_verdict": { "decision": "block" },
  "engine_results": [
    { "engine": "example", "result": { "decision": "block", "reason": "Example test block" } }
  ]
}
```

`case_summary` is required; the remaining fields are optional. `engine_results` is
an additive field for existing engine responses. These are caller-supplied records,
not server-verified execution receipts. With no outputs, the review must state that
engine evidence is absent. A `decision: "block"` anywhere in the supplied verdict
or engine results forces a fixed block-deferring review in server code.

The response keeps the existing safety envelope, `result`, and reviewer provenance.
`result.decision_checks` contains typed `engine_evidence` and `consistency` answers
with model confidence. Confidence is not calibrated clinical accuracy.
`provenance.decision_model` records the checking model. Model failures or invalid
outputs return an error rather than silently skipping a stage.

Existing de-identification happens before both model calls and re-identification
happens locally afterwards. Audit records contain model IDs and de-identification
counts, not the clinical text.

Requires the existing OpenRouter key. Optional overrides:

```dotenv
ELAB_DECISION_MODEL=google/gemini-decision-1
ELAB_REVIEW_MODEL=google/gemma-4-26b-a4b-it
OPENROUTER_REASONING_EFFORT=medium
```

OCR, embeddings, and deterministic engine calculations are outside this change.
