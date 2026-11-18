/**
 * runAgent policy enforcement. Container runtime is mocked as UNAVAILABLE (spawn
 * error) so the text-only host path runs; the provider HTTP call is mocked.
 * No real model, container or database is used.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmp, llm, logs } = vi.hoisted(() => {
  const fs_ = require('fs') as typeof import('fs');
  const os_ = require('os') as typeof import('os');
  const path_ = require('path') as typeof import('path');
  return {
    tmp: fs_.mkdtempSync(path_.join(os_.tmpdir(), 'runagent-')),
    llm: { provider: 'openrouter', openrouterApiKey: 'sk-or-test-not-a-real-key-000000', openrouterBaseUrl: 'https://provider.invalid/api/v1', openrouterModel: 'test/model', openrouterReasoningEffort: 'medium' } as any,
    logs: [] as string[],
  };
});

vi.mock('child_process', () => ({
  execSync: () => { throw new Error('no apple container'); },
  spawn: () => {
    const p: any = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = Object.assign(new EventEmitter(), { write: () => true, end: () => {} });
    p.kill = () => {};
    setImmediate(() => p.emit('error', Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })));
    return p;
  },
}));
vi.mock('./config', () => ({
  config: {
    llm,
    agent: { groupsDir: path.join(tmp, 'groups'), workspaceDir: path.join(tmp, 'ws'), maxSessionMessages: 80, containerTimeoutMs: 5000, containerImage: 'x' },
  },
}));
vi.mock('./memory', () => ({ buildMemoryContext: vi.fn(async () => ''), saveMemory: vi.fn(async () => {}), compactMessages: (m: any) => m }));
vi.mock('./soul', () => ({ loadSoul: vi.fn(async () => '') }));
vi.mock('./rag', () => ({ retrieveContext: vi.fn(async () => '') }));
vi.mock('./logger', () => {
  const rec = (m: string, ...a: unknown[]) => { logs.push([m, ...a.map((x) => JSON.stringify(x))].join(' ')); };
  return { logger: { info: rec, warn: rec, error: rec, debug: rec } };
});
vi.mock('axios', () => ({ default: { post: vi.fn() } }));

import axios from 'axios';
import { runAgent, HOST_TEXT_ONLY_DIRECTIVE } from './container-runner';
import { registerHook, unregisterHook } from './hooks';

const post = vi.mocked(axios.post);
const reply = (content: string) => ({ data: { choices: [{ message: { content } }] } });
const sentBody = () => JSON.stringify(post.mock.calls.at(-1)?.[1] ?? {});
const TEST_HOOKS = ['t-block', 't-throw', 't-modify', 't-after-block'];

beforeEach(() => {
  post.mockReset();
  logs.length = 0;
  llm.provider = 'openrouter';
  delete process.env.LLM_BAA_COVERED;
  delete process.env.ELAB_DEID_REQUIRED;
});
afterEach(() => { for (const h of TEST_HOOKS) unregisterHook(h); });

describe('hooks are enforced inside runAgent (every entry point)', () => {
  it('BeforeLLMCall block → explicit error, no provider call', async () => {
    registerHook('t-block', 'BeforeLLMCall', () => ({ outcome: 'block', reason: 'test' }), 1);
    const r = await runAgent({ groupId: 'g1', channel: 'pipeline', prompt: 'hello there' });
    expect(r.error).toBe('blocked_by_policy:t-block');
    expect(r.text).toBe('');
    expect(post).not.toHaveBeenCalled();
  });

  it('a hook that throws blocks (fail closed)', async () => {
    registerHook('t-throw', 'BeforeLLMCall', () => { throw new Error('boom'); }, 1);
    const r = await runAgent({ groupId: 'g1', prompt: 'hello there' });
    expect(r.error).toBe('blocked_by_policy:t-throw');
    expect(post).not.toHaveBeenCalled();
  });

  it('BeforeLLMCall modified prompt is the one sent', async () => {
    registerHook('t-modify', 'BeforeLLMCall', (ctx) => ({ outcome: 'modify', payload: { ...ctx.payload, prompt: 'REWRITTEN PROMPT' } }), 1);
    post.mockResolvedValue(reply('ok'));
    await runAgent({ groupId: 'g1', prompt: 'original prompt' });
    expect(sentBody()).toContain('REWRITTEN PROMPT');
    expect(sentBody()).not.toContain('original prompt');
  });

  it('AfterToolCall block withholds the output', async () => {
    registerHook('t-after-block', 'AfterToolCall', () => ({ outcome: 'block' }), 1);
    post.mockResolvedValue(reply('secret output'));
    const r = await runAgent({ groupId: 'g1', prompt: 'hello there' });
    expect(r.error).toBe('output_blocked_by_policy:t-after-block');
    expect(r.text).toBe('');
  });
});

describe('pre-egress privacy', () => {
  const PROMPT = 'Summarise for patient name: Jane Synthetic, MRN: SYN12345, email jane@synthetic.invalid, seen 2026-01-02.';

  it('de-identifies before egress and re-identifies the reply locally', async () => {
    post.mockResolvedValue(reply('Summary for [NAME_1] ([MRN_1]).'));
    const r = await runAgent({ groupId: 'g1', prompt: PROMPT });
    const body = sentBody();
    for (const id of ['Jane Synthetic', 'SYN12345', 'jane@synthetic.invalid', '2026-01-02']) expect(body).not.toContain(id);
    expect(r.text).toBe('Summary for Jane Synthetic (SYN12345).');
    expect(r.egress).toMatchObject({ mode: 'deidentified' });
    expect(r.egress!.redactions).toBeGreaterThanOrEqual(4);
  });

  it('sends raw text only when the provider is declared BAA-covered', async () => {
    process.env.LLM_BAA_COVERED = 'true';
    post.mockResolvedValue(reply('ok'));
    const r = await runAgent({ groupId: 'g1', prompt: PROMPT });
    expect(sentBody()).toContain('SYN12345');
    expect(r.egress?.mode).toBe('raw_baa_covered');
  });

  it('withholds raw media under de-identification', async () => {
    post.mockResolvedValue(reply('ok'));
    const r = await runAgent({ groupId: 'g1', prompt: 'look at this', mediaPath: '/tmp/scan.png', mediaType: 'image' });
    expect(r.warnings.join(' ')).toMatch(/media was not provided/);
  });
});

describe('text-only host fallback is honest', () => {
  it('labels the mode, adds the no-tools directive, and writes no artifacts from model text', async () => {
    post.mockResolvedValue(reply('Done. [FILE_START: report.txt]fabricated[FILE_END]'));
    const r = await runAgent({ groupId: 'g-files', prompt: 'make a report' });
    expect(r.executionMode).toBe('host_text_only');
    expect(r.artifacts).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/no tools or engines were run/);
    expect(sentBody()).toContain(HOST_TEXT_ONLY_DIRECTIVE.split('\n')[1]);
    expect(fs.existsSync(path.join(tmp, 'ws', 'g-files', 'report.txt'))).toBe(false);
  });

  it('provider failure → explicit error, no text, no key in logs', async () => {
    const err: any = new Error('Request failed with status code 500');
    err.config = { headers: { Authorization: `Bearer ${llm.openrouterApiKey}` } };
    err.response = { status: 500, data: { error: { message: 'upstream body' } } };
    post.mockRejectedValue(err);
    const r = await runAgent({ groupId: 'g1', prompt: 'hello there' });
    expect(r.error).toBe('provider_request_failed');
    expect(r.text).toBe('');
    expect(logs.join('\n')).not.toContain(llm.openrouterApiKey);
  });

  it('empty provider response is an error, not success', async () => {
    post.mockResolvedValue(reply('   '));
    const r = await runAgent({ groupId: 'g1', prompt: 'hello there' });
    expect(r.error).toBe('provider_empty_response');
  });

  it('unsupported provider sets an error (previously returned as normal text)', async () => {
    llm.provider = 'anthropic';
    const r = await runAgent({ groupId: 'g1', prompt: 'hello there' });
    expect(r.error).toBe('host_fallback_unsupported_provider:anthropic');
    expect(r.text).toBe('');
    expect(post).not.toHaveBeenCalled();
  });

  it('no silent self-rewrite: exactly one provider call per run', async () => {
    post.mockResolvedValue(reply('answer'));
    await runAgent({ groupId: 'g1', prompt: 'hello there' });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('the host text-only fallback goes through the guarded model transport (spend ledger included)', () => {
  it('is reserved against the caller scope and settled; a refused reservation makes NO provider call', async () => {
    const { setSpendHooks } = await import('./ai/openrouter');
    const seen: any[] = []; const settled: any[] = [];
    setSpendHooks({ reserve: async (ctx) => { seen.push(ctx); return { ok: true, token: 't1', accounting: 'settled' }; }, settle: async (_t, o) => { settled.push(o); } });
    try {
      post.mockResolvedValue({ status: 200, data: { model: 'test/model', choices: [{ message: { content: 'ok text' } }], usage: { cost: 0.001 } } });
      const r = await runAgent({ groupId: 'g-spend', prompt: 'hello', scope: { kind: 'user', id: 'u-9' } });
      expect(r.executionMode).toBe('host_text_only'); expect(r.text).toBe('ok text');
      expect(seen[0]).toMatchObject({ role: 'review', scope: { kind: 'user', id: 'u-9' }, dataClass: 'patient_derived' });
      expect(settled[0]).toMatchObject({ costRaw: 0.001 });
      expect((post.mock.calls[0][1] as any).usage).toEqual({ include: true });         // the transport asked the provider to report cost

      post.mockClear();
      setSpendHooks({ reserve: async () => ({ ok: false, reason: 'daily global model budget would be exceeded' }) });
      const blocked = await runAgent({ groupId: 'g-spend2', prompt: 'hello' });
      expect(blocked.error).toBe('spend_limit_reached'); expect(blocked.text).toBe(''); expect(blocked.executionMode).toBe('none');
      expect(post).not.toHaveBeenCalled();

      // default scope when the caller names none: the group, as a system scope
      seen.length = 0; setSpendHooks({ reserve: async (ctx) => { seen.push(ctx); return { ok: true, token: null }; } });
      post.mockResolvedValue({ status: 200, data: { model: 'test/model', choices: [{ message: { content: 'ok' } }] } });
      await runAgent({ groupId: 'g-default', prompt: 'hello' });
      expect(seen[0].scope).toEqual({ kind: 'system', id: 'group:g-default' });
    } finally { setSpendHooks({}); }
  });
});
