/**
 * Provider-neutral browser research transport (M3, plan §4). This is the DOCUMENTED BRIDGE CONTRACT the brief asks
 * for in the absence of an installed MCP server (confirmed again for this pass: `grep -iE
 * '"(playwright|mcp|@modelcontextprotocol)' package.json` shows only `playwright-core`; no MCP client/server package
 * exists and none was discovered as configured in this environment). Every provider adapter — real or simulated —
 * implements exactly this interface, so a future MCP-backed adapter can be dropped in without changing any caller.
 *
 * A "submission" is one user-authored prompt sent through a connected browser session. The adapter never interprets
 * a submission's resulting page content as instructions — it only classifies completion state and extracts text.
 * The caller (an M4 agent, once built) is responsible for treating that text as untrusted data, exactly like any
 * other evidence source in this codebase.
 */

export const SUBMISSION_STATUSES = ['pending', 'partial', 'completed', 'error', 'cancelled'] as const;
export type SubmissionStatus = typeof SUBMISSION_STATUSES[number];

/** Why a poll could not classify the page cleanly — never silently treated as 'completed'. */
export const SUBMISSION_ERROR_CODES = [
  'session_expired', 'quota_exceeded', 'ui_drift', 'duplicate_uncertain', 'cancelled', 'timeout', 'unknown',
] as const;
export type SubmissionErrorCode = typeof SUBMISSION_ERROR_CODES[number];

export interface SubmissionResult {
  status: SubmissionStatus;
  /** Present once status is 'completed' or 'partial'. Untrusted data — never executed, never trusted as fact. */
  text?: string;
  errorCode?: SubmissionErrorCode;
  errorDetail?: string;
}

export interface BrowserProfileHandle {
  /** Opaque to the adapter; profile-service.ts maps this to a local, on-disk Playwright user-data directory. Never a credential. */
  profileId: string;
  /** Local filesystem path to the profile's isolated browser context directory (never committed, never logged verbatim). */
  userDataDir: string;
}

/**
 * One provider adapter per external AI-provider page shape. `submitPrompt` and `pollCompletion` are the only two
 * calls a caller needs for the whole lifecycle; `cancel` and `close` are explicit, not implied by a timeout.
 */
export interface BrowserResearchAdapter {
  readonly providerId: string;
  /** Opens (or reuses) a browser context bound to this profile and navigates to the provider's drafting page. Throws if the session is not authenticated (manual login required — see profile-service.ts's `connecting` state) or UI drift makes the page unrecognisable. */
  open(profile: BrowserProfileHandle): Promise<void>;
  /** Submits ONE prompt. Returns a submissionId the caller persists (task params) so a retry after an uncertain network response can be told apart from a genuinely new submission — see plan §4's "duplicate browser submissions" requirement. */
  submitPrompt(profile: BrowserProfileHandle, prompt: string): Promise<{ submissionId: string }>;
  /** Classifies the current state for a previously-submitted prompt. Must be safe to call repeatedly (idempotent read). */
  pollCompletion(profile: BrowserProfileHandle, submissionId: string): Promise<SubmissionResult>;
  /** Best-effort cancellation of an in-flight submission. */
  cancel(profile: BrowserProfileHandle, submissionId: string): Promise<void>;
  /** Releases the browser context. Must not delete the profile's on-disk data (that is profile-service.ts's job, only on explicit disconnect/revoke). */
  close(profile: BrowserProfileHandle): Promise<void>;
}
