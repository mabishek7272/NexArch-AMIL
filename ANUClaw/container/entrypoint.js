#!/usr/bin/env node
/**
 * ANUClaw agent container entrypoint — the container side of the contract in docs/CONTAINER-CONTRACT.md.
 *
 *  1. FIRST stdin line = JSON credentials object (strings only). They go into the child's environment ONLY: never argv,
 *     never a file, never logged, never echoed in errors.
 *  2. /workspace/group/.anuclaw_context.json = { systemPrompt, sessionMessages, prompt, mediaPath, mediaType } (already
 *     de-identified by the host). mediaPath, if any, is a path INSIDE the container (/workspace/media/...).
 *  3. Runs the agent CLI non-interactively and prints its answer wrapped in <response>…</response> on stdout.
 *  4. Exit codes: 0 ok · 64 bad credentials payload · 65 credentials not received · 66 context missing/invalid ·
 *     67 media missing · 68 agent CLI missing. Anything else is the agent CLI's own exit code.
 *
 * The agent CLI is `claude` unless ANUCLAW_AGENT_CLI is set (host-controlled, non-secret; used by contract tests).
 */
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');

const fail = (code, msg) => { process.stderr.write(`anuclaw-entrypoint: ${msg}\n`); process.exit(code); };

function readFirstLine(timeoutMs) {
  return new Promise((resolve) => {
    let buf = ''; let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(t); process.stdin.pause(); resolve(v); } };
    const t = setTimeout(() => finish(null), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) finish(buf.slice(0, i)); });
    process.stdin.on('end', () => finish(buf.length ? buf : null));
    process.stdin.on('error', () => finish(null));
  });
}

(async () => {
  const line = await readFirstLine(10_000);
  if (line === null) fail(65, 'credentials payload was not received on stdin');
  let creds;
  try { creds = JSON.parse(line); } catch { fail(64, 'credentials payload is not valid JSON'); }
  if (!creds || typeof creds !== 'object' || Array.isArray(creds) || Object.values(creds).some((v) => typeof v !== 'string')) fail(64, 'credentials payload must be an object of strings');
  for (const k of Object.keys(creds)) if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) fail(64, 'credentials payload has an invalid key name');

  let ctx;
  try { ctx = JSON.parse(fs.readFileSync('/workspace/group/.anuclaw_context.json', 'utf8')); } catch { fail(66, 'context file is missing or invalid'); }
  if (typeof ctx.prompt !== 'string') fail(66, 'context has no prompt');
  if (ctx.mediaPath) {
    if (typeof ctx.mediaPath !== 'string' || !ctx.mediaPath.startsWith('/workspace/media/') || ctx.mediaPath.includes('..') || !fs.existsSync(ctx.mediaPath)) fail(67, 'media file is not reachable inside the container');
  }

  const history = (Array.isArray(ctx.sessionMessages) ? ctx.sessionMessages : []).map((m) => `${m.role}: ${m.content}`).join('\n');
  const media = ctx.mediaPath ? `\n\n[attached ${ctx.mediaType || 'file'}: ${ctx.mediaPath}]` : '';
  const prompt = `${history ? `Conversation so far:\n${history}\n\n` : ''}${ctx.prompt}${media}`;

  const cli = process.env.ANUCLAW_AGENT_CLI || 'claude';
  const args = ['-p', prompt, '--dangerously-skip-permissions'];
  if (ctx.systemPrompt) args.push('--append-system-prompt', ctx.systemPrompt);
  if (creds.CLAUDE_MODEL) args.push('--model', creds.CLAUDE_MODEL);
  const mt = process.argv.indexOf('--max-turns');
  if (mt >= 0 && /^\d{1,3}$/.test(process.argv[mt + 1] || '')) args.push('--max-turns', process.argv[mt + 1]);

  // Child environment: a minimal base plus the credentials. Nothing from the parent's other variables leaks in by accident.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', USER: process.env.USER || 'anuclaw', LOGNAME: process.env.LOGNAME || 'anuclaw', ANUCLAW_AGENT: '1', ...(process.env.ANUCLAW_AGENT_CLI ? { ANUCLAW_AGENT_CLI: process.env.ANUCLAW_AGENT_CLI } : {}), ...creds };
  const child = spawn(cli, args, { env, stdio: ['ignore', 'pipe', 'inherit'], cwd: '/workspace' });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('error', () => fail(68, `agent CLI "${cli}" could not be started`));
  child.on('close', (code) => {
    if (code !== 0) process.exit(code || 1);
    process.stdout.write(`<response>${out.trim()}</response>\n`);
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { child.kill(sig); });
})();
