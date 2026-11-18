# Clinical safety rules

Apply these rules to every medical-report analysis.

## Authority hierarchy

1. Emergency symptoms and deterministic safety blocks.
2. Verified source-document facts.
3. Applicable versioned clinical guidelines and validated reference ranges.
4. Deterministic derived calculations with visible inputs.
5. AI-generated organization and explanation.

An AI statement cannot override a higher layer.

## Evidence requirements

- Prefer primary guidelines and official public-health, regulator, or standards sources.
- Record title, issuing organization, publication/version date, URL or identifier, and retrieval date.
- State when age, sex, pregnancy, fasting status, medications, comorbidities, specimen type, or acquisition conditions are required but unavailable.
- Do not treat a reference interval printed by an unvalidated wellness product as an independently verified clinical standard.
- Do not infer a diagnosis from one abnormal result. Use wording such as `falls within`, `is above`, `may warrant`, and `requires confirmation`.

## Device and wellness outputs

Label each result as one of:

- `clinical_measurement` - obtained by a stated clinical device or laboratory;
- `wellness_estimate` - consumer or research estimate;
- `model_prediction` - algorithmic output;
- `unknown_method` - method not established.

Wellness estimates and model predictions must not be promoted to clinical measurements. When reports disagree over an interval too short for biological change, classify the conflict as a reproducibility concern and recommend validated confirmation.

## Urgency language

- Base urgent guidance on current symptoms plus confirmed or repeatable findings whenever possible.
- Give a clear emergency action for severe symptoms such as chest pain, major breathing difficulty, fainting, new focal neurologic deficits, severe confusion, or cyanosis.
- Avoid alarming language for an isolated unvalidated estimate. Explain what should be repeated and under what conditions.
- Do not provide a false all-clear when history or examination is missing.

## SOAP boundaries

- Missing subjective information remains missing; never transform objective measurements into reported symptoms.
- Assessment is a documentation draft, not a final diagnosis.
- Plan contains confirmation, referral, monitoring, and clinician questions; it does not prescribe or change treatment.
- State the intended reviewer role and whether review has occurred.

## Privacy and external models

- External transmission requires explicit user authorization for the named destination or an established approved workflow.
- Use the minimum necessary data.
- De-identify when a BAA-covered route is not established.
- Never place API keys, access tokens, or re-identification maps in prompts, generated reports, or audit messages.
- Record provider, model, model version/slug, reasoning setting, prompt version, de-identification status, and timestamp without recording secrets.

## Release gate

Release only when numeric fidelity, source traceability, uncertainty labels, privacy handling, and output rendering pass. Otherwise return a structured verification failure and the corrective action required.

