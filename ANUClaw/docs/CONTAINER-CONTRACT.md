# Agent container contract (plan F10)

How `src/container-runner.ts` and `container/` fit together. The contract is enforced by `src/container-contract.test.ts`
(real Docker; opt-in).

## Host → container

| Item | Contract |
|---|---|
| Image | `CONTAINER_IMAGE` (default `anuclaw-agent:latest`, built from `container/Dockerfile`). `ENTRYPOINT` is `container/entrypoint.js`. |
| User | the **host user's uid:gid** (`--user`), never root (`claude --dangerously-skip-permissions` refuses root; bind-mounted files keep their owner). `HOME=/tmp` on a tmpfs. |
| Hardening | `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 512`, `--memory 4g`, `--cpus 2`. Network stays on (the agent calls the model API). |
| Credentials | **first stdin line** as a JSON object of strings (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_MODEL`, …). Never in argv, `-e`, `docker inspect`, a file, a log or an error message. The entrypoint hands them to the agent CLI's environment only. |
| Context | `/workspace/group/.anuclaw_context.json` (mode 0600, **already de-identified**): `systemPrompt`, `sessionMessages`, `prompt`, `mediaPath`, `mediaType`. |
| Media | the one file is mounted **read-only** at `/workspace/media/<sanitised-name>`; the context carries the container path. A missing host file is the error `media_not_found` before anything starts. |
| Skills | `container/skills` read-only at `/workspace/skills`. |
| Output | `/workspace/output` ↔ the group's work directory; files written during the run are returned as artifacts. |
| Non-secret config | `CONTAINER_EXTRA_ENV=KEY=VALUE,…` (names containing KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL are refused). |
| Timeout | `CONTAINER_TIMEOUT_MS`; on expiry the container is **removed** (`docker rm -f`) and the run fails with `agent_timeout` — never re-answered by the text-only path. |

## Container → host

stdout is `<response>…</response>`. Exit codes: `0` ok · `64` malformed credentials · `65` credentials not received · `66` context
missing/invalid · `67` media unreachable · `68` agent CLI missing · other = the agent CLI's own code.
`agentExitError()` maps these to `container_credentials_not_delivered`, `container_context_invalid`, `container_media_unreachable`,
`container_agent_cli_missing`, or `agent_failed:exit_<n>`.

## Fallback semantics

| Situation | Result |
|---|---|
| Docker CLI missing, daemon unreachable, image absent/unpullable | **labelled text-only** answer (`executionMode: host_text_only`, no tools, no artifacts, warning text says so) |
| Container started and the agent failed (non-zero exit) | **error** (`executionMode: container`, `agent_failed:…`) — no silent substitute |
| Timeout | error `agent_timeout` |
| Blocked by hooks/egress policy | explicit error before anything runs |

## What was tested, and what was not (2026-11-17) — four DIFFERENT kinds of evidence

| Kind | What ran | Proves | Does NOT prove |
|---|---|---|---|
| **Agent double, real Docker** (thin image `container/Dockerfile.contract`, `fake-claude.js`) | 13 tests | entrypoint bootstrap; credentials on stdin only (not argv/`docker inspect`/files/logs); non-root host uid; cap-drop/no-new-privileges/pids/memory; media read-only + byte-identical; skills read-only; artifacts; timeout removes the container; agent crash → `agent_failed` (no fallback); missing image → labelled text-only; exit codes 64–68 | anything about the real CLI or the tool stack |
| **Real Claude CLI, startup only** (probe image `container/Dockerfile.cli-probe`: Node + real CLI `2.1.326` + the same entrypoint) | `claude --version` as the host user | the real CLI installs and starts in the container, non-root | that it can authenticate or do anything |
| **Real Claude CLI, context + credential path, FAKE key, local capture server, no model** | 1 test | the stdin credential and the supplied context (system prompt, history, prompt) reach the **real CLI**, which sends them (and the requested model) in its API request and puts the key in its auth header; nothing is echoed back; no success wrapper without a model answer | **authenticated agent execution** and **tool execution** (the capture server rejects every request) |
| **Authenticated agent execution** | **NOT RUN.** Test `L-c` exists but is enabled only by a human (`ANUCLAW_REAL_AGENT_CREDENTIAL_TEST=1` + `ANUCLAW_REAL_AGENT_API_KEY` in the environment; it spends money) | — | — |
| **Actual tool execution on the FULL image** (`anuclaw-agent:latest`, id `96ce5ee9afe3`, 12.3 GB; overlay adds only the test double) | **RAN (2026-11-17): 31 passed, 1 skipped at task 71 — superseded at task 72 by 33 passed, 1 skipped (adds nextflow functional, PyMOL failure pinned, application-path job)** — the skipped one is `L-c`, authenticated agent execution (disabled). 12 double-agent contract tests + 7 core tool tests + 8 additional-tool tests + 2 real-CLI (startup; fake-key capture) | samtools SAM→BAM `total=3 mapped=2 reverse=1`; blastn exact substring 100%; bedtools intersect; Python 3.12 RDKit aspirin MolWt 180.16 / SciPy / pandas; obabel SMILES→InChI `C9H8O4`; claude CLI starts; node; GATK 4.5.0.0 runs; vina; fastqc on a FASTQ; bcftools; minimap2 aligns a read; snakemake 9.27.2 dry-run; `pip check` clean + imports (scanpy, anndata, pysam, Bio, pymc, torch); 9 optional tools absent by design | authenticated Claude-agent execution; nextflow was presence-only here at first — SUPERSEDED in task 72 (below); pymol was presence-only — SUPERSEDED: it is installed but NOT functional; the optional environment (`Dockerfile.optional`) was NOT built or tested |

**Full image (`container/Dockerfile`) — build history (2026-11-17; logs kept in the session scratchpad, sanitized excerpts below):**
1. Build 1 (PID 41869, ≈1 h 50 min) **failed at the GATK `wget -q`** (exit 8). The cause was **never established**: `-q` hid the HTTP status, and a later successful HEAD does not prove the failure was transient. It went unnoticed because the watcher's `pgrep -f` matched itself.
2. In-build `curl --max-time 3600` could not finish: the GitHub release CDN served ≈65–100 KB/s per connection. Replaced by a **host-side resumable parallel Range fetch** (`scripts/fetch-container-artifacts.sh`, `container/fetch-verified.sh`, `fetch-chunk.sh`; stall detection, sanitized logs, a `.part` file is never accepted). The artifact is copied into the image. Size is checked (741,084,040 B, from the GitHub API) and `unzip -t` must pass. **No provider checksum exists for GATK**, so the SHA-256 `dc1a4471e8bb566397db9894ca18acbf8f40f3fc312c8fad9a8c5390c218e916` is **trust-on-first-use** (recorded in `container/vendor/gatk-4.5.0.0.zip.sha256`; the build logs it); it was re-observed inside the image.
3. Latent Dockerfile defects fixed: `pip3 install snakemake` (PEP 668) → own venv, exact pin 9.27.2 (not hash-locked, stated); `|| true` that silently dropped vina/pymol removed.
4. Python: Ubuntu 24.04 CPython 3.12, linux/aarch64, **hash-locked wheels-only** (`--require-hashes --only-binary=:all:`) from `container/python/core.lock.txt` (362 distributions), generated by `scripts/lock-container-python.sh` **inside a linux/arm64 python:3.12 container** from pip's resolver report (not from assumptions about latest versions). Build 5 failed here: the first lock was generated on macOS and omitted torch's Linux-only `cuda-toolkit==13.2.2` (`ERROR: Hashes are required in --require-hashes mode`). Fix: resolve on the target; torch is the `+cpu` build from the PyTorch CPU index (no GPU in the image; lock contains no CUDA packages).
5. **Defect found by the full-image import test:** the core lock had resolved `hail` to PyPI's `0.2`, a **metadata-only placeholder with no importable code** (`import hail` fails). Real Hail 0.2.133 needs `pyspark>=3.5,<3.6`, which has no wheel (resolver: `No matching distribution found for pyspark`) → `hail` moved to `container/python/optional.in`; the image no longer claims it. Optional tools (9, with reasons) are in `optional.in`; the optional image is **not built**.
6. **Defect found by actual execution:** snakemake crashed as the host uid (no passwd entry → `getpass.getuser()` KeyError). `USER`/`LOGNAME` are now set by the runner (`src/container-runner.ts`) and the entrypoint environment.
7. Two test-fixture mistakes of mine (a minimap2 read that was not in the reference; a snakemake output grep) were corrected, not hidden.
8. Final build (log `docker-build-attempt8-final.log`) rc=0; image `anuclaw-agent:latest` = `anuclaw-agent:contract-test` = `96ce5ee9afe3`. Pip uses a BuildKit cache mount so downloaded wheels survive a failed attempt.

Reproduce: `docker build -t anuclaw-agent:contract-test -f container/Dockerfile container && docker tag anuclaw-agent:contract-test anuclaw-agent:latest && docker build -t anuclaw-agent-contract-overlay:latest -f container/Dockerfile.contract-overlay container && ANUCLAW_CONTAINER_TESTS=1 ANUCLAW_CONTRACT_IMAGE=anuclaw-agent-contract-overlay:latest ANUCLAW_CLI_IMAGE=anuclaw-agent:latest npx vitest run src/container-contract.test.ts`
The paid authenticated-agent test (`L-c`) stays **disabled, pending your explicit authorization**.

## Defects found by reading the old contract (fixed)

The previous image ran `claude --dangerously-skip-permissions` as root and nothing inside the image read the credentials the host
wrote to stdin or the context file it wrote to disk; media paths were host paths that did not exist in the container;
`-e ANTHROPIC_API_KEY` put the key into `docker inspect`; an agent crash silently became a tool-less host answer; and a timeout
killed only the local `docker` client.

## Task 72 additions (2026-11-17) — supersede the "presence-only" wording above
- **nextflow: functional.** A one-process workflow (`echo functional`) ran on the local executor in the full image as the host uid with `HOME=/tmp`, and the process output was captured (test: "nextflow: a one-process workflow RUNS…"). Version `26.10.6`. Caveat: run from `/workspace` (the image WORKDIR, not writable by the host uid) it fails at `mktemp /workspace/nxf-tmp…`; run it from a writable directory.
- **pymol: ACTUAL FAILURE, not fixed.** `pymol -ckq` fails with `ModuleNotFoundError: No module named 'imp'` (Debian pymol 2.5.0+dfsg targets a Python older than 3.12; `pymol-open-source` has no wheel for this platform). A test pins this behaviour so the suite does not imply PyMOL works. Options (a human/engineering decision): drop PyMOL from the image, ship an `imp` compatibility shim, or build PyMOL from source in the optional image.
- **Application path.** `runAgent` (the normal execution path: runtime check → hardened `docker run` → stdin credentials → entrypoint → agent CLI → artifacts) started the full image and a scripted job (`MODE:JOB`) ran samtools and RDKit inside it; the artifact came back host-owned (`mappedReads 2`, aspirin MolWt `180.16`). **Boundary: the agent CLI is the test double.** Nothing here shows that a Claude agent chooses or drives the tools; that needs the disabled authenticated test.
- **Reproducibility manifest:** `docs/evidence/repro-manifest.json` (generated by `npx tsx scripts/repro-manifest.ts`).
