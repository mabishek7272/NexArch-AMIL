# Medical report output schema

Use this logical schema for API JSON. Human-facing reports may render the same fields as sections and tables.

```json
{
  "metadata": {
    "report_id": "string",
    "created_at": "ISO-8601",
    "processing_mode": "local|external_deidentified|external_baa",
    "clinician_review_status": "not_reviewed|reviewed|signed"
  },
  "source_documents": [
    {
      "source_id": "string",
      "filename": "string",
      "pages": 0,
      "document_date": "ISO-8601|null",
      "extraction_method": "embedded_text|ocr|mixed",
      "quality": "good|partial|poor"
    }
  ],
  "encounters": [
    {
      "encounter_id": "string",
      "observed_at": "ISO-8601|null",
      "method": "string|null",
      "facts": [
        {
          "name": "string",
          "value": "string|number|null",
          "unit": "string|null",
          "reference_range": "string|null",
          "result_kind": "clinical_measurement|wellness_estimate|model_prediction|unknown_method",
          "source_status": "stated|derived|missing",
          "source_id": "string",
          "page": 0,
          "confidence": "high|medium|low"
        }
      ]
    }
  ],
  "data_quality": {
    "conflicts": [],
    "missing_context": [],
    "unreadable_fields": [],
    "reproducibility_concerns": []
  },
  "soap": {
    "subjective": [],
    "objective": [],
    "assessment_draft": [],
    "plan_draft": []
  },
  "patient_explanation": {
    "summary": "string",
    "important_findings": [],
    "uncertainties": [],
    "questions_for_clinician": [],
    "urgent_warning_signs": []
  },
  "evidence": [
    {
      "claim_id": "string",
      "organization": "string",
      "title": "string",
      "version_or_date": "string",
      "url_or_identifier": "string",
      "retrieved_at": "ISO-8601"
    }
  ],
  "provenance": {
    "provider": "string|null",
    "model": "string|null",
    "reasoning_effort": "string|null",
    "prompt_version": "string",
    "deidentified": true,
    "verification": {
      "numeric_fidelity": "pass|fail",
      "source_traceability": "pass|fail",
      "clinical_boundary": "pass|fail",
      "privacy": "pass|fail",
      "rendering": "pass|fail|not_applicable"
    }
  },
  "limitations": [],
  "disclaimer": "AI-assisted non-diagnostic draft requiring clinician review."
}
```

## Invariants

- Every stated or derived fact has a source locator.
- Every derived interpretation identifies its inputs.
- `subjective` is empty or explicitly unavailable when the patient did not report symptoms/history.
- A failed verification field prevents clinical release.
- Never include credentials, hidden reasoning, or a re-identification map.

