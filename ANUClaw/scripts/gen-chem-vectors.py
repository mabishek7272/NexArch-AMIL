"""Regenerates src/engines/cheminformatics/rdkit-vectors.json from RDKit (reference values).
    .venv-chem/bin/python -I scripts/gen-chem-vectors.py > src/engines/cheminformatics/rdkit-vectors.json
src/engines/cheminformatics/rdkit-crosscheck.test.ts compares the TypeScript engine against it."""
import json
import rdkit
from rdkit import Chem
from rdkit.Chem import Descriptors, Lipinski, rdMolDescriptors
PANEL = {
  'aspirin': 'CC(=O)Oc1ccccc1C(=O)O', 'paracetamol': 'CC(=O)Nc1ccc(O)cc1', 'ibuprofen': 'CC(C)Cc1ccc(cc1)C(C)C(=O)O',
  'caffeine': 'Cn1cnc2c1c(=O)n(C)c(=O)n2C', 'ethanol': 'CCO', 'benzene': 'c1ccccc1', 'toluene': 'Cc1ccccc1',
  'acetic_acid': 'CC(=O)O', 'glycine': 'NCC(=O)O', 'propranolol': 'CC(C)NCC(O)COc1cccc2ccccc12',
  'naproxen': 'COc1ccc2cc(ccc2c1)C(C)C(=O)O', 'nicotine': 'CN1CCCC1c1cccnc1', 'pyridine': 'c1ccncc1',
  'cyclohexane': 'C1CCCCC1', 'ammonium_acetate': 'CC(=O)[O-].[NH4+]', 'chloroform': 'ClC(Cl)Cl',
  'dimethylsulfoxide': 'CS(C)=O', 'urea': 'NC(N)=O', 'acetonitrile': 'CC#N', 'phenol': 'Oc1ccccc1',
  'imidazole': 'c1c[nH]cn1', 'furan': 'c1ccoc1', 'thiophene': 'c1ccsc1', 'naphthalene': 'c1ccc2ccccc2c1',
  'metformin': 'CN(C)C(=N)N=C(N)N', 'atenolol': 'CC(C)NCC(O)COc1ccc(CC(N)=O)cc1',
}
out = {'_provenance': {'generator': 'scripts/gen-chem-vectors.py', 'rdkit': rdkit.__version__}, 'molecules': {}}
for name, smi in PANEL.items():
    m = Chem.MolFromSmiles(smi)
    out['molecules'][name] = {
        'smiles': smi, 'formula': rdMolDescriptors.CalcMolFormula(m), 'mw': round(Descriptors.MolWt(m), 3),
        'heavyAtoms': m.GetNumHeavyAtoms(), 'hbd': Lipinski.NumHDonors(m), 'hba': Lipinski.NumHAcceptors(m),
        'rings': rdMolDescriptors.CalcNumRings(m),
        # original-Lipinski counters (HBA = N+O atoms; HBD = N/O atoms bearing >=1 H) and the number of H on N/O
        'hbdLipinskiAtoms': rdMolDescriptors.CalcNumLipinskiHBD(m), 'hbaLipinskiAtoms': rdMolDescriptors.CalcNumLipinskiHBA(m),
        'hOnNO': sum(a.GetTotalNumHs() for a in m.GetAtoms() if a.GetSymbol() in ('N', 'O')),
        'nPlusO': sum(1 for a in m.GetAtoms() if a.GetSymbol() in ('N', 'O')),
    }
print(json.dumps(out, indent=1))
