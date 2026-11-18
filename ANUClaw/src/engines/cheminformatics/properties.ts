/**
 * Cheminformatics — molecular properties engine (Phase 0, WS-A4, RUO).
 *
 * A REAL, deterministic SMILES → molecular-properties calculator with no
 * external dependency: parses the organic subset + bracket atoms, applies a
 * standard valence model to infer implicit hydrogens, and computes the
 * molecular formula (Hill order), average molecular weight, heavy-atom count,
 * H-bond donors/acceptors (Lipinski definitions), ring count, and a Lipinski
 * Rule-of-Five assessment.
 *
 * Exact for Kekulé SMILES (explicit bond orders); aromatic lowercase atoms use
 * a 1.5-order model. Cross-checked against RDKit on a 26-molecule panel
 * (rdkit-crosscheck.test.ts) on formula, heavy atoms, rings (identical) and molecular weight
 * (within 0.01 Da; abridged atomic weights). It does NOT claim equality with RDKit for H-bond
 * counts: `hydrogens_on_nitrogen_oxygen` and `nitrogen_oxygen_atom_count` are simple counts
 * that differ from RDKit's STANDARD Lipinski.NumHDonors / NumHAcceptors (e.g. urea 4 vs 2,
 * aspirin 4 vs 3, thiophene 0 vs 1, metformin 5 vs 3 donors) — hence the different names. For
 * standard descriptors and any drug-likeness verdict use the RDKit engine (rdkit.ts). logP/TPSA
 * are NOT computed (they need atom-contribution models) — Ro5 is therefore
 * evaluated on MW/HBD/HBA only and that limitation is reported.
 */

import {
  EngineAdapter,
  EngineError,
  EngineResult,
  RunContext,
  hashEngineInput,
  nowIso,
} from '../types';

// Average atomic weights (IUPAC), sufficient for MW reporting.
const WEIGHTS: Record<string, number> = {
  H: 1.008, B: 10.811, C: 12.011, N: 14.007, O: 15.999, F: 18.998,
  P: 30.974, S: 32.06, Cl: 35.45, Br: 79.904, I: 126.904,
};
// Allowed valences (smallest satisfying the bond sum wins).
const VALENCES: Record<string, number[]> = {
  B: [3], C: [4], N: [3], O: [2], F: [1], P: [3, 5], S: [2, 4, 6], Cl: [1], Br: [1], I: [1],
};
const ORGANIC = new Set(['B', 'C', 'N', 'O', 'F', 'P', 'S', 'Cl', 'Br', 'I']);

interface Atom {
  element: string;
  aromatic: boolean;
  bracket: boolean;   // bracketed ⇒ hydrogens are explicit
  explicitH: number;
  charge: number;
  bondSum: number;    // sum of bond orders to neighbours (aromatic = 1.5)
}

const BOND_ORDER: Record<string, number> = { '-': 1, '=': 2, '#': 3, ':': 1.5, '/': 1, '\\': 1 };

/** Parse a SMILES string into atoms with accumulated bond orders. */
function parse(smiles: string): Atom[] {
  const atoms: Atom[] = [];
  const branchStack: number[] = [];
  const ringBonds = new Map<string, { atom: number; order: number }>();
  let prev = -1;
  let pendingBond = 0; // 0 = default single (or aromatic if both aromatic)
  let i = 0;

  const link = (a: number, b: number, order: number) => {
    atoms[a].bondSum += order;
    atoms[b].bondSum += order;
  };
  const defaultOrder = (a: number, b: number) =>
    atoms[a].aromatic && atoms[b].aromatic ? 1.5 : 1;

  const pushAtom = (atom: Atom) => {
    const idx = atoms.push(atom) - 1;
    if (prev !== -1) {
      const order = pendingBond || defaultOrder(prev, idx);
      link(prev, idx, order);
    }
    pendingBond = 0;
    prev = idx;
    return idx;
  };

  while (i < smiles.length) {
    const ch = smiles[i];

    if (ch === ' ') { i++; continue; }
    // '.' separates disconnected components (e.g. salts): the next atom starts a new fragment.
    if (ch === '.') { prev = -1; branchStack.length = 0; pendingBond = 0; i++; continue; }
    if (ch === '(') { branchStack.push(prev); i++; continue; }
    if (ch === ')') { prev = branchStack.pop() ?? prev; i++; continue; }
    if (ch in BOND_ORDER) { pendingBond = BOND_ORDER[ch]; i++; continue; }

    // Ring-closure digit (or %nn).
    if (/\d/.test(ch) || ch === '%') {
      let label: string;
      if (ch === '%') { label = smiles.slice(i + 1, i + 3); i += 3; }
      else { label = ch; i += 1; }
      const existing = ringBonds.get(label);
      if (existing) {
        const order = pendingBond || existing.order || defaultOrder(existing.atom, prev);
        link(existing.atom, prev, order);
        ringBonds.delete(label);
      } else {
        ringBonds.set(label, { atom: prev, order: pendingBond });
      }
      pendingBond = 0;
      continue;
    }

    // Bracket atom: [<isotope?><symbol><Hn?><charge?>]
    if (ch === '[') {
      const end = smiles.indexOf(']', i);
      if (end === -1) throw new EngineError('invalid_input', 'unterminated [ in SMILES');
      const body = smiles.slice(i + 1, end);
      const m = body.match(/^(\d*)([A-Za-z][a-z]?)(H\d*)?((?:[+-]\d*)*)/);
      if (!m) throw new EngineError('invalid_input', `bad bracket atom: [${body}]`);
      const rawSym = m[2];
      const aromatic = /^[a-z]/.test(rawSym);
      const element = rawSym.charAt(0).toUpperCase() + rawSym.slice(1);
      // An element without a known weight would silently contribute 0 Da; refuse it instead.
      if (!(element in WEIGHTS)) throw new EngineError('invalid_input', `unsupported element '${element}' in bracket atom`);
      const explicitH = m[3] ? (m[3] === 'H' ? 1 : parseInt(m[3].slice(1), 10)) : 0;
      let charge = 0;
      if (m[4]) for (const tok of m[4].match(/[+-]\d*/g) ?? []) charge += tok[0] === '+' ? (tok.length > 1 ? +tok.slice(1) : 1) : (tok.length > 1 ? -+tok.slice(1) : -1);
      pushAtom({ element, aromatic, bracket: true, explicitH, charge, bondSum: 0 });
      i = end + 1;
      continue;
    }

    // Organic-subset atom (possibly two-letter Cl/Br); aromatic = lowercase.
    const two = smiles.slice(i, i + 2);
    let element: string | null = null;
    let aromatic = false;
    if (two === 'Cl' || two === 'Br') { element = two; i += 2; }
    else if (/[A-Z]/.test(ch)) { element = ch; i += 1; }
    else if (/[bcnops]/.test(ch)) { element = ch.toUpperCase(); aromatic = true; i += 1; }
    else { throw new EngineError('invalid_input', `unexpected character '${ch}' in SMILES`); }

    if (!ORGANIC.has(element)) throw new EngineError('invalid_input', `unsupported element '${element}'`);
    pushAtom({ element, aromatic, bracket: false, explicitH: 0, charge: 0, bondSum: 0 });
  }
  if (atoms.length === 0) throw new EngineError('invalid_input', 'empty molecule');
  if (ringBonds.size > 0) throw new EngineError('invalid_input', `unclosed ring bond label(s): ${[...ringBonds.keys()].join(', ')}`);
  return atoms;
}

function implicitH(a: Atom): number {
  if (a.bracket) return a.explicitH;
  // Unbracketed aromatic o/s (furan, thiophene) donate a lone pair and carry no implicit H.
  if (a.aromatic && (a.element === 'O' || a.element === 'S')) return 0;
  const list = VALENCES[a.element];
  if (!list) return 0;
  const need = a.bondSum;
  for (const v of list) {
    const eff = v + Math.abs(a.charge) * 0; // charge handled only in brackets
    if (eff >= need - 1e-9) return Math.max(0, Math.round(eff - need));
  }
  return 0;
}

export interface MolPropsInput { smiles: string }
export interface MolProps {
  smiles: string;
  formula: string;
  molecular_weight: number;
  heavy_atom_count: number;
  /** Number of hydrogens on N/O atoms — a SIMPLE count, NOT RDKit's Lipinski.NumHDonors. */
  hydrogens_on_nitrogen_oxygen: number;
  /** Number of N and O atoms — a SIMPLE count, NOT RDKit's Lipinski.NumHAcceptors. */
  nitrogen_oxygen_atom_count: number;
  ring_count: number;
  formal_charge: number;
  /** Which implementation produced these values. */
  descriptor_method: 'builtin-approximation';
  /** Simplified rule-of-five on the simple counts above (no logP). NOT a standard drug-likeness result. */
  ro5_simplified: { mw_ok: boolean; hydrogens_on_NO_ok: boolean; NO_atoms_ok: boolean; violations: number; convention: string; note: string };
}

const HILL = (counts: Record<string, number>): string => {
  const keys = Object.keys(counts);
  const order = keys.includes('C') ? ['C', 'H', ...keys.filter((k) => k !== 'C' && k !== 'H').sort()] : keys.sort();
  return order.filter((k) => counts[k]).map((k) => `${k}${counts[k] > 1 ? counts[k] : ''}`).join('');
};

export function computeMolecularProperties(smiles: string): MolProps {
  const s = (smiles ?? '').trim();
  if (!s) throw new EngineError('invalid_input', 'smiles is required');
  const atoms = parse(s);

  const counts: Record<string, number> = {};
  let hTotal = 0, hbd = 0, hba = 0, charge = 0;
  for (const a of atoms) {
    counts[a.element] = (counts[a.element] ?? 0) + 1;
    const h = implicitH(a);
    hTotal += h;
    charge += a.charge;
    if (a.element === 'N' || a.element === 'O') { hba += 1; hbd += h; }
  }
  counts.H = (counts.H ?? 0) + hTotal;

  let mw = 0;
  for (const [el, n] of Object.entries(counts)) mw += (WEIGHTS[el] ?? 0) * n;

  // Ring count = number of ring-closure bonds = ring-bond labels / 2.
  // (Strip bracket atoms first so isotope/charge digits aren't miscounted.)
  const ringLabelDigits = (s.replace(/\[[^\]]*\]/g, '').match(/%\d\d|\d/g) ?? []).length;
  const ring_count = Math.floor(ringLabelDigits / 2);

  const heavy = atoms.length;
  const mwR = Math.round(mw * 1000) / 1000;
  const lip = { mw_ok: mwR <= 500, hydrogens_on_NO_ok: hbd <= 5, NO_atoms_ok: hba <= 10 };
  const violations = [lip.mw_ok, lip.hydrogens_on_NO_ok, lip.NO_atoms_ok].filter((x) => !x).length;

  return {
    smiles: s,
    formula: HILL(counts),
    molecular_weight: mwR,
    heavy_atom_count: heavy,
    hydrogens_on_nitrogen_oxygen: hbd,
    nitrogen_oxygen_atom_count: hba,
    ring_count,
    formal_charge: charge,
    descriptor_method: 'builtin-approximation',
    ro5_simplified: { ...lip, violations, convention: 'builtin simple counts (H on N/O ≤ 5; N+O atoms ≤ 10) — not RDKit NumHDonors/NumHAcceptors', note: 'logP/TPSA not computed; for standard descriptors and drug-likeness use the RDKit engine.' },
  };
}

export class MolecularPropertiesEngine implements EngineAdapter<MolPropsInput, MolProps> {
  readonly id = 'cheminformatics-properties';
  readonly version = '1.0.0';
  readonly validated = false; // RUO
  readonly reproducibility_class = 'deterministic' as const;

  async run(input: MolPropsInput, ctx?: RunContext): Promise<EngineResult<MolProps>> {
    const output = computeMolecularProperties(input?.smiles);
    const ts = nowIso(ctx?.now);
    return {
      engine_id: this.id,
      engine_version: this.version,
      input_hash: hashEngineInput(this.id, this.version, input),
      output,
      artifacts: [],
      provenance: { tool: 'anuclaw-cheminformatics', tool_version: this.version, params: {} },
      reproducibility_class: this.reproducibility_class,
      started_at: ts,
      finished_at: ts,
    };
  }
}
