# NexArch Lab — Playwright e2e/accessibility suite

Checked-in replacement for the throwaway `qa.mjs` scratch script used during the manual
NexArch review passes. Covers `/nexarch`, `/nexarch/research-studio`, `/nexarch/connections`,
and `/nexarch/style-guide` at 1440×900, 1280×800, 1024×768 and 768×1024 (one Playwright
"project" per viewport — every spec runs under all four automatically).

## Running it

This suite drives a **disposable dev stack you already have running** — it never runs
against production, and it never embeds a credential. You must set four environment
variables; if any is missing, the suite **fails immediately** (at config-load time, before
any test or even global-setup runs) rather than silently reporting zero tests as a pass:

```bash
export NEXARCH_QA_BASE_URL=http://localhost:5173   # the app origin the browser loads (vite dev server, or a built+served dashboard)
export NEXARCH_QA_API_URL=http://localhost:3722    # the dashboard backend origin (direct, not through the vite proxy)
export NEXARCH_QA_EMAIL=you@example.test           # a disposable test account — see below
export NEXARCH_QA_PASSWORD='...'

cd dashboard
npx playwright install chromium   # one-time, downloads to ~/Library/Caches/ms-playwright — never into the repo
npm run test:e2e
```

**The test account must have the `admin` role** — the full-nav-visibility assertion in
`nav.spec.ts` checks that every one of the 13 nav items + 2 footer items is visible, which
is only true for `admin` (see `dashboard/src/nexarch/nav.ts`'s `roles` arrays). Create one
the same way the manual QA passes did: set `ANUCLAW_BOOTSTRAP_ADMIN_EMAIL` /
`ANUCLAW_BOOTSTRAP_ADMIN_PASSWORD` on a dashboard backend with zero existing users (see the
dashboard's own `.env.example`) — never reuse a real account.

## What it does on every run

`global-setup.ts` creates its own ephemeral, unambiguously-`SYNTHETIC`-labeled Research
Studio project (title timestamped so repeated runs don't collide) plus one placeholder
source, via the real API — so no test depends on, or needs to clean up after, another test
or any manual-testing leftovers. There is no delete-project endpoint in this API today, so
fixture projects accumulate in whatever database the suite points at; that's expected and
fine for a disposable dev/test Postgres, and is exactly why this suite must never be pointed
at a real database.

## What's covered

- Direct-route refresh (every route hit fresh, not via client-side nav) returns 200 with
  real rendered content.
- Zero console/page errors on every route × viewport combination.
- `@axe-core/playwright` — zero violations of any severity on every route × viewport. A
  failure's assertion message includes the exact Playwright/axe output (selectors and
  failure summaries), not just a count.
- Responsive navigation (below 1180px): the permanent sidebar is absent, the menu button is
  reachable via Tab alone, and the overlay drawer gets the full `assertDrawerAccessibility`
  treatment (see below) plus role-filtered content, preview-item non-navigation, and a real
  item both navigating and closing the drawer.
- Desktop navigation (1280px/1440px): sidebar stays a fixed 234px, no menu button appears,
  every admin-visible nav item renders, preview items are `aria-disabled` and inert on click.
- The Research Studio provenance drawer (narrow viewports) gets the identical
  `assertDrawerAccessibility` treatment as the nav drawer — both use the same underlying
  `Drawer` component (`dashboard/src/nexarch/ui.tsx`), so `e2e/helpers/drawer.ts` holds the
  check once rather than duplicating it per caller. At ≥1180px the same panel renders as a
  fixed `<aside>`, not a drawer — asserted explicitly so a regression toward "always a
  drawer" or "never a drawer" is caught either way.
- "No fabricated values": Overview and Research Studio are asserted to show the suite's own
  real fixture data, and to never contain a fixed list of previously-seen fabricated
  placeholder strings (`31 sources`, `RUN-7C1F`, `48,112`, `1,100+`).

`assertDrawerAccessibility` (`e2e/helpers/drawer.ts`) checks, for any Drawer-pattern overlay
given its trigger element: the trigger opens it, focus moves inside immediately, the
background (`#root`) becomes inert, Tab/Shift+Tab never escape the drawer across 20 presses,
the close control has a real accessible name, Escape closes it, and focus returns to the
exact trigger element afterward.

## Known limitations

- **Role-filtered navigation is only verified for `admin`.** Every item in `nav.ts` includes
  `admin` in its `roles` array, so this suite asserts the admin test account sees all 13 nav
  items + 2 footer items. It does **not** create a second test user with a different role
  (operator/viewer/auditor/compliance/clinician) to assert a *different*, correctly-narrower
  nav subset — doing that cleanly needs either a second bootstrap-admin-style env-var path or
  a dashboard admin API to create a non-admin user, neither of which this pass added. If that
  matters for a release decision, it needs a deliberate follow-up, not a quick patch bolted
  onto this suite.
- **No PostgreSQL/backend test suite was re-run as part of this work.** Everything here is a
  frontend Playwright harness plus one UI copy/metric fix
  (`dashboard/src/pages/ApiKeys.tsx`'s "Skills Available" split) — nothing in this pass
  touches `services/backend-api`, `packages/schemas`, persistence, or authentication setup.
- This suite talks to whatever dev stack is already running at `NEXARCH_QA_BASE_URL` /
  `NEXARCH_QA_API_URL` — it does not start, stop, or manage that stack itself.
