/**
 * Local Playwright integration harness (M3) implementing BrowserResearchAdapter against the offline fixture page at
 * fixtures/simulated-provider.html — never a real network request, never a real provider. This is the "documented
 * bridge contract... local integration harness" the brief asks for in place of a real MCP/provider connection, which
 * remains disabled (see RESEARCH-STUDIO-BROWSER-CONNECTOR.md) until a provider and its terms are chosen.
 *
 * Every page read goes through `data-status`/`data-testid` attributes, never free-text sniffing — a provider
 * changing their copy would not fool this adapter, and (the actual UI-drift test) a provider removing the known
 * controls is reported as `errorCode: 'ui_drift'`, never silently misread as something else.
 */
import * as path from 'path';
import { chromium, BrowserContext, Page } from 'playwright-core';
import { BrowserProfileHandle, BrowserResearchAdapter, SubmissionResult } from './contract';

const FIXTURE_URL = `file://${path.resolve(__dirname, 'fixtures/simulated-provider.html')}`;

export class UiDriftError extends Error { constructor(message: string) { super(message); this.name = 'UiDriftError'; } }

export class SimulatedProviderAdapter implements BrowserResearchAdapter {
  readonly providerId = 'simulated';
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly pages = new Map<string, Page>();

  async open(profile: BrowserProfileHandle): Promise<void> {
    if (this.pages.has(profile.profileId)) return; // idempotent
    const ctx = await chromium.launchPersistentContext(profile.userDataDir, { headless: true });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(FIXTURE_URL);
    const container = await page.locator('[data-testid="rs-sim-provider"]').count();
    if (!container) { await ctx.close(); throw new UiDriftError('The simulated provider page did not load its known container — treated as UI drift, not guessed.'); }
    this.contexts.set(profile.profileId, ctx); this.pages.set(profile.profileId, page);
  }

  private pageFor(profile: BrowserProfileHandle): Page {
    const page = this.pages.get(profile.profileId);
    if (!page) throw new Error('open() must be called before any other adapter method for this profile.');
    return page;
  }

  async submitPrompt(profile: BrowserProfileHandle, prompt: string): Promise<{ submissionId: string }> {
    const page = this.pageFor(profile);
    const input = page.locator('[data-testid="prompt-input"]'); const submit = page.locator('[data-testid="submit-btn"]');
    if (!(await input.count()) || !(await submit.count())) throw new UiDriftError('The prompt input or submit control is missing — the provider page no longer matches the known contract.');
    const preStatus = await page.locator('[data-testid="status-banner"]').getAttribute('data-status');
    if (preStatus === 'quota_exceeded') throw new Error('quota_exceeded: the provider already reports its usage quota is exceeded; no new submission was attempted.');
    if (preStatus === 'session_expired') throw new Error('session_expired: the provider session has already expired; no new submission was attempted.');
    await input.fill(prompt);
    await submit.click();
    await page.waitForFunction(() => { const el = document.querySelector('[data-testid="submission-id"]'); return !!el && !!el.textContent; }, undefined, { timeout: 5000 }).catch(() => {});
    const submissionId = (await page.locator('[data-testid="submission-id"]').textContent())?.trim();
    const status = await page.locator('[data-testid="status-banner"]').getAttribute('data-status');
    if (status === 'duplicate_uncertain') {
      // The submission's fate is genuinely unknown to the caller — never silently reported as a fresh, successful submit.
      throw new Error('duplicate_uncertain: a submission was already in flight; this click may or may not have been received by the provider.');
    }
    if (!submissionId) throw new Error('No submissionId was assigned after submit — treat as unknown, never as a silent success.');
    return { submissionId };
  }

  async pollCompletion(profile: BrowserProfileHandle, submissionId: string): Promise<SubmissionResult> {
    const page = this.pageFor(profile);
    const containerCount = await page.locator('[data-testid="rs-sim-provider"]').count();
    if (!containerCount) return { status: 'error', errorCode: 'ui_drift', errorDetail: 'The provider page container is gone.' };
    const statusEl = page.locator('[data-testid="status-banner"]');
    if (!(await statusEl.count())) return { status: 'error', errorCode: 'ui_drift', errorDetail: 'The status banner control is missing — UI drift.' };
    const seenId = (await page.locator('[data-testid="submission-id"]').textContent())?.trim();
    if (seenId && seenId !== submissionId) return { status: 'error', errorCode: 'unknown', errorDetail: `The page is now tracking a different submission (${seenId}), not ${submissionId}.` };
    const status = await statusEl.getAttribute('data-status');
    const text = (await page.locator('[data-testid="reply-output"]').textContent()) ?? undefined;
    switch (status) {
      case 'pending': return { status: 'pending' };
      case 'partial': return { status: 'partial', text };
      case 'completed': return { status: 'completed', text };
      case 'cancelled': return { status: 'cancelled' };
      case 'quota_exceeded': return { status: 'error', errorCode: 'quota_exceeded', errorDetail: 'The provider reports its usage quota is exceeded.' };
      case 'session_expired': return { status: 'error', errorCode: 'session_expired', errorDetail: 'The provider session has expired; manual re-login is required.' };
      case 'duplicate_uncertain': return { status: 'error', errorCode: 'duplicate_uncertain', errorDetail: 'A prior submission is ambiguous.' };
      default: return { status: 'error', errorCode: 'unknown', errorDetail: `Unrecognised status "${status}".` };
    }
  }

  async cancel(profile: BrowserProfileHandle, _submissionId: string): Promise<void> {
    const page = this.pageFor(profile);
    const btn = page.locator('[data-testid="cancel-btn"]');
    if (await btn.count()) await btn.click();
  }

  async close(profile: BrowserProfileHandle): Promise<void> {
    const ctx = this.contexts.get(profile.profileId);
    if (ctx) { await ctx.close(); this.contexts.delete(profile.profileId); this.pages.delete(profile.profileId); }
  }

  /** Test-only: drive the fixture's own control panel (never used by real adapter logic). */
  async _testControl(profile: BrowserProfileHandle, control: 'partial-mode' | 'quota' | 'expire' | 'drift' | 'slow'): Promise<void> {
    const page = this.pageFor(profile);
    await page.locator(`[data-testid="ctl-${control}"]`).click();
  }
}
