#!/usr/bin/env python3
"""
aikosh_data_loader.py
=====================
Production-ready data access layer for ANUClaw v3 to query the full AIKosh dataset:
- NidaanKosha-100k-V1: Complete 6.84 Million laboratory readings across Part 1 & Part 2
- BODHI-M & BODHI-S: Full SNOMED-CT knowledge graphs for drugs, labs, and symptoms
- Eka NFI Pharmacology: National Formulary of India drug indications, dosing, precautions
- Indian Drug MCQA: Indian branded medications and salt compositions
- Medical Calculator Eval & Indian Protocols Clinical QnA
- Curated ICMR Pathology Cohorts and Biopsy Reference Cases
"""

import os
import json
import pandas as pd
from typing import List, Dict, Any, Optional, Iterator

BASE_DATA_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "data", "aikosh")
)

class AIKoshDataLoader:
    def __init__(self, data_dir: str = BASE_DATA_DIR):
        self.data_dir = data_dir
        self.lab_dir = os.path.join(data_dir, "lab")
        self.kg_dir = os.path.join(data_dir, "knowledge_graph")
        self.path_dir = os.path.join(data_dir, "pathology")
        self.eval_dir = os.path.join(data_dir, "clinical_eval")
        self.pharm_dir = os.path.join(data_dir, "pharmacology")

    def query_lab_readings(self, test_name: Optional[str] = None, loinc: Optional[str] = None, limit: int = 100) -> pd.DataFrame:
        """
        Queries across BOTH partitions of the full 6.84M NidaanKosha laboratory dataset.
        Filters by exact test name or LOINC code.
        """
        filters = []
        if test_name:
            filters.append(("test_name", "==", test_name))
        if loinc:
            filters.append(("loinc", "==", loinc))

        dfs = []
        remaining = limit
        for part in ["nidaankosha_part1.parquet", "nidaankosha_part2.parquet"]:
            p_path = os.path.join(self.lab_dir, part)
            if not os.path.exists(p_path):
                continue
            df_part = pd.read_parquet(p_path, filters=filters if filters else None)
            if len(df_part) > remaining:
                dfs.append(df_part.head(remaining))
                break
            else:
                dfs.append(df_part)
                remaining -= len(df_part)
                if remaining <= 0:
                    break

        if not dfs:
            return pd.DataFrame()
        return pd.concat(dfs, ignore_index=True)

    def get_patient_document_panel(self, document_id: str) -> pd.DataFrame:
        """Retrieves all lab tests associated with a single patient encounter document ID."""
        dfs = []
        for part in ["nidaankosha_part1.parquet", "nidaankosha_part2.parquet"]:
            p_path = os.path.join(self.lab_dir, part)
            if os.path.exists(p_path):
                df = pd.read_parquet(p_path, filters=[("document_id", "==", document_id)])
                if not df.empty:
                    dfs.append(df)
        if not dfs:
            return pd.DataFrame()
        return pd.concat(dfs, ignore_index=True)

    def get_knowledge_graph_facts(self, domain: str = "m", limit: int = 50) -> List[str]:
        """Loads natural language clinical assertions from BODHI-M (medical) or BODHI-S (symptoms)."""
        fname = f"bodhi_{domain.lower()}_nl_facts.jsonl"
        path = os.path.join(self.kg_dir, fname)
        if not os.path.exists(path):
            raise FileNotFoundError(f"Missing KG facts file: {path}")
        facts = []
        with open(path, "r", encoding="utf-8") as f:
            for idx, line in enumerate(f):
                if idx >= limit:
                    break
                facts.append(json.loads(line.strip()).get("text", ""))
        return facts

    def get_pharmacology_rules(self, limit: int = 50) -> pd.DataFrame:
        """Loads National Formulary of India drug pharmacology & safety rules."""
        path = os.path.join(self.pharm_dir, "eka_nfi_drug_pharmacology.parquet")
        if not os.path.exists(path):
            raise FileNotFoundError(f"Missing pharmacology file: {path}")
        return pd.read_parquet(path).head(limit)

    def get_pathology_cases(self) -> List[Dict[str, Any]]:
        """Loads curated pathology & histopathology reference cases."""
        path = os.path.join(self.path_dir, "sample_pathology_cases.json")
        if not os.path.exists(path):
            raise FileNotFoundError(f"Missing pathology cases: {path}")
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)


if __name__ == "__main__":
    loader = AIKoshDataLoader()
    print("Testing multi-part full lab query across 6.84M rows:")
    df_platelets = loader.query_lab_readings(test_name="Platelet Count", limit=5)
    print(df_platelets[["document_id", "test_name", "value", "unit", "display_ranges", "loinc"]])

    print("\nTesting pharmacology rules query:")
    df_pharm = loader.get_pharmacology_rules(limit=2)
    print(f"Loaded {len(df_pharm)} pharmacology rules successfully.")
