/**
 * Differences between the built-in approximation and RDKit's STANDARD descriptors, computed per
 * molecule and shown wherever both are presented. Nothing here asserts equality.
 */
import type { MolProps } from './properties';
import { rdkitDescriptors, ro5, ro5Refined, RdkitDescriptor } from './rdkit';

export interface Difference { property: string; builtin: string | number; rdkit: string | number; builtinMethod: string; rdkitMethod: string }

export function compareDescriptors(b: MolProps, r: RdkitDescriptor): Difference[] {
  const d: Difference[] = [];
  const add = (property: string, builtin: string | number, rdkit: string | number, builtinMethod: string, rdkitMethod: string) => d.push({ property, builtin, rdkit, builtinMethod, rdkitMethod });
  if (b.formula !== r.formula) add('formula', b.formula, r.formula, 'builtin Hill formula', 'rdMolDescriptors.CalcMolFormula');
  if (Math.abs(b.molecular_weight - r.molWt) > 0.01) add('molecular weight (Da)', b.molecular_weight, r.molWt, 'builtin abridged atomic weights', 'Descriptors.MolWt');
  if (b.heavy_atom_count !== r.heavyAtoms) add('heavy atoms', b.heavy_atom_count, r.heavyAtoms, 'builtin atom count', 'Mol.GetNumHeavyAtoms');
  if (b.ring_count !== r.rings) add('ring count', b.ring_count, r.rings, 'builtin ring-closure count', 'rdMolDescriptors.CalcNumRings');
  if (b.hydrogens_on_nitrogen_oxygen !== r.hbd) add('H-bond donors', b.hydrogens_on_nitrogen_oxygen, r.hbd, 'builtin: hydrogens on N/O (simple count)', 'Lipinski.NumHDonors (standard)');
  if (b.nitrogen_oxygen_atom_count !== r.hba) add('H-bond acceptors', b.nitrogen_oxygen_atom_count, r.hba, 'builtin: N+O atoms (simple count)', 'Lipinski.NumHAcceptors (standard)');
  return d;
}



/** The `standard_descriptors` section of the E-LAB properties response (testable without the HTTP/MFA stack). */
export async function standardDescriptorsFor(smiles: string, builtin: MolProps, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const batch = await rdkitDescriptors([smiles], { timeoutMs: 20_000, env });
  if (batch.status === 'ok' && batch.results[0].ok) {
    const d = batch.results[0] as RdkitDescriptor;
    return {
      status: 'ok', engine: 'rdkit', version: batch.rdkitVersion, methods: batch.methods, descriptors: d,
      drug_likeness: { original_lipinski: ro5(d), standard_refined: ro5Refined(d), note: 'Two conventions are shown because RDKit standard donor/acceptor counts differ from the original-Lipinski counters.' },
      differences_from_builtin: compareDescriptors(builtin, d),
    };
  }
  if (batch.status === 'ok') return { status: 'rdkit_rejected_smiles', engine: 'rdkit', version: batch.rdkitVersion, error: (batch.results[0] as { error: string }).error };
  return { status: 'unavailable', reason: batch.reason, note: 'Standard H-bond counts and drug-likeness need RDKit; the built-in values use different, simple counts.' };
}
