/**
 * CONTAINER CONTRACT (plan F10) against a REAL container runtime (Docker). Opt-in:
 *   ANUCLAW_CONTAINER_TESTS=1 [ANUCLAW_CONTRACT_IMAGE=anuclaw-contract:thin] npx vitest run src/container-contract.test.ts
 *
 * The agent CLI inside the image is a TEST DOUBLE (container/contract/fake-claude.js) — NO model is called, no money is spent.
 * What this proves: bootstrap (entrypoint), credentials via stdin only, media/skills/output mounts, non-root + hardening flags,
 * timeout kills the container, agent failure ≠ silent text-only fallback, runtime/image absence → labelled fallback.
 * What it does NOT prove: that the real `claude` CLI completes a task, or that scientific tools exist (only the FULL image,
 * ANUCLAW_CONTRACT_IMAGE=anuclaw-agent:…, is checked for those, in the last describe block).
 */
import { execFileSync, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ENABLED = process.env.ANUCLAW_CONTAINER_TESTS === '1';
const IMAGE = process.env.ANUCLAW_CONTRACT_IMAGE ?? 'anuclaw-contract:thin';
const SECRET = 'sk-or-CONTRACT-TEST-SECRET-0123456789abcdef';

const { tmp, cfg, logs } = vi.hoisted(() => {
  const fs_ = require('fs') as typeof import('fs'), os_ = require('os') as typeof import('os'), path_ = require('path') as typeof import('path');
  const tmp_ = fs_.mkdtempSync(path_.join(os_.tmpdir(), 'contract-'));
  return {
    tmp: tmp_, logs: [] as string[],
    cfg: {
      llm: { provider: 'openrouter', openrouterApiKey: 'sk-or-CONTRACT-TEST-SECRET-0123456789abcdef', openrouterBaseUrl: 'https://provider.invalid/api/v1', openrouterModel: 'contract/model', openrouterReasoningEffort: 'medium' },
      agent: { groupsDir: path_.join(tmp_, 'groups'), workspaceDir: path_.join(tmp_, 'ws'), maxSessionMessages: 80, containerTimeoutMs: 60_000, containerImage: process.env.ANUCLAW_CONTRACT_IMAGE ?? 'anuclaw-contract:thin' },
    } as any,
  };
});
vi.mock('./config', () => ({ config: cfg }));
vi.mock('./memory', () => ({ buildMemoryContext: vi.fn(async () => ''), saveMemory: vi.fn(async () => {}), compactMessages: (m: any) => m }));
vi.mock('./soul', () => ({ loadSoul: vi.fn(async () => '') }));
vi.mock('./rag', () => ({ retrieveContext: vi.fn(async () => '') }));
vi.mock('./logger', () => { const rec = (m: string) => { logs.push(m); }; return { logger: { info: rec, warn: rec, error: rec, debug: rec } }; });
vi.mock('axios', () => ({ default: { post: vi.fn(async () => ({ status: 200, data: { model: 'contract/model', choices: [{ message: { content: 'HOST TEXT ONLY ANSWER' } }], usage: { cost: 0 } } })) } }));

import axios from 'axios';
import { runAgent } from './container-runner';

const post = vi.mocked(axios.post);
const docker = (...a: string[]) => spawnSync('docker', a, { encoding: 'utf8' });
const run = (prompt: string, extra: Record<string, unknown> = {}) => runAgent({ groupId: `ct-${crypto.randomBytes(3).toString('hex')}`, channel: 'contract-test', prompt, ...extra } as any);
const json = (text: string) => JSON.parse(text);

describe.skipIf(!ENABLED)(`container contract (real Docker, image ${IMAGE}, test-double agent CLI)`, () => {
  beforeAll(() => {
    process.env.ELAB_DEID_REQUIRED = 'false';                       // raw egress path so media is allowed through (warned, not de-identified)
    process.env.CONTAINER_EXTRA_ENV = 'ANUCLAW_AGENT_CLI=/opt/contract-tools/fake-claude';
    const v = docker('version', '--format', '{{.Server.Version}}'); expect(v.status, 'docker daemon must be running').toBe(0);
    expect(docker('image', 'inspect', IMAGE).status, `image ${IMAGE} must exist (docker build -t … -f container/Dockerfile.contract container)`).toBe(0);
  }, 60_000);
  beforeEach(() => { post.mockClear(); logs.length = 0; cfg.agent.containerTimeoutMs = 60_000; cfg.agent.containerImage = IMAGE; });

  it('bootstrap: the entrypoint receives the credentials on stdin, runs the agent CLI and returns <response>; runs as the host user, not root', async () => {
    const r = await run('MODE:ENV please');
    expect(r.error).toBeUndefined(); expect(r.executionMode).toBe('container');
    const o = json(r.text);
    expect(o.uid).toBe(process.getuid!()); expect(o.uid).not.toBe(0);
    expect(o.apiKeyPresent).toBe(true); expect(o.baseUrlPresent).toBe(true);
    expect(o.argvHasKey).toBe(false);                                // the key was never on the agent CLI's command line
    expect(post).not.toHaveBeenCalled();                             // the real container ran; no text-only fallback
  }, 90_000);

  it('credentials are NOT in argv, `docker inspect`, files or logs; hardening flags are applied; the container is gone afterwards', async () => {
    cfg.agent.containerTimeoutMs = 90_000;
    const gid = `ct-inspect-${crypto.randomBytes(3).toString('hex')}`;
    const p = runAgent({ groupId: gid, channel: 'contract-test', prompt: 'MODE:SLEEP' } as any);
    let name = '';
    for (let i = 0; i < 60 && !name; i++) { await new Promise((r) => setTimeout(r, 500)); name = docker('ps', '--filter', `name=anuclaw-${gid}`, '--format', '{{.Names}}').stdout.trim(); }
    expect(name, 'container did not start').toBeTruthy();
    const inspect = docker('inspect', name).stdout;
    expect(inspect).not.toContain(SECRET); expect(inspect).not.toMatch(/ANTHROPIC_API_KEY|OPENROUTER_API_KEY/);
    const hc = JSON.parse(inspect)[0].HostConfig;
    expect(hc.CapDrop).toEqual(['ALL']); expect(hc.SecurityOpt).toContain('no-new-privileges'); expect(hc.PidsLimit).toBe(512);
    expect(hc.Memory).toBe(4 * 1024 ** 3); expect(JSON.parse(inspect)[0].Config.User).toBe(`${process.getuid!()}:${process.getgid!()}`);
    // No host process that launches or talks to the container carries the key on its command line.
    const hostArgs = spawnSync('ps', ['-axo', 'args='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /\bdocker\b.*\brun\b|--name anuclaw-|anuclaw-entrypoint/.test(l) && !/vitest|eval '/.test(l));
    expect(hostArgs.length, 'the docker client process should be visible to this check').toBeGreaterThan(0);
    expect(hostArgs.join('\n')).not.toContain(SECRET);
    docker('rm', '-f', name);                                        // end the sleep early
    await p;
    for (const dir of [cfg.agent.groupsDir, cfg.agent.workspaceDir]) {
      const files = spawnSync('grep', ['-rl', SECRET, dir], { encoding: 'utf8' }).stdout.trim();
      expect(files, `secret found on disk in ${dir}`).toBe('');
    }
    expect(logs.join('\n')).not.toContain(SECRET);
  }, 120_000);

  it('timeout: the run fails with agent_timeout (never a silent text-only re-run) and the container is removed', async () => {
    cfg.agent.containerTimeoutMs = 4_000;
    const gid = `ct-timeout-${crypto.randomBytes(3).toString('hex')}`;
    const r = await runAgent({ groupId: gid, channel: 'contract-test', prompt: 'MODE:SLEEP' } as any);
    expect(r.error).toBe('agent_timeout'); expect(r.executionMode).toBe('container'); expect(post).not.toHaveBeenCalled();
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) { await new Promise((x) => setTimeout(x, 500)); alive = docker('ps', '-q', '--filter', `name=anuclaw-${gid}`).stdout.trim().length > 0; }
    expect(alive, 'container survived the timeout').toBe(false);
  }, 60_000);

  it('APPLICATION PATH: runAgent (the normal execution path) starts a hardened container, a scripted job runs REAL tools inside it, and the result comes back as a host-owned artifact', async () => {
    // Boundary: the agent CLI here is the test double (no Claude, no model call). It proves the application's orchestration — runtime/hardening/credential
    // delivery/artifact return — and that the tools run inside that container. It does NOT prove that a Claude agent decides to call them.
    const r = await run('MODE:JOB');
    expect(r.error).toBeUndefined(); expect(r.executionMode).toBe('container'); expect(post).not.toHaveBeenCalled();
    expect(r.artifacts).toHaveLength(1);
    const out = JSON.parse(fs.readFileSync(r.artifacts[0], 'utf8'));
    expect(out).toMatchObject({ tool: 'samtools+rdkit', mappedReads: 2, aspirinMolWt: 180.16, status: [0, 0] });
    expect(fs.statSync(r.artifacts[0]).uid).toBe(process.getuid!());
  }, 120_000);

  it('output: files the agent writes to /workspace/output come back as artifacts, owned by the host user', async () => {
    const r = await run('MODE:WRITE');
    expect(r.error).toBeUndefined(); expect(r.artifacts).toHaveLength(1);
    expect(fs.readFileSync(r.artifacts[0], 'utf8')).toBe('artifact from the container');
    expect(fs.statSync(r.artifacts[0]).uid).toBe(process.getuid!());
  }, 90_000);

  it('media: the host file is mounted read-only at a container path and is byte-identical; a missing file is an error, not a silent drop', async () => {
    const f = path.join(tmp, 'sample image (1).png'); const bytes = crypto.randomBytes(2048); fs.writeFileSync(f, bytes);
    const r = await run('MODE:MEDIA', { mediaPath: f, mediaType: 'image' });
    expect(r.error).toBeUndefined();
    const o = json(r.text);
    expect(o.media).toMatch(/^\/workspace\/media\/sample_image__1_\.png$/);
    expect(o.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    expect(o.writable).toBe(false);
    const missing = await run('MODE:MEDIA', { mediaPath: path.join(tmp, 'nope.png'), mediaType: 'image' });
    expect(missing).toMatchObject({ error: 'media_not_found', executionMode: 'none' });
  }, 90_000);

  it('skills are mounted read-only', async () => {
    const o = json((await run('MODE:SKILLS')).text);
    expect(o.skills).toBe(true); expect(o.skillsWritable).toBe(false);
  }, 90_000);

  it('the configured model is passed to the agent CLI (and nothing else about credentials is)', async () => {
    const o = json((await run('hello')).text);
    expect(o.model).toBe('contract/model');
  }, 90_000);

  it('agent failure: a non-zero exit of the agent is an ERROR of this run — it is not answered by the tool-less host fallback', async () => {
    const r = await run('MODE:FAIL');
    expect(r.error).toBe('agent_failed:exit_3'); expect(r.executionMode).toBe('container'); expect(r.text).toBe('');
    expect(post).not.toHaveBeenCalled();
  }, 90_000);

  it('runtime/image unavailable: falls back to LABELLED text-only (no tools, no artifacts)', async () => {
    cfg.agent.containerImage = 'anuclaw-no-such-image-xyz:0.0.0';
    const r = await run('anything');
    expect(r.executionMode).toBe('host_text_only'); expect(r.artifacts).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/Container execution unavailable.*no tools or engines were run/);
    expect(post).toHaveBeenCalledTimes(1);
    expect(r.text).toBe('HOST TEXT ONLY ANSWER');
  }, 120_000);

  describe('entrypoint error contract (direct docker runs)', () => {
    const entry = (stdin: string, mounts: string[] = []) => spawnSync('docker', ['run', '--rm', '-i', ...mounts, '-e', 'ANUCLAW_AGENT_CLI=/opt/contract-tools/fake-claude', IMAGE], { input: stdin, encoding: 'utf8' });
    const ctxDir = () => { const d = fs.mkdtempSync(path.join(tmp, 'ctx-')); fs.chmodSync(d, 0o755); return d; };
    it('no credentials line → exit 65; malformed → 64 without echoing the payload', () => {
      expect(entry('').status).toBe(65);
      const bad = entry('{"ANTHROPIC_API_KEY": 12345, "x": "SECRET-IN-STDERR-CHECK"\n');
      expect(bad.status).toBe(64); expect(bad.stderr).not.toContain('SECRET-IN-STDERR-CHECK');
      expect(entry('{"lowercase":"x"}\n').status).toBe(64);
      expect(entry('["a"]\n').status).toBe(64);
    }, 60_000);
    it('valid credentials but no/invalid context → exit 66', () => {
      expect(entry('{"ANTHROPIC_API_KEY":"k"}\n').status).toBe(66);
      const d = ctxDir(); fs.writeFileSync(path.join(d, '.anuclaw_context.json'), '{not json'); fs.chmodSync(path.join(d, '.anuclaw_context.json'), 0o644);
      expect(entry('{"ANTHROPIC_API_KEY":"k"}\n', ['-v', `${d}:/workspace/group`]).status).toBe(66);
    }, 60_000);
    it('media path outside /workspace/media or unreachable → exit 67', () => {
      for (const mediaPath of ['/etc/passwd', '/workspace/media/../../etc/passwd', '/workspace/media/missing.png']) {
        const d = ctxDir(); const f = path.join(d, '.anuclaw_context.json');          // a fresh directory per case (bind-mount caching)
        fs.writeFileSync(f, JSON.stringify({ prompt: 'x', mediaPath })); fs.chmodSync(f, 0o644);
        expect(entry('{"ANTHROPIC_API_KEY":"k"}\n', ['-v', `${d}:/workspace/group`]).status, mediaPath).toBe(67);
      }
    }, 60_000);
    it('missing agent CLI → exit 68', () => {
      const d = ctxDir(); const f = path.join(d, '.anuclaw_context.json'); fs.writeFileSync(f, JSON.stringify({ prompt: 'x' })); fs.chmodSync(f, 0o644);
      const r = spawnSync('docker', ['run', '--rm', '-i', '-v', `${d}:/workspace/group`, '-e', 'ANUCLAW_AGENT_CLI=/no/such/cli', IMAGE], { input: '{"ANTHROPIC_API_KEY":"k"}\n', encoding: 'utf8' });
      expect(r.status).toBe(68);
    }, 60_000);
  });
});

// ── FULL image: ACTUAL TOOL EXECUTION on small deterministic fixtures (not version banners) ─────────────────────────────────────────────────
// A tool "works" here only if it produces the exact expected result for a fixture. `claude --version` is CLI STARTUP only and is labelled so.
// Run with ANUCLAW_CONTRACT_IMAGE=<full image>. Skipped for the thin contract image. Nothing here calls a model or spends money.
const FULL = ENABLED && IMAGE !== 'anuclaw-contract:thin';
const sh = (script: string, image = IMAGE) => spawnSync('docker', ['run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`, '--tmpfs', '/tmp:rw,exec,mode=1777', '-e', 'HOME=/tmp', '-e', 'USER=anuclaw', '-e', 'LOGNAME=anuclaw', '--entrypoint', 'bash', image, '-c', `set -e; cd /tmp; ${script}`], { encoding: 'utf8' });
const run7 = (name: string, script: string, check: (out: string) => void, timeout = 180_000) => it(name, () => { const r = sh(script); expect(r.status, `${name}: ${r.stderr.slice(0, 400)}`).toBe(0); check(r.stdout.trim()); }, timeout);

describe.skipIf(!FULL)(`full image — the 7 core tool smoke tests (${IMAGE}): real execution on deterministic fixtures`, () => {
  run7('1/7 samtools: SAM → BAM → count and flagstat give the exact expected numbers',
    `printf '@HD\tVN:1.6\n@SQ\tSN:chr1\tLN:100\nr1\t0\tchr1\t1\t60\t4M\t*\t0\t0\tACGT\tIIII\nr2\t16\tchr1\t10\t60\t4M\t*\t0\t0\tTTTT\tIIII\nr3\t4\t*\t0\t0\t*\t*\t0\t0\tGGGG\tIIII\n' > t.sam; samtools view -b t.sam > t.bam; echo "total=$(samtools view -c t.bam) mapped=$(samtools view -c -F 4 t.bam) reverse=$(samtools view -c -f 16 t.bam)"; samtools flagstat t.bam | head -1`,
    (o) => { expect(o).toContain('total=3 mapped=2 reverse=1'); expect(o).toMatch(/3 \+ 0 in total/); });
  run7('2/7 blastn: makeblastdb on a tiny subject, an exact-substring query hits it at 100% identity',
    `printf '>subj1\nACGTACGTTAGCTAGCTAGGATCGATCGATCGTAGCTAGCTAGCTAGCATCGATCG\n>subj2\nTTTTTTTTTTGGGGGGGGGGCCCCCCCCCCAAAAAAAAAA\n' > s.fa; printf '>q\nGCTAGCTAGGATCGATCGATCGTAGC\n' > q.fa; makeblastdb -in s.fa -dbtype nucl -out db >/dev/null; blastn -query q.fa -db db -outfmt '6 sseqid pident length' -task blastn-short`,
    (o) => { expect(o.split('\n')[0]).toBe('subj1\t100.000\t26'); expect(o).not.toContain('subj2'); });
  run7('3/7 bedtools: intersect two small BED files returns exactly the overlap',
    `printf 'chr1\t10\t50\nchr1\t100\t200\nchr2\t5\t15\n' > a.bed; printf 'chr1\t40\t120\nchr2\t20\t30\n' > b.bed; bedtools intersect -a a.bed -b b.bed`,
    (o) => expect(o.split('\n')).toEqual(['chr1\t40\t50', 'chr1\t100\t120']));
  run7('4/7 python (locked env, Python 3.12): RDKit aspirin molecular weight, SciPy t-test, pandas group-by — exact deterministic values',
    `python -c "
import sys, rdkit, numpy as np, pandas as pd
from rdkit import Chem
from rdkit.Chem import Descriptors
from scipy import stats
assert sys.version_info[:2] == (3, 12), sys.version
m = Chem.MolFromSmiles('CC(=O)Oc1ccccc1C(=O)O')
t = stats.ttest_ind([1,2,3,4,5],[2,3,4,5,6])
df = pd.DataFrame({'g':['a','a','b'],'v':[1.0,3.0,5.0]}).groupby('g').v.mean()
print(round(Descriptors.MolWt(m),2), round(float(t.statistic),6), round(float(t.pvalue),4), df['a'], df['b'], np.__version__.split('.')[0])"`,
    (o) => { const [mw, ts, p, a, b] = o.split(' '); expect(mw).toBe('180.16'); expect(ts).toBe('-1.0'); expect(p).toBe('0.3466'); expect(a).toBe('2.0'); expect(b).toBe('5.0'); });
  run7('5/7 obabel: SMILES → InChI gives aspirin\'s formula layer',
    `echo 'CC(=O)Oc1ccccc1C(=O)O' | obabel -ismi -oinchi 2>/dev/null`,
    (o) => expect(o).toMatch(/^InChI=1S\/C9H8O4\//));
  run7('6/7 claude: the real CLI STARTS (version string only — this is CLI startup, NOT authenticated agent execution, NOT tool execution by the agent)',
    `claude --version`, (o) => expect(o).toMatch(/\d+\.\d+\.\d+/));
  run7('7/7 node: executes JavaScript', `node -e "console.log(2 ** 10, process.version.startsWith('v22'))"`, (o) => expect(o).toBe('1024 true'));
});

describe.skipIf(!FULL)(`full image — additional tools with real execution (${IMAGE})`, () => {
  run7('gatk: runs (JVM + launcher) and reports its pinned version', `gatk --version 2>&1 | tr '\n' ' '`, (o) => expect(o).toMatch(/4\.5\.0\.0/));
  run7('vina: runs and reports a version', `vina --version 2>&1 | head -1`, (o) => expect(o).toMatch(/AutoDock Vina/i));
  run7('fastqc: runs on a tiny FASTQ and writes a report', `printf '@r1\nACGTACGTAC\n+\nIIIIIIIIII\n@r2\nACGTACGTAA\n+\nIIIIIIIIII\n' > r.fq; fastqc -q -o . r.fq >/dev/null 2>&1; test -s r_fastqc.zip && echo report-written`, (o) => expect(o).toBe('report-written'));
  run7('bcftools: normalises/reads a tiny VCF', `printf '##fileformat=VCFv4.2\n##contig=<ID=chr1,length=100>\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\nchr1\t10\t.\tA\tG\t50\tPASS\t.\nchr1\t20\t.\tC\tT\t60\tPASS\t.\n' > t.vcf; bcftools view -H t.vcf | wc -l | tr -d ' '`, (o) => expect(o).toBe('2'));
  run7('minimap2: aligns a read to a tiny reference', `printf '>ref\nACGTACGTTAGCTAGCTAGGATCGATCGATTTAGCGCGATATCGCGATCGATGCATGCAATTCGATCG\n' > ref.fa; printf '>rd\nGCTAGCTAGGATCGATCGATTTAGCGCGATATCGCGATCG\n' > rd.fa; minimap2 -c -x sr ref.fa rd.fa 2>/dev/null | cut -f1,6 | head -1`, (o) => expect(o).toBe('rd\tref'));
  run7('snakemake (own venv, exact pin): version and a dry-run of a one-rule workflow', `snakemake --version; printf 'rule all:\n    input: "out.txt"\nrule make:\n    output: "out.txt"\n    shell: "echo hi > out.txt"\n' > Snakefile; snakemake -n --cores 1 2>&1 | grep -cE "^make +1"`, (o) => { expect(o.split('\n')[0]).toBe('9.27.2'); expect(Number(o.split('\n')[1])).toBeGreaterThanOrEqual(1); });
  run7('nextflow: a one-process workflow RUNS on the local executor and its process output is captured', `printf 'process HI {\n    output:\n    stdout\n\n    script:\n    """\n    echo functional\n    """\n}\n\nworkflow {\n    HI() | view\n}\n' > m.nf; timeout 300 nextflow run m.nf 2>&1 | sed 's/\x1b\\[[0-9;]*[A-Za-z]//g' | grep -c '^functional'`, (o) => expect(Number(o)).toBeGreaterThanOrEqual(1), 330_000);
  // KNOWN DEFECT (recorded, not hidden): Debian's pymol 2.5.0 imports `imp`, which Python 3.12 removed, so PyMOL cannot start. This test PINS the actual
  // behaviour so the suite tells the truth; when PyMOL is made to work, flip it to a functional assertion (e.g. `fragment ala` → 10 atoms).
  run7('pymol: installed but NOT FUNCTIONAL on Python 3.12 (known defect: `No module named imp`)', `command -v pymol >/dev/null; PATH=/usr/bin:/bin pymol -ckq -d "fragment ala" 2>&1 | grep -c "No module named 'imp'" || true`, (o) => expect(Number(o)).toBeGreaterThanOrEqual(1));
  run7('optional tools are ABSENT from the full image by design (documented in container/python/optional.in), not silently missing', `for m in episcanpy tdc medspacy pyscenic squidpy biotite pyranges deepchem hail; do python -c "import $m" 2>/dev/null && echo "$m present" || echo "$m absent"; done`, (o) => { expect(o.split('\n').every((l) => l.endsWith(' absent'))).toBe(true); expect(o.split('\n')).toHaveLength(9); });
  run7('the locked environment is coherent at runtime: pip check passes and key imports work', `pip check; python -c "import scanpy, anndata, pysam, Bio, pymc, torch; print('imports ok')"`, (o) => expect(o).toMatch(/No broken requirements found\.\nimports ok$/), 300_000);
});

/**
 * REAL Claude CLI inside the container — three DIFFERENT levels, each proving only what it says:
 *   L-a CLI startup:           `claude --version` runs as the host user.
 *   L-b context + credential path (NO real credentials, NO model): the CLI is pointed at a local capture server with a FAKE key. We
 *       check that the entrypoint delivered the stdin credentials and the supplied context to the real CLI, which put the key in its
 *       Authorization/x-api-key header and the context text in its API request. The capture server answers with an error, so the CLI
 *       exits non-zero → reported as agent_failed. This is NOT authenticated agent execution.
 *   L-c authenticated agent execution and actual tool execution need a real, funded credential: only run when
 *       ANUCLAW_REAL_AGENT_CREDENTIAL_TEST=1 is set by a human (it spends money). Never run by default, never prints the credential.
 * Image: ANUCLAW_CLI_IMAGE (the probe image, or the full image).
 */
const CLI_IMAGE = process.env.ANUCLAW_CLI_IMAGE ?? 'anuclaw-cli-probe:latest';
describe.skipIf(!ENABLED)(`real Claude CLI in the container (${CLI_IMAGE}) — startup and context/credential path only`, () => {
  const http = require('http') as typeof import('http');
  let server: import('http').Server; let port = 0; const hits: Array<{ url: string; headers: Record<string, any>; body: string }> = [];
  beforeAll(async () => {
    expect(docker('image', 'inspect', CLI_IMAGE).status, `image ${CLI_IMAGE} must exist`).toBe(0);
    server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { hits.push({ url: req.url ?? '', headers: req.headers, body: b }); res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'capture server: no model here' } })); }); });
    await new Promise<void>((r) => server.listen(0, '0.0.0.0', () => r())); port = (server.address() as any).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('L-a startup: the real `claude` CLI starts as the host user (version only — not authenticated execution)', () => {
    const r = spawnSync('docker', ['run', '--rm', '--user', `${process.getuid!()}:${process.getgid!()}`, '-e', 'HOME=/tmp', '--entrypoint', 'claude', CLI_IMAGE, '--version'], { encoding: 'utf8' });
    expect(r.status, r.stderr.slice(0, 300)).toBe(0); expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
  }, 120_000);

  it('L-b context + credential path: the real CLI receives the stdin credential and the supplied context, and sends them to its API endpoint (fake key, capture server, no model)', async () => {
    const FAKE = 'sk-ant-FAKE-CONTRACT-KEY-not-a-real-credential-0123456789';
    const d = fs.mkdtempSync(path.join(tmp, 'cli-')); fs.chmodSync(d, 0o755);
    const ctx = path.join(d, '.anuclaw_context.json');
    fs.writeFileSync(ctx, JSON.stringify({ systemPrompt: 'SYSTEM-MARKER-7f3a', sessionMessages: [{ role: 'user', content: 'HISTORY-MARKER-91bc' }], prompt: 'PROMPT-MARKER-c0de' })); fs.chmodSync(ctx, 0o644);
    hits.length = 0;
    // The CLI retries a rejected request with back-off for minutes, so we do not wait for it to exit: we wait for the first API request,
    // inspect it, then stop the container. (Exit-code reporting of a failed agent is covered by the double-agent test above.)
    const name = `anuclaw-cli-l-b-${crypto.randomBytes(3).toString('hex')}`;
    const { spawn } = require('child_process') as typeof import('child_process');
    const child = spawn('docker', ['run', '--rm', '-i', '--name', name, '--user', `${process.getuid!()}:${process.getgid!()}`, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--add-host', 'host.docker.internal:host-gateway', '-e', 'HOME=/tmp', '--tmpfs', '/tmp:rw,exec,mode=1777', '-v', `${d}:/workspace/group`, CLI_IMAGE, '--max-turns', '1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (x) => { out += x; }); child.stderr.on('data', (x) => { out += x; });
    child.stdin.write(JSON.stringify({ ANTHROPIC_API_KEY: FAKE, ANTHROPIC_BASE_URL: `http://host.docker.internal:${port}`, CLAUDE_MODEL: 'claude-sonnet-4-5' }) + '\n'); child.stdin.end();
    for (let i = 0; i < 120 && !hits.some((h) => /\/v1\/messages/.test(h.url)); i++) await new Promise((r) => setTimeout(r, 1000));
    docker('rm', '-f', name);
    expect(hits.some((h) => /\/v1\/messages/.test(h.url)), `the CLI never reached the endpoint. output: ${out.slice(0, 300)}`).toBe(true);
    expect(out).not.toMatch(/<response>/);                                   // no success wrapper without a real model answer
    const api = hits.find((h) => /\/v1\/messages/.test(h.url))!;
    const sent = api.body + JSON.stringify(api.headers);
    expect(sent).toContain(FAKE);                                            // the stdin credential reached the CLI and was used as its key
    for (const m of ['SYSTEM-MARKER-7f3a', 'HISTORY-MARKER-91bc', 'PROMPT-MARKER-c0de']) expect(api.body, m).toContain(m);   // the context reached the CLI's request
    expect(api.body).toContain('claude-sonnet-4-5');
    expect(out).not.toContain(FAKE);                                         // and was not echoed back to the host
  }, 200_000);

  it.skipIf(process.env.ANUCLAW_REAL_AGENT_CREDENTIAL_TEST !== '1')('L-c authenticated agent execution (HUMAN-ENABLED ONLY; spends money): the agent answers a trivial prompt', async () => {
    const key = process.env.ANUCLAW_REAL_AGENT_API_KEY; expect(key, 'set ANUCLAW_REAL_AGENT_API_KEY in the environment (never on a command line)').toBeTruthy();
    const d = fs.mkdtempSync(path.join(tmp, 'cli-real-')); fs.chmodSync(d, 0o755);
    const ctx = path.join(d, '.anuclaw_context.json'); fs.writeFileSync(ctx, JSON.stringify({ prompt: 'Reply with exactly the single word: pong' })); fs.chmodSync(ctx, 0o644);
    const r = spawnSync('docker', ['run', '--rm', '-i', '--user', `${process.getuid!()}:${process.getgid!()}`, '-e', 'HOME=/tmp', '--tmpfs', '/tmp:rw,exec,mode=1777', '-v', `${d}:/workspace/group`, CLI_IMAGE, '--max-turns', '1'],
      { input: JSON.stringify({ ANTHROPIC_API_KEY: key, ...(process.env.ANUCLAW_REAL_AGENT_BASE_URL ? { ANTHROPIC_BASE_URL: process.env.ANUCLAW_REAL_AGENT_BASE_URL } : {}) }) + '\n', encoding: 'utf8', timeout: 150_000 });
    expect(r.status, r.stderr.replace(key!, '[redacted]').slice(0, 300)).toBe(0); expect(r.stdout).toMatch(/<response>[\s\S]*pong[\s\S]*<\/response>/i);
  }, 200_000);
});
