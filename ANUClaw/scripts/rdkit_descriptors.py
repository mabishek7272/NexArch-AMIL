"""RDKit descriptor worker. Reads {"smiles": [...]} on stdin, writes JSON on stdout.
Every descriptor is named with the exact RDKit function that produced it; the RDKit
version is reported. No network, no files. Run with: python -I scripts/rdkit_descriptors.py"""
import json
import sys

import rdkit
from rdkit import Chem
from rdkit.Chem import Crippen, Descriptors, Lipinski, rdMolDescriptors

MAX_MOLECULES = 10000
MAX_SMILES_LEN = 2000

def one(smi):
    if not isinstance(smi, str) or not smi.strip() or len(smi) > MAX_SMILES_LEN:
        return {"ok": False, "error": "invalid_smiles_input"}
    m = Chem.MolFromSmiles(smi)  # RDKit sanitises; failures return None
    if m is None:
        return {"ok": False, "error": "rdkit_parse_failed"}
    return {
        "ok": True,
        "formula": rdMolDescriptors.CalcMolFormula(m),                       # rdMolDescriptors.CalcMolFormula
        "molWt": round(Descriptors.MolWt(m), 3),                             # Descriptors.MolWt
        "heavyAtoms": m.GetNumHeavyAtoms(),                                  # Mol.GetNumHeavyAtoms
        "rings": rdMolDescriptors.CalcNumRings(m),                           # rdMolDescriptors.CalcNumRings
        "hbd": Lipinski.NumHDonors(m),                                       # Lipinski.NumHDonors   (standard, refined)
        "hba": Lipinski.NumHAcceptors(m),                                    # Lipinski.NumHAcceptors (standard, refined)
        "hbdOriginalLipinski": rdMolDescriptors.CalcNumLipinskiHBD(m),       # rdMolDescriptors.CalcNumLipinskiHBD
        "hbaOriginalLipinski": rdMolDescriptors.CalcNumLipinskiHBA(m),       # rdMolDescriptors.CalcNumLipinskiHBA
        "tpsa": round(rdMolDescriptors.CalcTPSA(m), 3),                      # rdMolDescriptors.CalcTPSA
        "crippenLogP": round(Crippen.MolLogP(m), 3),                         # Crippen.MolLogP
        "rotatableBonds": rdMolDescriptors.CalcNumRotatableBonds(m),         # rdMolDescriptors.CalcNumRotatableBonds
    }

def main():
    req = json.load(sys.stdin)
    smiles = req.get("smiles")
    if not isinstance(smiles, list) or len(smiles) > MAX_MOLECULES:
        print(json.dumps({"ok": False, "error": "bad_request"})); return
    print(json.dumps({
        "ok": True, "rdkitVersion": rdkit.__version__,
        "methods": {
            "hbd": "rdkit.Chem.Lipinski.NumHDonors", "hba": "rdkit.Chem.Lipinski.NumHAcceptors",
            "hbdOriginalLipinski": "rdkit.Chem.rdMolDescriptors.CalcNumLipinskiHBD", "hbaOriginalLipinski": "rdkit.Chem.rdMolDescriptors.CalcNumLipinskiHBA",
            "molWt": "rdkit.Chem.Descriptors.MolWt", "tpsa": "rdkit.Chem.rdMolDescriptors.CalcTPSA", "crippenLogP": "rdkit.Chem.Crippen.MolLogP",
        },
        "results": [one(s) for s in smiles],
    }))

main()
