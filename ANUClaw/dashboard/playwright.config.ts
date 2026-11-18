// Re-exports the real config from e2e/. This file exists ONLY so a bare `npx playwright
// test` run from `dashboard/` (the natural muscle-memory invocation, and Playwright's
// default config-search location) resolves to the same fail-closed config as the
// documented `npm run test:e2e` script, instead of silently finding no config, falling
// back to Playwright's built-in defaults, and still discovering e2e/*.spec.ts files by
// its own default glob — which produced a confusing low-level crash (missing
// NEXARCH_QA_PROJECT_ID deep in a helper) instead of the clean, actionable
// "NexArch QA suite requires NEXARCH_QA_BASE_URL/..." message. Confirmed both bare
// `npx playwright test` and `npm run test:e2e` now fail closed identically.
export { default } from './e2e/playwright.config';
