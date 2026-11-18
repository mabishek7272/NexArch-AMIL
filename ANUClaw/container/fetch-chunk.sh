#!/bin/sh
# One byte range of a larger download, resumable, size-checked. Used by fetch-verified.sh (parallel mode). Never logs the URL's query string.
#   fetch-chunk.sh URL DIR INDEX START END     -> DIR/chunk.INDEX (exactly END-START+1 bytes) or exit 1
URL="$1"; DIR="$2"; N="$3"; A="$4"; B="$5"; WANT=$((B - A + 1)); F="$DIR/chunk.$N"; P="$F.part"
[ -f "$F" ] && [ "$(wc -c < "$F" | tr -d ' ')" -eq "$WANT" ] && exit 0
try=0
while [ "$try" -lt 30 ]; do
  try=$((try + 1)); have=$( [ -f "$P" ] && wc -c < "$P" | tr -d ' ' || echo 0 )
  [ "$have" -gt "$WANT" ] && { rm -f "$P"; have=0; }
  if [ "$have" -ne "$WANT" ]; then
    code=$(curl -sS -L -r "$((A + have))-$B" --connect-timeout 30 --speed-limit 1000 --speed-time 90 -o "$P.tmp" -w '%{http_code}' "$URL" 2>/dev/null); rc=$?
    # 206 = partial content for the requested range; anything else is not accepted
    if [ "$rc" -eq 0 ] && [ "$code" = "206" ]; then cat "$P.tmp" >> "$P"; fi; rm -f "$P.tmp"
    echo "chunk $N try $try: curl_exit=$rc http=$code bytes=$(wc -c < "$P" 2>/dev/null | tr -d ' ' || echo 0)/$WANT" >> "$DIR/chunks.log"
  fi
  if [ "$( [ -f "$P" ] && wc -c < "$P" | tr -d ' ' || echo 0 )" -eq "$WANT" ]; then mv "$P" "$F"; exit 0; fi
  sleep $(( try < 6 ? 3 * try : 18 ))
done
exit 1
