#!/bin/sh
# Download ONE large artifact RESUMABLY with sanitized logging and strict acceptance checks.
#   fetch-verified.sh URL OUT EXPECTED_SIZE_BYTES [EXPECTED_SHA256]
# Designed for slow links (GitHub's release CDN measured ~100 KB/s here, so a 741 MB asset takes 1-2 hours):
# - NO overall time limit; instead a STALL detector (< 1 KB/s for 120 s aborts the attempt) and RESUME (Range) across attempts, so progress is never thrown away.
# - Up to 40 attempts with back-off. HTTP status, curl exit code and byte counts of every attempt are logged. The URL's query string (signed redirect
#   tokens) is never logged.
# - A PARTIAL file is only ever kept as "<OUT>.part" and is NEVER accepted: the final file appears only after size == EXPECTED_SIZE_BYTES, and (when
#   given) SHA-256 == EXPECTED_SHA256. Oversized or mismatching files are deleted. The computed SHA-256 is printed (trust-on-first-use if none is pinned).
set -u
URL="$1"; OUT="$2"; WANT="$3"; SHA="${4:-}"; PART="$OUT.part"
HERE=$(cd "$(dirname "$0")" && pwd)
# PARALLEL=N (default 16): the CDN throttles each connection (~65 KB/s measured); N ranged connections scale almost linearly. PARALLEL=1 = single resumable stream.
PARALLEL="${PARALLEL:-16}"; CHUNK=$((16 * 1024 * 1024))
if [ "$PARALLEL" -gt 1 ] && [ "$WANT" -gt $((4 * CHUNK)) ] && [ ! -f "$OUT" ]; then
  D="$OUT.chunks"; mkdir -p "$D"; : > "$D/chunks.log"; n=$(( (WANT + CHUNK - 1) / CHUNK )); i=0; list="$D/list"; : > "$list"
  while [ "$i" -lt "$n" ]; do a=$((i * CHUNK)); b=$((a + CHUNK - 1)); [ "$b" -ge "$WANT" ] && b=$((WANT - 1)); echo "$i $a $b" >> "$list"; i=$((i + 1)); done
  echo "parallel fetch: $n chunks of up to $CHUNK bytes, $PARALLEL connections"
  ( while :; do sleep 60; echo "progress: $(cat "$D"/chunk.[0-9]* 2>/dev/null | wc -c | tr -d ' ') bytes complete of $WANT, $(ls "$D"/chunk.[0-9]*.part 2>/dev/null | wc -l | tr -d ' ') in flight"; done ) &
  PROG=$!
  awk -v u="$URL" -v d="$D" '{print u, d, $1, $2, $3}' "$list" | xargs -P "$PARALLEL" -L 1 sh -c '"$0"/fetch-chunk.sh "$1" "$2" "$3" "$4" "$5"' "$HERE" 2>/dev/null || true
  kill "$PROG" 2>/dev/null
  missing=0; i=0; while [ "$i" -lt "$n" ]; do [ -f "$D/chunk.$i" ] || missing=$((missing + 1)); i=$((i + 1)); done
  if [ "$missing" -ne 0 ]; then echo "FAILED: $missing of $n chunks incomplete (kept for resume; nothing is accepted)" >&2; exit 2; fi
  i=0; : > "$PART"; while [ "$i" -lt "$n" ]; do cat "$D/chunk.$i" >> "$PART"; i=$((i + 1)); done
  echo "assembled $(wc -c < "$PART" | tr -d ' ')/$WANT bytes from $n verified chunks"
  [ "$(wc -c < "$PART" | tr -d ' ')" -eq "$WANT" ] || { echo "assembled size mismatch — discarding" >&2; rm -f "$PART"; exit 2; }
  if [ -n "$SHA" ]; then got=$(sha256sum "$PART" 2>/dev/null | cut -d' ' -f1); [ "$got" = "$SHA" ] || { echo "CHECKSUM MISMATCH: got $got want $SHA — discarding" >&2; rm -f "$PART"; exit 3; }; fi
  mv "$PART" "$OUT"; echo "accepted: $(wc -c < "$OUT" | tr -d ' ') bytes"; exit 0
fi
clean() { sed -E 's/\?[^ "]*//g'; }
size_of() { [ -f "$1" ] && wc -c < "$1" | tr -d ' ' || echo 0; }
i=0
while [ "$i" -lt 40 ]; do
  have=$(size_of "$PART")
  if [ "$have" -gt "$WANT" ]; then echo "partial file larger than expected ($have > $WANT): discarding"; rm -f "$PART"; have=0; fi
  if [ "$have" -ne "$WANT" ]; then
    i=$((i + 1))
    code=$(curl -sS -L -C - --connect-timeout 30 --speed-limit 1000 --speed-time 120 -o "$PART" -w '%{http_code}' "$URL" 2>/tmp/fetch.err); rc=$?
    echo "fetch attempt $i: curl_exit=$rc http=$code bytes=$(size_of "$PART")/$WANT $(head -c 200 /tmp/fetch.err | clean)"
    # 416 = range not satisfiable: the part may already be complete or corrupt; fall through to the size check
    [ "$(size_of "$PART")" -eq "$WANT" ] || { sleep $(( i < 10 ? 5 * i : 50 )); continue; }
  fi
  if [ -n "$SHA" ]; then got=$((sha256sum "$PART" 2>/dev/null || shasum -a 256 "$PART") | cut -d' ' -f1); [ "$got" = "$SHA" ] || { echo "CHECKSUM MISMATCH: got $got want $SHA — discarding" >&2; rm -f "$PART"; exit 3; }; fi
  mv "$PART" "$OUT"; echo "accepted: $(size_of "$OUT") bytes, sha256 $( (sha256sum "$OUT" 2>/dev/null || shasum -a 256 "$OUT") | cut -d' ' -f1)"; exit 0
done
echo "FAILED after $i attempts (partial kept as $PART, $(size_of "$PART")/$WANT bytes; it is not accepted)" >&2; exit 2
