/**
 * Local integration harness tests (M3): drives a REAL headless Chromium against the OFFLINE fixture page — never a
 * real network request. Covers plan §4's explicit scenario list: prompt submission, completion detection, partial
 * replies, duplicate-submission uncertainty, session expiry, UI drift, quota errors, and cancellation. These need a
 * real browser binary, so they are a bit slower than a unit test but still fully local/offline — no opt-in flag.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedProviderAdapter, UiDriftError } from './simulated-provider-adapter';
import { BrowserProfileHandle } from './contract';

describe('SimulatedProviderAdapter (real headless Chromium, offline fixture)', () => {
  let adapter: SimulatedProviderAdapter;
  let profile: BrowserProfileHandle;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-sim-profile-'));
    profile = { profileId: 'p1', userDataDir: dir };
    adapter = new SimulatedProviderAdapter();
    await adapter.open(profile);
  }, 30_000);
  afterEach(async () => { await adapter.close(profile); fs.rmSync(dir, { recursive: true, force: true }); });

  it('submits a prompt and detects completion with the real reply text', async () => {
    const { submissionId } = await adapter.submitPrompt(profile, 'hello');
    expect(submissionId).toMatch(/^sub-/);
    let result = await adapter.pollCompletion(profile, submissionId);
    expect(result.status).toBe('pending');
    await new Promise((r) => setTimeout(r, 500));
    result = await adapter.pollCompletion(profile, submissionId);
    expect(result.status).toBe('completed'); expect(result.text).toMatch(/complete simulated reply/);
  }, 20_000);

  it('detects a partial reply and then completion after Continue', async () => {
    await adapter._testControl(profile, 'partial-mode');
    const { submissionId } = await adapter.submitPrompt(profile, 'long question');
    await new Promise((r) => setTimeout(r, 500));
    let result = await adapter.pollCompletion(profile, submissionId);
    expect(result.status).toBe('partial'); expect(result.text).toMatch(/first half/);
    // The adapter itself doesn't click Continue — that's the caller's (future M4 agent's) decision; we drive it directly here to prove the full lifecycle.
    const page = (adapter as any).pageFor(profile); await page.locator('[data-testid="continue-btn"]').click();
    await new Promise((r) => setTimeout(r, 400));
    result = await adapter.pollCompletion(profile, submissionId);
    expect(result.status).toBe('completed'); expect(result.text).toMatch(/rest of the reply/);
  }, 20_000);

  it('reports duplicate-submission uncertainty rather than silently accepting a second click while one is in flight', async () => {
    await adapter._testControl(profile, 'slow');
    const first = adapter.submitPrompt(profile, 'q1');
    await new Promise((r) => setTimeout(r, 100)); // ensure the first click registers as "in flight" before the second
    await expect(adapter.submitPrompt(profile, 'q2 (duplicate click)')).rejects.toThrow(/duplicate_uncertain/);
    await first; // let the slow first submission resolve so afterEach's close() doesn't race it
  }, 20_000);

  it('reports a quota-exceeded error explicitly, never as a silent success or a generic failure', async () => {
    await adapter._testControl(profile, 'quota');
    const r = await adapter.pollCompletion(profile, 'sub-0');
    expect(r.status).toBe('error'); expect(r.errorCode).toBe('quota_exceeded');
  });

  it('reports session expiry explicitly', async () => {
    await adapter._testControl(profile, 'expire');
    const r = await adapter.pollCompletion(profile, 'sub-0');
    expect(r.status).toBe('error'); expect(r.errorCode).toBe('session_expired');
  });

  it('UI drift (the provider removing its known controls) is reported as ui_drift, never silently misread', async () => {
    await adapter._testControl(profile, 'drift');
    await expect(adapter.submitPrompt(profile, 'anything')).rejects.toThrow(UiDriftError);
  });

  it('cancellation stops the in-flight submission and is reflected on the next poll', async () => {
    await adapter._testControl(profile, 'slow');
    const { submissionId } = await adapter.submitPrompt(profile, 'to be cancelled');
    await adapter.cancel(profile, submissionId);
    const r = await adapter.pollCompletion(profile, submissionId);
    expect(r.status).toBe('cancelled');
  }, 20_000);

  it('a reconnect (close then reopen against the SAME profile directory) resumes session state rather than losing track of the submission', async () => {
    const { submissionId } = await adapter.submitPrompt(profile, 'resume me');
    await new Promise((r) => setTimeout(r, 500));
    await adapter.close(profile);
    const reopened = new SimulatedProviderAdapter();
    await reopened.open(profile);
    const r = await reopened.pollCompletion(profile, submissionId);
    expect(r.status).toBe('completed'); // the reply had already landed before the close; the reconnect still sees it via the profile's own persisted state
    await reopened.close(profile);
  }, 20_000);
});
