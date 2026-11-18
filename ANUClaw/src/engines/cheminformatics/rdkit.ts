/**
 * RDKit-backed STANDARD descriptors (plan §9, drug discovery). Runs scripts/rdkit_descriptors.py
 * in an isolated Python environment (default .venv-chem; override ANUCLAW_RDKIT_PYTHON) as an
 * argument-array subprocess (no shell) with a timeout and output cap. Every result carries the
 * RDKit version and the exact function used for each descriptor, so nothing here is ambiguous.
 * When RDKit is unavailable the caller gets an explicit `unavailable` status — never a silent
 * substitution with the built-in approximation (which uses DIFFERENT, differently-named counts).
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface RdkitDescriptor {
  ok: true; formula: string; molWt: number; heavyAtoms: number; rings: number;
  hbd: number; hba: number; hbdOriginalLipinski: number; hbaOriginalLipinski: number;
  tpsa: number; crippenLogP: number; rotatableBonds: number;
}
export type RdkitRow = RdkitDescriptor | { ok: false; error: string };
export type RdkitBatch =
  | { status: 'ok'; rdkitVersion: string; methods: Record<string, string>; results: RdkitRow[] }
  | { status: 'unavailable'; reason: 'python_not_found' | 'rdkit_not_installed' | 'timeout' | 'worker_failed' | 'bad_output' };

export function rdkitPython(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANUCLAW_RDKIT_PYTHON?.trim() || path.join(process.cwd(), '.venv-chem', 'bin', 'python');
}
export function rdkitAvailable(env: NodeJS.ProcessEnv = process.env): boolean { return fs.existsSync(rdkitPython(env)); }

const SCRIPT = () => path.resolve(__dirname, '../../../scripts/rdkit_descriptors.py');

export function rdkitDescriptors(smiles: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RdkitBatch> {
  const env = opts.env ?? process.env;
  const py = rdkitPython(env);
  if (!fs.existsSync(py)) return Promise.resolve({ status: 'unavailable', reason: 'python_not_found' });
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (r: RdkitBatch) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const child = spawn(py, ['-I', SCRIPT()], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ status: 'unavailable', reason: 'timeout' }); }, opts.timeoutMs ?? 60_000);
    child.stdout.on('data', (d) => { out += d; if (out.length > 20_000_000) { child.kill('SIGKILL'); finish({ status: 'unavailable', reason: 'bad_output' }); } });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => finish({ status: 'unavailable', reason: 'python_not_found' }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ status: 'unavailable', reason: /No module named 'rdkit'/.test(err) ? 'rdkit_not_installed' : 'worker_failed' });
      try {
        const j = JSON.parse(out);
        if (!j.ok || !Array.isArray(j.results) || j.results.length !== smiles.length || typeof j.rdkitVersion !== 'string') return finish({ status: 'unavailable', reason: 'bad_output' });
        finish({ status: 'ok', rdkitVersion: j.rdkitVersion, methods: j.methods, results: j.results });
      } catch { finish({ status: 'unavailable', reason: 'bad_output' }); }
    });
    child.stdin.on('error', () => { /* worker exited early; handled by close */ });
    child.stdin.end(JSON.stringify({ smiles }));
  });
}

/** Original-Lipinski rule-of-five using RDKit's Crippen logP and the ORIGINAL-Lipinski counters. */
export function ro5(d: RdkitDescriptor) {
  const flags = { mw: d.molWt <= 500, logP: d.crippenLogP <= 5, hbd: d.hbdOriginalLipinski <= 5, hba: d.hbaOriginalLipinski <= 10 };
  return { ...flags, violations: Object.values(flags).filter((x) => !x).length, convention: 'original Lipinski counters (CalcNumLipinskiHBD/HBA) + Crippen MolLogP' };
}
/** The same four criteria with RDKit's STANDARD refined counters (Lipinski.NumHDonors/NumHAcceptors). */
export function ro5Refined(d: RdkitDescriptor) {
  const flags = { mw: d.molWt <= 500, logP: d.crippenLogP <= 5, hbd: d.hbd <= 5, hba: d.hba <= 10 };
  return { ...flags, violations: Object.values(flags).filter((x) => !x).length, convention: 'standard refined counters (Lipinski.NumHDonors/NumHAcceptors) + Crippen MolLogP' };
}
