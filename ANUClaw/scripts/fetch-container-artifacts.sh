#!/usr/bin/env bash
# Fetch the large third-party artifacts the full image needs, BEFORE `docker build`, into container/vendor/ (resumable; re-run to continue).
# GATK 4.5.0.0: expected size 741,084,040 bytes (reported by GitHub's release API; GitHub publishes no checksum for it). The accepted file's SHA-256 is
# printed and recorded in container/vendor/gatk-4.5.0.0.zip.sha256; pin it for later builds with GATK_SHA256=<hex> in the environment.
set -euo pipefail
cd "$(dirname "$0")/../container"
OUT=vendor/gatk-4.5.0.0.zip
if [ -f "$OUT" ] && [ -f "$OUT.sha256" ]; then echo "already present: $OUT ($(cut -d' ' -f1 "$OUT.sha256"))"; exit 0; fi
./fetch-verified.sh https://github.com/broadinstitute/gatk/releases/download/4.5.0.0/gatk-4.5.0.0.zip "$OUT" 741084040 "${GATK_SHA256:-}"
unzip -tq "$OUT" >/dev/null && echo "unzip -t: archive intact"
(sha256sum "$OUT" 2>/dev/null || shasum -a 256 "$OUT") | tee "$OUT.sha256"
