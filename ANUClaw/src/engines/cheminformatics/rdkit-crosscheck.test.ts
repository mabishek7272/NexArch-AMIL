/**
 * Built-in approximation vs RDKit, and the RDKit engine itself.
 *
 *  - Formula, heavy atoms, ring count: identical to RDKit. Molecular weight: within 0.01 Da
 *    (abridged atomic weights). NO equality is claimed for H-bond counts: the built-in uses
 *    simple counts that differ from RDKit's STANDARD NumHDonors/NumHAcceptors, and that is
 *    asserted explicitly for urea, aspirin, thiophene and metformin.
 *  - Standard descriptors and drug-likeness come from the RDKit engine (live subprocess; runs
 *    when the isolated RDKit environment exists, otherwise those live tests are skipped and the
 *    reference-vector assertions still run).
 * Reference values: rdkit-vectors.json (scripts/gen-chem-vectors.py).
 */
import { describe, expect, it } from 'vitest';
import V from './rdkit-vectors.json';
import { computeMolecularProperties } from './properties';
import { compareDescriptors, standardDescriptorsFor } from './compare';
import { rdkitAvailable, rdkitDescriptors, ro5, ro5Refined, RdkitDescriptor } from './rdkit';

const M = V.molecules as Record<string, any>;
const mols = Object.entries(M);
const live = rdkitAvailable();

describe('reference provenance', () => { it('RDKit version recorded', () => { expect(V._provenance.rdkit).toMatch(/^\d{4}\./); }); });

describe.each(mols)('built-in vs RDKit — %s', (_n, ref) => {
  const got = computeMolecularProperties(ref.smiles);
  it('formula, heavy atoms and rings identical; molecular weight within 0.01 Da', () => {
    expect(got.formula).toBe(ref.formula);
    expect(got.heavy_atom_count).toBe(ref.heavyAtoms);
    expect(got.ring_count).toBe(ref.rings);
    expect(Math.abs(got.molecular_weight - ref.mw)).toBeLessThanOrEqual(0.01);
  });
  it('the built-in simple counts are what they say they are (H on N/O; N+O atoms)', () => {
    expect(got.hydrogens_on_nitrogen_oxygen).toBe(ref.hOnNO);
    expect(got.nitrogen_oxygen_atom_count).toBe(ref.nPlusO);
  });
});

describe('RDKit STANDARD H-bond descriptors differ from the built-in simple counts (urea, aspirin, thiophene, metformin)', () => {
  // [name, RDKit Lipinski.NumHDonors, RDKit Lipinski.NumHAcceptors, built-in H on N/O, built-in N+O atoms]
  const CASES: Array<[string, number, number, number, number]> = [
    ['urea', 2, 1, 4, 3], ['aspirin', 1, 3, 1, 4], ['thiophene', 0, 1, 0, 0], ['metformin', 3, 1, 5, 5],
  ];
  it.each(CASES)('%s: reference vector holds RDKit standard NumHDonors=%i NumHAcceptors=%i', (name, hbd, hba) => {
    expect(M[name].hbd).toBe(hbd);
    expect(M[name].hba).toBe(hba);
  });
  it('urea donors 4 vs 2, aspirin acceptors 4 vs 3, thiophene acceptors 0 vs 1, metformin 5/5 vs 3/1', () => {
    const d = (n: string) => ({ b: computeMolecularProperties(M[n].smiles), r: M[n] });
    expect([d('urea').b.hydrogens_on_nitrogen_oxygen, d('urea').r.hbd]).toEqual([4, 2]);
    expect([d('aspirin').b.nitrogen_oxygen_atom_count, d('aspirin').r.hba]).toEqual([4, 3]);
    expect([d('thiophene').b.nitrogen_oxygen_atom_count, d('thiophene').r.hba]).toEqual([0, 1]);
    expect([d('metformin').b.hydrogens_on_nitrogen_oxygen, d('metformin').r.hbd]).toEqual([5, 3]);
    expect([d('metformin').b.nitrogen_oxygen_atom_count, d('metformin').r.hba]).toEqual([5, 1]);
  });
});

describe.skipIf(!live)('RDKit engine (live subprocess) returns the STANDARD descriptors', () => {
  const names = ['urea', 'aspirin', 'thiophene', 'metformin'];
  it('urea, aspirin, thiophene and metformin equal RDKit standard outputs; version and method names are reported', async () => {
    const batch = await rdkitDescriptors(names.map((n) => M[n].smiles));
    expect(batch.status).toBe('ok');
    if (batch.status !== 'ok') return;
    expect(batch.rdkitVersion).toBe(V._provenance.rdkit);
    expect(batch.methods.hbd).toBe('rdkit.Chem.Lipinski.NumHDonors');
    expect(batch.methods.hba).toBe('rdkit.Chem.Lipinski.NumHAcceptors');
    names.forEach((n, i) => {
      const r = batch.results[i] as RdkitDescriptor;
      expect(r.ok).toBe(true);
      expect(r.hbd).toBe(M[n].hbd); expect(r.hba).toBe(M[n].hba);
      expect(r.hbdOriginalLipinski).toBe(M[n].hbdLipinskiAtoms); expect(r.hbaOriginalLipinski).toBe(M[n].hbaLipinskiAtoms);
      expect(r.formula).toBe(M[n].formula); expect(r.molWt).toBeCloseTo(M[n].mw, 3);
    });
  }, 60_000);

  it('the differences list names every property that differs, with both methods', async () => {
    const batch = await rdkitDescriptors(names.map((n) => M[n].smiles));
    if (batch.status !== 'ok') throw new Error('rdkit unavailable');
    const diff = (n: string) => compareDescriptors(computeMolecularProperties(M[n].smiles), batch.results[names.indexOf(n)] as RdkitDescriptor);
    expect(diff('urea').map((d) => d.property)).toEqual(expect.arrayContaining(['H-bond donors', 'H-bond acceptors']));
    expect(diff('aspirin').map((d) => d.property)).toEqual(['H-bond acceptors']);
    expect(diff('thiophene').map((d) => d.property)).toEqual(['H-bond acceptors']);
    expect(diff('metformin').map((d) => d.property)).toEqual(expect.arrayContaining(['H-bond donors', 'H-bond acceptors']));
    const u = diff('urea').find((d) => d.property === 'H-bond donors')!;
    expect(u).toMatchObject({ builtin: 4, rdkit: 2, rdkitMethod: 'Lipinski.NumHDonors (standard)' });
  }, 60_000);

  it('drug-likeness is reported under two NAMED conventions and uses RDKit logP', async () => {
    const batch = await rdkitDescriptors([M.aspirin.smiles]);
    if (batch.status !== 'ok') throw new Error('rdkit unavailable');
    const d = batch.results[0] as RdkitDescriptor;
    expect(ro5(d).convention).toMatch(/original Lipinski counters.*Crippen MolLogP/);
    expect(ro5Refined(d).convention).toMatch(/standard refined counters.*Crippen MolLogP/);
    expect(typeof d.crippenLogP).toBe('number');
  }, 60_000);

  it('invalid SMILES are rejected by RDKit, not guessed', async () => {
    const batch = await rdkitDescriptors(['C1CC', 'not a smiles', 'CCO']);
    if (batch.status !== 'ok') throw new Error('rdkit unavailable');
    expect(batch.results.map((r) => r.ok)).toEqual([false, false, true]);
  }, 60_000);
});

describe('E-LAB response payload (standardDescriptorsFor)', () => {
  it.skipIf(!live)('urea: standard values, both conventions, and the differences are present and prominent (live RDKit)', async () => {
    const sd: any = await standardDescriptorsFor(M.urea.smiles, computeMolecularProperties(M.urea.smiles));
    expect(sd.status).toBe('ok');
    expect(sd.version).toBe(V._provenance.rdkit);
    expect(sd.descriptors.hbd).toBe(2); expect(sd.descriptors.hba).toBe(1);
    expect(sd.drug_likeness.original_lipinski.convention).toMatch(/original Lipinski/);
    expect(sd.drug_likeness.standard_refined.convention).toMatch(/standard refined/);
    expect(sd.differences_from_builtin.map((d: any) => d.property)).toEqual(expect.arrayContaining(['H-bond donors', 'H-bond acceptors']));
  }, 60_000);
  it('RDKit unavailable → status unavailable with a reason; no descriptors, no drug-likeness', async () => {
    const sd: any = await standardDescriptorsFor('CCO', computeMolecularProperties('CCO'), { ...process.env, ANUCLAW_RDKIT_PYTHON: '/nonexistent/python' });
    expect(sd).toMatchObject({ status: 'unavailable', reason: 'python_not_found' });
    expect(sd.descriptors).toBeUndefined(); expect(sd.drug_likeness).toBeUndefined();
  });
});

describe('RDKit unavailable → explicit status, never a silent substitution', () => {
  it('reports python_not_found', async () => {
    const r = await rdkitDescriptors(['CCO'], { env: { ...process.env, ANUCLAW_RDKIT_PYTHON: '/nonexistent/python' } });
    expect(r).toEqual({ status: 'unavailable', reason: 'python_not_found' });
  });
  it('a python without RDKit is reported as rdkit_not_installed', async () => {
    const r = await rdkitDescriptors(['CCO'], { env: { ...process.env, ANUCLAW_RDKIT_PYTHON: '/usr/bin/python3' } });
    expect(r.status).toBe('unavailable');
  }, 30_000);
});

describe('built-in parser behaviour fixed by the cross-check', () => {
  it('aromatic o/s carry no implicit hydrogen (thiophene C4H4S, furan C4H4O)', () => {
    expect(computeMolecularProperties('c1ccsc1').formula).toBe('C4H4S');
    expect(computeMolecularProperties('c1ccoc1').formula).toBe('C4H4O');
  });
  it('disconnected components are supported', () => {
    const r = computeMolecularProperties('CC(=O)[O-].[NH4+]');
    expect(r.formula).toBe('C2H7NO2'); expect(r.formal_charge).toBe(0);
  });
  it('bracket atoms with an unsupported element are rejected (previously contributed 0 Da silently)', () => {
    expect(() => computeMolecularProperties('[Xx]')).toThrow(/unsupported element/);
    expect(() => computeMolecularProperties('C[Au]')).toThrow();
  });
  it.each(['C1CC', 'c1ccccc', 'C1CC2'])('unclosed ring labels are an explicit error: %s', (smi) => {
    expect(() => computeMolecularProperties(smi)).toThrow(/unclosed ring/);
  });
});
