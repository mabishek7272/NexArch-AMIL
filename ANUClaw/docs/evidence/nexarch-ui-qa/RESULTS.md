# NexArch Lab UI QA — repair pass evidence

Scope: responsive outer-shell navigation, axe-core accessibility fixes, AI Connections
notice copy, stale skill-count claims. Visual direction (black/gold, N emblem, compact
density) unchanged throughout — this was a bug-fix/content pass, not a redesign.

Tooling: Playwright (headless Chromium) + `@axe-core/playwright`, driving the local dev
stack (`vite` on :5173, dashboard backend on :3722, disposable Postgres on :55433) as the
real bootstrap admin account created earlier in this review. No secrets are recorded here.

## 1. Responsive outer-shell navigation

`dashboard/src/nexarch/NexArchShell.tsx` previously had no responsive logic at all — the
234px sidebar was permanent at every width. Fixed: below the shared 1180px breakpoint
(`useNarrow` hook, `dashboard/src/nexarch/ui.tsx`, same value `ResearchStudioPage.tsx`
already used), the sidebar is replaced by a topbar button (`aria-label="Open navigation"`)
that opens the 13-item nav in an overlay `Drawer` — reusing the same accessible Drawer
component as the provenance panel, and the same `NavContent`/`NavItem` rendering used by
the permanent desktop sidebar (one implementation, not two that could drift).

Verified (`nav-test.mjs`, real browser automation, not code inspection):

| Check | 1024×768 | 768×1024 |
|---|---|---|
| Menu button present, sidebar not permanent | ✅ | ✅ |
| Menu button reachable via Tab alone | ✅ | ✅ |
| Drawer opens on Enter | ✅ | ✅ |
| Focus moves inside drawer on open | ✅ | ✅ |
| Background (`#root`) inert while open | ✅ | ✅ |
| Full nav (role-filtered, preview badges, active route) renders inside drawer | ✅ | ✅ |
| Focus trapped inside drawer across 20 Tabs | ✅ | ✅ |
| Keyboard-only navigation to a real route works and closes the drawer | ✅ (→ `/nexarch/research-studio`) | ✅ |
| Escape closes the drawer | ✅ | ✅ |
| Focus returns to the menu button on close | ✅ | ✅ |

Desktop unchanged, verified by reading the live DOM (not assumed):

| Viewport | Sidebar rendered inline | Computed width | Menu button present |
|---|---|---|---|
| 1440×900 | yes | 234px (unchanged) | no |
| 1280×800 | yes | 234px (unchanged) | no |

Screenshots: `responsive-nav_1024x768_drawer_content.png` (drawer open, full nav visible),
`screenshots/1024x768_*.png` / `768x1024_*.png` (collapsed layout, no permanent sidebar).

## 2. Axe-core accessibility findings

Baseline (before this pass) vs. final, across all 4 routes (`/nexarch`,
`/nexarch/research-studio`, `/nexarch/connections`, `/nexarch/style-guide`) × all 4
viewports (1440×900, 1280×800, 1024×768, 768×1024) — 16 combinations:

| | Critical | Serious | Moderate |
|---|---|---|---|
| Baseline | 2 (style-guide only) | ~230 node-instances (color-contrast, label-content-name-mismatch, scrollable-region-focusable) | ~68 node-instances (page-has-heading-one, region) |
| **Final** | **0** | **0** | **0** |

Zero violations of any severity remain on any route at any viewport. Full machine-readable
detail (every node, selector and failure summary axe reported, before the fixes in this
section) is in `axe-console-refresh-report.json` in this folder — that capture is from the
run immediately preceding the fixes described below; the harness was re-run clean afterward
(exit confirmed 0 violations) and is reproducible by anyone with the scratch harness.

Fixes applied:
- **color-contrast**: three `--nx-*` tokens in `theme.css` were failing WCAG AA on the
  panel backgrounds they're actually used on (`--nx-text-dim` #5C636C → #868C92,
  `--nx-text-disabled` #4A525B → #888D93, `--nx-gold-dim` #8C6428 → #A8895C — all computed
  against the real rendered background colors, not guessed). No other token changed; hue
  and "this text is dim/secondary" character preserved.
- A related bug the above alone didn't fix: preview nav items used CSS `opacity: .55` to
  look dimmed, which *multiplies* the rendered contrast ratio — fixed by using an explicit,
  already-contrast-checked color instead of opacity, in both `NexArchShell.tsx`'s real
  nav items and an identical hardcoded demo row in `StyleGuide.tsx`.
- **label-content-name-mismatch**: preview nav items and the provenance-drawer trigger row
  previously set an `aria-label` that *overrode* and excluded their own visible text (the
  "PREVIEW" badge, or table cell content) from the accessible name. Fixed by removing the
  override and letting the accessible name compute from visible content instead, adding a
  visually-hidden context prefix (`SR_ONLY` style, `ui.tsx`) where a plain reading of the
  content needed one.
- **page-has-heading-one**: Overview's "Current programme" heading only exists once a
  project is selected. Added a permanent, visually-hidden `<h1>Overview</h1>` rather than
  promoting or duplicating the conditional one.
- **region**: the topbar was a bare `<div>`, not contained in any landmark. Changed to a
  real `<header>` element.
- **scrollable-region-focusable**: the horizontally-scrollable `WorkspaceBar` (only
  actually overflows at 768px width) got `tabIndex={0}` + `role="region"` + a label.
- **label (critical)**: the two Style Guide demo inputs had a styled caption with no
  programmatic link to the input. `Field` (`ui.tsx`) now generates a real id and renders a
  `<label htmlFor>`, cloning the single child control to receive it — fixes both inputs and
  every other `Field` usage in the app (e.g. the destructive-confirm dialog) for free.

No violation was suppressed, ignored, or hidden behind an axe-disable comment — every fix
above is a structural change, and the before/after counts are from real tool output.

## 3. AI Connections notice

`dashboard/src/nexarch/pages/Connections.tsx`'s "Only the simulated provider works today"
banner no longer shows `docs/RESEARCH-STUDIO-BROWSER-CONNECTOR.md` in the default-visible
text. The one-sentence explanation stayed in plain language; the doc reference moved into
a collapsed `TECHNICAL DETAILS` disclosure, the same pattern Overview.tsx's unavailable
cards already use.

## 4. Stale "1,100+ skills" / "14 channels" claims

Verified real inventory: `container/skills/` = 13 directories, `src/channels/` = 11 real
implementations (confirmed again this pass, unchanged from the prior one).

Fixed in the three files flagged as out-of-scope last pass:
- `dashboard/src/pages/ApiKeys.tsx` — hero copy, demo-feature card, code-comment, and the
  "Skills Available" stat tile's fallback all corrected to 13. (That tile's live value
  comes from `/keys/platform-stats`' `skills` field, which counts *distinct skills
  invoked*, not catalog size — a pre-existing, separate metric; the displayed number is now
  a correct, hardcoded catalog size of 13 rather than a fabricated 1,100 fallback.)
- `dashboard/src/components/CommandPalette.tsx` — Skills entry description.
- `dashboard/src/pages/Pipelines.tsx` — hero subtitle (only one occurrence found this
  pass, not two as flagged — re-verified by grep, the file doesn't contain a second hit).

Repo-wide re-check after fixing (`grep -rniE "1,100|1100" dashboard/src` and
`grep -rniE "14 channel" dashboard/src`): one hit remains —
`dashboard/src/pages/Welcome.tsx:13`, a code comment reading `// Verified against
container/skills/ (13 skill directories) — do not restate as "1,100+".` — not user-facing,
left in place deliberately as a regression guard. Zero "14 channel" hits anywhere.

## 5. Re-run results (real command/tool output)

- `npx tsc --noEmit` — clean, exit 0.
- `npm run build` — succeeded, all nexarch chunks present, exit 0.
- Playwright route/viewport matrix (16 combinations): all return HTTP 200 with non-blank
  rendered content on direct refresh (not just client-side nav).
- Browser console/pageerror capture: **zero** errors on any of the 16 route×viewport
  combinations.
- axe-core: **zero** critical/serious/moderate/minor violations across all 16 combinations
  (see table above).
- Responsive nav keyboard/focus/inert/return tests: all pass (see table above).
- Provenance drawer interaction tests (Escape, focus-in, focus-trap, focus-return,
  accessible close name, background-inert): all still pass — re-verified after the shared
  `Drawer`/`ui.tsx` changes, no regression.

## Remaining defects

None found at the scope of this pass. Two things worth separate follow-up, not fixed here
because they're outside what was asked:
- The "Skills Available" stat on the ApiKeys promo page and the `/keys/platform-stats`
  backend metric it's adjacent to measure different things (catalog size vs. skills
  actually invoked) — not a bug, but a naming clarity issue worth a product decision.
- No frontend/browser test suite exists in this repo yet — this QA pass used an external
  Playwright+axe harness (see scratch paths below), not a checked-in test. Nothing in this
  pass added one, since that wasn't requested.

## Scratch / cache paths (not cleaned up yet, per instruction)

- QA harness + screenshots + JSON reports: `/private/tmp/claude-502/-Users-reainmaker-Downloads-posture-analysis-claude-kind-galileo-qcm0y1/2d2df713-71a0-4951-abb5-e919784a882c/scratchpad/nexarch-qa` — 27 MB.
- Playwright's downloaded Chromium binary: `~/Library/Caches/ms-playwright` — 2.7 GB.
- Disposable review infrastructure (left running, per instruction): Postgres container
  `anuclaw-dev-pg` on port 55433, dashboard backend on :3722, vite dev server on :5173.
