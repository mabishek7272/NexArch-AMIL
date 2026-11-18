# Example (UNPOPULATED): rule dossier for `[SELECT CLINICAL MEASUREMENT]`

> **DRAFT — NOT RELEASED — NO CLINICAL DECISION SUPPORT.** This example shows the shape of a dossier with every clinical field left as a placeholder. It deliberately contains no medical threshold, reference range, treatment recommendation or source. Do not copy any text here into the product as a rule. Template: [14-rule-dossier-draft.template.md](../templates/14-rule-dossier-draft.template.md).

| Field | Entry |
|---|---|
| Topic | `[SELECT CLINICAL MEASUREMENT]` |
| Rule ID / version | `[UNASSIGNED]` |
| Status | DRAFT — NOT RELEASED |
| Clinical owner / independent reviewer | `[TO BE ASSIGNED BY THE ORGANISATION]` |

**Intended use:** `[ONE SENTENCE]` · **Population:** `[AGE BAND / CONDITIONS / LANGUAGES]` · **Exclusions (each with source):** `[LIST]`

**Sources:** `[PRIMARY SOURCE 1: TITLE, VERSION, PUBLISHER, LICENCE]`

**Logic:** inputs `[NAME, UNIT, CONTEXT]` → criteria `[THRESHOLD — FROM CITED SOURCE ONLY]` → output `[DESCRIPTIVE CATEGORY]`; otherwise `not_comparable` or `insufficient_data`.

**Boundary cases:** `[AT-LIMIT ±ε]` `[UNIT MISSING]` `[CONFLICTING DUPLICATES]` `[OUT OF POPULATION]` — expected outputs written by the clinical owner.

**Explanation wording:** `[NON-DIAGNOSTIC TEXT WITH CITATION AND STATED UNCERTAINTY]`

**Monitoring:** `[CADENCE, TRIGGERS, REVIEWER]` · **Rollback:** `[TRIGGER, WHO MAY INVOKE, REGISTER ACTION]`

**Release evidence:** none. **Decision / signature reference:** none. **Independent review:** none.
