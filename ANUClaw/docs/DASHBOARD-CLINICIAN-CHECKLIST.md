# Dashboard clinician-review checklist (documentation only)

**This is documentation. The dashboard has no control that approves, accepts, signs, releases or validates anything for this checklist, and none was added.** It lists what a clinician should look at when using the dashboard pages, and what each page can and cannot do. Product status: synthetic-only, clinically unvalidated, production-blocked. Related: [CLINICIAN-PROTOCOL-REVIEW.md](CLINICIAN-PROTOCOL-REVIEW.md), [CLINICAL-LEAD-WORKSHEET.md](CLINICAL-LEAD-WORKSHEET.md).

| Page | Look for | What it can do | What it cannot do |
|---|---|---|---|
| **Clinical** (reports) | every candidate value shown with its source page and OCR confidence; uncertainty flags; corrections require a reason; draft / reviewed label; "no released rules" state | confirm / correct / reject candidates; create a draft report; a provisioned clinician account can mark it reviewed | produce a diagnosis; release content; sign off through the API |
| **Monitoring** | separate "measured" and "received" ages; "NOT CURRENT" labelling of delayed data; simulation banner | display simulated device data and simulation-only alerts | raise real alerts; interpret values as normal/abnormal |
| **OCR studies** | notice banner; your study role; lock state is shown, not set by you; blinded annotation; a draft policy panel (13 fields, hash-chain integrity, readiness report) | run the synthetic study workflow; prepare draft policy values with source references; record a two-person review with external references | accept, approve, activate or release a study or a policy (no such action exists) |
| **AIKosh data** | default status "unknown — blocked"; restricted fields; approval states | record a proposal and a second person's decision for a file/use | approve its own proposal; enable external processing without the recorded evidence |
| **Public data** | classification (experimental / predicted / author-supplied); provenance; research-only notice | retrieve and attach public records | provide clinical evidence |
| **Patients / Users** | per-patient access grants; role | manage access | grant clinical authority |

**Before relying on any screen:** confirm the banner text for that page is present; confirm the data are synthetic; remember that a reviewer's confirmation in the UI records an operational action, not a clinical approval of the software.
