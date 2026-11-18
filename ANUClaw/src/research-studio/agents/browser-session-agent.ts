/**
 * Browser session demo agent (M3), task type 'browser.simulated_demo_session'. Proves the whole M3 stack end to end
 * through the REAL task engine: acquires the profile's session lock, opens the adapter, submits one prompt, polls
 * (each poll spends one unit of the task's own action budget via recordUsage), and ALWAYS releases the lock — even
 * on failure. This agent only ever drives `SimulatedProviderAdapter` — it is not a path to any real provider. A real
 * provider adapter would plug into the exact same task type behind a separate, explicit live-connector flag (see
 * docs/RESEARCH-STUDIO-BROWSER-CONNECTOR.md); none exists yet, and none is silently substituted here.
 *
 * Restart recovery is NOT reimplemented here: if the process crashes mid-task, task-store's existing `sweepStale`
 * recovers the TASK (M1's mechanism, unchanged); profile-service's own `acquireSessionLock` independently sweeps a
 * stale LOCK on its next acquisition attempt. Neither layer needs to know about the other for this to self-heal.
 */
import { AgentHandler } from '../types';
import { registerAgent } from '../agent-registry';
import { recordUsage } from '../task-store';
import { acquireSessionLock, releaseSessionLock, getProfile } from '../browser/profile-service';
import { SimulatedProviderAdapter } from '../browser/simulated-provider-adapter';
import { SubmissionErrorCode, SUBMISSION_ERROR_CODES } from '../browser/contract';

const ERROR_TO_OUTCOME: Partial<Record<SubmissionErrorCode, 'awaiting_user' | 'failed' | 'retryable_failure'>> = {
  session_expired: 'awaiting_user', quota_exceeded: 'awaiting_user', ui_drift: 'failed', duplicate_uncertain: 'retryable_failure', timeout: 'retryable_failure', unknown: 'retryable_failure',
};

const MAX_POLLS = 20; const POLL_DELAY_MS = 150;

/** Maps a classified outcome (from a poll result's errorCode, or a thrown error's leading "code: " prefix — see
 * simulated-provider-adapter.ts#submitPrompt) to a HandlerOutcome, so submission-time and poll-time failures of the
 * same kind are handled identically. */
function outcomeFor(code: SubmissionErrorCode | undefined, reason: string): { kind: 'awaiting_user' | 'failed' | 'retryable_failure'; reason: string } {
  const outcome = ERROR_TO_OUTCOME[code ?? 'unknown'] ?? 'retryable_failure';
  return { kind: outcome, reason };
}
function classifyThrown(e: unknown): { kind: 'awaiting_user' | 'failed' | 'retryable_failure'; reason: string } {
  const message = (e as Error)?.message ?? String(e);
  const match = message.match(/^(\w+):\s*(.*)$/);
  const code = match?.[1] as SubmissionErrorCode | undefined;
  return code && SUBMISSION_ERROR_CODES.includes(code) ? outcomeFor(code, message) : outcomeFor('unknown', message);
}

const browserSessionAgent: AgentHandler = async (ctx) => {
  const params = JSON.parse(ctx.task.params_json) as { profileId?: string; prompt?: string };
  if (!params.profileId || !params.prompt) return { kind: 'failed', reason: 'params.profileId and params.prompt are required.' };
  const profileRow = await getProfile(params.profileId, ctx.project.owner_id);
  if (profileRow.status !== 'active') return { kind: 'awaiting_user', reason: `Browser profile "${profileRow.label}" is "${profileRow.status}", not active. Connect it first (manual login required for a real provider; the simulated provider only needs beginConnect+confirmConnected).` };

  let locked = false;
  try { await acquireSessionLock(profileRow.id, ctx.task.id); locked = true; } catch (e) { return { kind: 'retryable_failure', reason: `Could not acquire the browser session lock: ${(e as Error).message}` }; }

  const adapter = new SimulatedProviderAdapter();
  const handle = { profileId: profileRow.id, userDataDir: profileRow.user_data_dir };
  try {
    await adapter.open(handle);
    let submissionId: string;
    try { ({ submissionId } = await adapter.submitPrompt(handle, params.prompt)); } catch (e) { return classifyThrown(e); }
    for (let i = 0; i < MAX_POLLS; i++) {
      const usage = await recordUsage(ctx.task, ctx.token, { actions: 1 });
      if (!usage.ok) return { kind: 'failed', reason: 'Task action budget exhausted while polling the browser session.' };
      const r = await adapter.pollCompletion(handle, submissionId);
      if (r.status === 'completed') return { kind: 'completed', result: { schema: 'anuclaw-research-studio-browser-session/v1', providerId: adapter.providerId, submissionId, text: r.text } };
      if (r.status === 'cancelled') return { kind: 'failed', reason: 'The submission was cancelled.' };
      if (r.status === 'error') return outcomeFor(r.errorCode, r.errorDetail ?? r.errorCode ?? 'unknown browser session error');
      await new Promise((res) => setTimeout(res, POLL_DELAY_MS));
    }
    return { kind: 'retryable_failure', reason: `No completion after ${MAX_POLLS} polls.` };
  } finally {
    await adapter.close(handle).catch(() => {});
    if (locked) await releaseSessionLock(profileRow.id, ctx.task.id).catch(() => {});
  }
};

export function registerBrowserSessionAgent(): void { registerAgent('browser.simulated_demo_session', browserSessionAgent); }
