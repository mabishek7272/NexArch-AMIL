# AlphaFold DB NexArch browser evidence

Captured 18 November 2026 with local Chrome, the built dashboard React application, real API routes, and disposable PostgreSQL. Provider calls used deterministic local synthetic fixtures. They are not live AlphaFold DB validation.

| Screenshot | Workflow state |
| --- | --- |
| 01-lookup.png | Initial lookup form |
| 02-results-confidence.png | Predicted model, metadata and confidence |
| 03-import-viewer.png | Explicit PDB import and 3Dmol adapter |
| 04-provenance.png | Attribution and raw metadata hash drawer |
| 05-docking-handoff.png | Confirmed receptor input; preparation required |
| 06-residue-confidence.png | Per-residue pLDDT table |
| 07-pae.png | PAE matrix overview and exact row values |
| 08-annotations.png | MUTAGEN evidence classification |
| 09-not-found.png | Model unavailable state |
| 10-rate-limited.png | Provider rate-limited state |
| 11-error.png | Malformed response state |
| 12-responsive.png | 390 px viewport |
| 13-complex.png | Complex producer and component entities |
| 14-loading.png | Loading state |

The Playwright run asserts project attachment, source hash preservation, explicit model confirmation, no console exceptions, and responsive layout. It does not establish clinical validity or live-provider UI behavior.

## Automated accessibility and route verification

`npx playwright test --config=e2e/alphafold/playwright.config.ts` passed 12/12 tests on 19 November 2026 using Playwright's bundled Chromium and the disposable local QA server. The provider responses were synthetic fixtures; this is UI evidence, not live AlphaFold API evidence.

The suite checked all seven registered AlphaFold routes at 1440×900, 1280×800, 1024×768, 768×1024, and 390×844 (35 route/viewport pairs). Every direct load and browser refresh returned rendered content. Each checked view had exactly one `<main>`, one leading `<h1>`, valid heading order, no page or browser-console errors, and zero axe violations across critical, serious, moderate, and minor impact levels.

Empty, success, unavailable, malformed-response, rate-limited, and loading states were checked at all five viewports (30 state/viewport scans) with zero axe violations. Predicted-model limitations and CC BY 4.0 attribution remained visible, and the suite found no fabricated clinical or confidence interpretation. Responsive navigation opened, navigated, and closed at 1024×768, 768×1024, and 390×844. The unresolved-role check found zero protected navigation entries before role resolution and the role-filtered entries after resolution.

Exact route and viewport results are recorded in [`route-accessibility-matrix.json`](route-accessibility-matrix.json). The general NexArch regression excludes this dedicated AlphaFold suite because its provider fixture is mutable and runs serially. Existing NexArch navigation, route, and Research Studio browser tests also passed: 34 passed, 10 skipped by viewport guards, 0 failed.
