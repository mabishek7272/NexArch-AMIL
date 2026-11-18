"""
AIKosh local inventory (read-only, offline). Run INSIDE the agent image with networking disabled; see scripts/aikosh-inventory.sh.
Reads files under /d (mounted read-only) and prints JSON. It never writes, never opens a network connection and never prints record VALUES:
only hashes, sizes, schemas, counts, column-name indicators and aggregate pattern counts. Personal-data indicators are HEURISTIC hints for a human reviewer,
not a determination: absence of an indicator proves nothing, and presence does not prove identifiability.
"""
import csv, hashlib, json, os, re, sys
csv.field_size_limit(1 << 28)
ROOT = sys.argv[1] if len(sys.argv) > 1 else "/d"
NAME_HINTS = re.compile(r"(^|_)(name|patient|phone|mobile|email|address|dob|birth|mrn|uhid|aadhaar|aadhar|pan|passport|ssn|pin|pincode|zip|ward|doctor|physician|hospital|lab_name|accession|barcode)(_|$)", re.I)
PROV_HINTS = re.compile(r"(source|publisher|license|licence|institution|organization|organisation|corpus|translator|citation|provenance|origin|author|access|slug)", re.I)
QUASI_HINTS = re.compile(r"(^|_)(age|gender|sex|document_id|case_id|specimen|date|time|city|state|district|region|institution)(_|$)", re.I)
PATTERNS = {
    "email": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "phone_like_10_digit": re.compile(r"(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)"),
    "aadhaar_like_12_digit": re.compile(r"(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)"),
    "date_like": re.compile(r"(?<!\d)(?:\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}-\d{2}-\d{2})(?!\d)"),
    "pin_code_like": re.compile(r"(?<!\d)[1-9]\d{5}(?!\d)"),
}
def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()
def col_info(cols, sample):
    out = []
    for c in cols:
        vals = [r.get(c) for r in sample if isinstance(r, dict)]
        strs = [v if isinstance(v, str) else json.dumps(v, ensure_ascii=False) for v in vals if v not in (None, "")]
        avg = round(sum(len(s) for s in strs) / len(strs), 1) if strs else 0
        pats = {k: sum(1 for s in strs if p.search(s)) for k, p in PATTERNS.items()}
        pats = {k: v for k, v in pats.items() if v}
        out.append({"column": c, "nonEmptyInSample": len(strs), "sampleSize": len(vals), "avgLength": avg, "narrativeLike": avg > 150,
                    "nameIndicator": bool(NAME_HINTS.search(c)), "quasiIdentifierIndicator": bool(QUASI_HINTS.search(c)), "provenanceFieldIndicator": bool(PROV_HINTS.search(c)), "patternHitsInSample": pats})
    return out
def summarize(cols_info):
    return {
        "provenanceFieldsFound": [c["column"] for c in cols_info if c["provenanceFieldIndicator"]],
        "narrativeColumns": [c["column"] for c in cols_info if c["narrativeLike"]],
        "directIdentifierNameIndicators": [c["column"] for c in cols_info if c["nameIndicator"]],
        "quasiIdentifierColumns": [c["column"] for c in cols_info if c["quasiIdentifierIndicator"]],
        "patternIndicators": sorted({k for c in cols_info for k in c["patternHitsInSample"]}),
    }
def inventory(path, rel):
    ext = os.path.splitext(path)[1].lower(); e = {"path": rel, "sizeBytes": os.path.getsize(path), "sha256": sha256(path), "format": ext.lstrip(".")}
    try:
        if ext == ".csv":
            with open(path, newline="", encoding="utf-8") as f:
                rd = csv.DictReader(f); cols = rd.fieldnames or []; n = 0; sample = []
                for r in rd:
                    n += 1
                    if n <= 2000: sample.append(r)
            e.update(rowCount=n, rowCountMethod="full csv parse", columns=cols, schema={c: "string (csv)" for c in cols}); ci = col_info(cols, sample)
        elif ext == ".parquet":
            import pyarrow.parquet as pq
            pf = pq.ParquetFile(path); sc = pf.schema_arrow; cols = sc.names
            e.update(rowCount=pf.metadata.num_rows, rowCountMethod="parquet footer metadata", rowGroups=pf.metadata.num_row_groups, columns=cols, schema={f.name: str(f.type) for f in sc})
            sample = next(pf.iter_batches(batch_size=2000)).to_pylist() if pf.metadata.num_rows else []; ci = col_info(cols, sample)
            md = (sc.metadata or {}).get(b"huggingface")
            if md: e["embeddedMetadataKeys"] = sorted(json.loads(md).keys())
        elif ext == ".jsonl":
            n = 0; keys = {}; sample = []
            with open(path, encoding="utf-8") as f:
                for line in f:
                    if not line.strip(): continue
                    n += 1; o = json.loads(line)
                    if n <= 2000 and isinstance(o, dict): sample.append(o)
                    if n <= 1000 and isinstance(o, dict):
                        for k, v in o.items(): keys.setdefault(k, type(v).__name__)
            cols = list(keys); e.update(rowCount=n, rowCountMethod="full line count", columns=cols, schema=keys); ci = col_info(cols, sample)
        elif ext == ".json":
            with open(path, encoding="utf-8") as f: o = json.load(f)
            if isinstance(o, list):
                keys = {}
                for r in o[:1000]:
                    if isinstance(r, dict):
                        for k, v in r.items(): keys.setdefault(k, type(v).__name__)
                cols = list(keys); e.update(rowCount=len(o), rowCountMethod="top-level array length", columns=cols, schema=keys); ci = col_info(cols, [r for r in o[:2000] if isinstance(r, dict)])
            else:
                top = {k: type(v).__name__ for k, v in o.items()}; e.update(rowCount=None, rowCountMethod="top-level object (no row concept)", columns=list(top), schema=top)
                items = o.get("datasets") if isinstance(o.get("datasets"), list) else []
                e["nestedRecordCount"] = len(items); e["topLevelScalarFields"] = {k: v for k, v in o.items() if isinstance(v, str)}
                keys = {}
                for r in items:
                    for k, v in r.items(): keys.setdefault(k, type(v).__name__)
                ci = col_info(list(keys), items)
        else:
            e["error"] = "unsupported format"; ci = []
    except Exception as ex:
        e["error"] = f"{type(ex).__name__}: {str(ex)[:160]}"; ci = []
    e["columnIndicators"] = ci; e["indicators"] = summarize(ci); return e
files = []
for d, _, fs in os.walk(ROOT):
    for f in sorted(fs):
        p = os.path.join(d, f); files.append(inventory(p, os.path.relpath(p, ROOT)))
files.sort(key=lambda x: x["path"])
print(json.dumps({"schema": "anuclaw-aikosh-inventory/v1", "root": "data/aikosh", "fileCount": len(files), "files": files}, indent=1, ensure_ascii=False))
