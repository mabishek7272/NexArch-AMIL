#!/usr/bin/env bash
# PosturePulse video -> pose -> metrics -> report -> clinician release -> ANUClaw import, on a SYNTHETIC mannequin clip.
# Process-only configuration; disposable database; nothing in the PosturePulse repo is modified. NO metric is seeded.
#   usage: [EXCLUDE_ROW=1] run.sh WORKDIR [PG_ADMIN_URL] [SHOULDER_TILT_PX]   (EXCLUDE_ROW=1: clinician withdraws one row before release)
# Needs: node, the PosturePulse repo checkout (PP_REPO), its ml-service .venv, pose model files (POSE_MODELS dir with
# pose_landmarker_full.task and pose_landmarker_lite.task), a disposable PostgreSQL.
set -euo pipefail
WORK=${1:?workdir}; PGADMIN=${2:-postgres://anuclaw_test:disposable-local-test@127.0.0.1:55432/postgres}; TILT=${3:-0}
HERE=$(cd "$(dirname "$0")" && pwd); ANU=$(cd "$HERE/../.." && pwd)
PP_REPO=${PP_REPO:-$(cd "$ANU/../.." && pwd)}; POSE_MODELS=${POSE_MODELS:?dir with pose_landmarker_*.task}
ML=${ML_DIR:-"$PP_REPO/services/ml-service"}; BE="$PP_REPO/services/backend-api"
mkdir -p "$WORK/clips"; DB="pp_e2e_$(openssl rand -hex 4)"; BP=${BACKEND_PORT:-54300}; MP=${ML_PORT:-54301}
export DATABASE_URL="postgresql://$(node -e "const u=new URL('$PGADMIN');console.log(u.username+':'+u.password+'@'+u.host)")/$DB"
export JWT_SECRET=$(openssl rand -hex 32) PATIENT_DATA_KEY=$(openssl rand -base64 32) CLIP_DIR="$WORK/clips" ML_SERVICE_URL="http://127.0.0.1:$MP" PORT=$BP
PW="synthetic-$(openssl rand -hex 6)"; PIDS=()
# SIGNED_EXPORT=1 requires a backend that has the signed-export route (see docs/proposals/posturepulse-signed-export.md); the secret is process-only.
if [ "${SIGNED_EXPORT:-0}" = 1 ]; then export EXPORT_SIGNING_SECRET=$(openssl rand -hex 32); fi
cleanup() { for port in $BP $MP; do lsof -ti tcp:$port 2>/dev/null | xargs kill 2>/dev/null || true; done; sleep 2
  (cd "$ANU" && node -e "const {Client}=require('pg');(async()=>{const c=new Client({connectionString:'$PGADMIN'});await c.connect();await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=\$1',['$DB']);await c.query('DROP DATABASE IF EXISTS $DB');await c.end()})().catch(()=>{})"); }
trap cleanup EXIT
(cd "$ANU" && node -e "const {Client}=require('pg');(async()=>{const c=new Client({connectionString:'$PGADMIN'});await c.connect();await c.query('CREATE DATABASE $DB');await c.end()})()")
(cd "$BE" && npx prisma migrate deploy >"$WORK/migrate.log" 2>&1 && npx ts-node scripts/seed-clinician.ts synth-clinician "$PW" >/dev/null && npx ts-node scripts/seed-clinician.ts synth-clinician-b "$PW" >/dev/null)
(cd "$ML" && PYTHONDONTWRITEBYTECODE=1 POSE_LANDMARKER_FULL_MODEL_PATH="$POSE_MODELS/pose_landmarker_full.task" POSE_LANDMARKER_MODEL_PATH="$POSE_MODELS/pose_landmarker_lite.task" .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port $MP >"$WORK/ml.log" 2>&1 & echo $! >"$WORK/ml.pid"); PIDS+=("$(cat "$WORK/ml.pid")")
(cd "$BE" && npx ts-node src/main.ts >"$WORK/backend.log" 2>&1 & echo $! >"$WORK/be.pid"); PIDS+=("$(cat "$WORK/be.pid")")
B=http://127.0.0.1:$BP
for i in $(seq 1 60); do curl -sf "$B/health" >/dev/null && curl -sf "http://127.0.0.1:$MP/internal/metrics/catalog" >/dev/null && break; sleep 2; done
(cd "$ML" && PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -I "$HERE/render_clip.py" "$WORK/clip" "$TILT" 60 2>&1 | grep -v objc)
j() { curl -s -m 60 -H 'content-type: application/json' "$@"; }
py() { python3 -c "$1"; }
CID=$(j -X POST $B/consent-records -d '{"subjectPseudoId":"synthetic-mannequin-001","scopes":["derived_events"]}' | py "import sys,json;print(json.load(sys.stdin)['id'])")
SES=$(j -X POST $B/sessions -d "{\"subjectPseudoId\":\"synthetic-mannequin-001\",\"protocolId\":\"sit-to-stand\",\"protocolVersion\":\"v0-draft\",\"deploymentContext\":\"clinic_supervised\",\"consentRecordId\":\"$CID\",\"retentionPolicy\":{\"rawVideo\":{\"optIn\":false,\"retentionDays\":null},\"derivedEvents\":{\"retentionDays\":30}}}")
SID=$(echo "$SES" | py "import sys,json;print(json.load(sys.stdin)['session']['id'])"); STOK=$(echo "$SES" | py "import sys,json;print(json.load(sys.stdin)['sessionToken'])")
CT=$(j -X POST $B/auth/login -d "{\"username\":\"synth-clinician\",\"password\":\"$PW\"}" | py "import sys,json;print(json.load(sys.stdin)['accessToken'])")
SIDECAR=$(py "import json;d=json.load(open('$WORK/clip/sidecar.json'));d['sessionId']='$SID';print(json.dumps(d))")
UP=$(curl -s -m 120 -X PUT "$B/sessions/$SID/clips/static.anterior" -H "authorization: Bearer $STOK" -F "sidecar=$SIDECAR" -F "clip=@$WORK/clip/clip.mov;type=video/quicktime;filename=clip.mov"); echo "upload: $UP"
for i in $(seq 1 90); do
  code=$(curl -s -o "$WORK/preview.json" -w '%{http_code}' "$B/sessions/$SID/report-preview" -H "authorization: Bearer $CT"); [ "$code" = 200 ] && break; sleep 2; done
echo "preview http $code after ~$((i*2))s"; [ "$code" = 200 ] || { cat "$WORK/preview.json"; tail -20 "$WORK/ml.log" | cut -c1-200; exit 1; }
RID=$(j -X POST $B/sessions/$SID/report -H "authorization: Bearer $CT" | tee "$WORK/draft.json" | py "import sys,json;print(json.load(sys.stdin)['reportId'])")
py "
import json;d=json.load(open('$WORK/draft.json'))
for r in d['rows']: print(r['metricKey'], r['tier'], 'estimate' if r.get('estimate') else ('unsupported:'+','.join(r.get('unsupported',{}).get('reasons',[])) if r.get('unsupported') else 'other'), r.get('estimate'), r.get('position'))" | tee "$WORK/rows.txt"
if [ "${EXCLUDE_ROW:-0}" = 1 ]; then j -X POST $B/reports/$RID/rows/exclude -H "authorization: Bearer $CT" -d '{"metricKey":"static.hip_line_tilt","stepId":"static.anterior","reason":"synthetic exclusion test"}' >/dev/null; fi
j -X POST $B/reports/$RID/sign-off -H "authorization: Bearer $CT" -d "{\"password\":\"$PW\"}" >"$WORK/signoff.json"
RTOK=$(j -X POST $B/sessions/$SID/report-access -H "authorization: Bearer $STOK" | py "import sys,json;print(json.load(sys.stdin)['reportAccessToken'])")
CTB=$(j -X POST $B/auth/login -d "{\"username\":\"synth-clinician-b\",\"password\":\"$PW\"}" | py "import sys,json;print(json.load(sys.stdin)['accessToken'])")
cat >"$WORK/live-env.sh" <<EOT
export ANUCLAW_POSTUREPULSE_LIVE_URL=$B ANUCLAW_POSTUREPULSE_LIVE_SESSION=$SID ANUCLAW_POSTUREPULSE_LIVE_REPORT_TOKEN=$RTOK ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_TOKEN=$CT ANUCLAW_POSTUREPULSE_LIVE_SUBJECT=synthetic-mannequin-001 ANUCLAW_POSTUREPULSE_LIVE_CONSENT=$CID ANUCLAW_POSTUREPULSE_LIVE_PIPELINE=real_pose_model_on_synthetic_video ANUCLAW_POSTUREPULSE_LIVE_EXPECT_WITHDRAWN=${EXCLUDE_ROW:-0}
${EXPORT_SIGNING_SECRET:+export ANUCLAW_POSTUREPULSE_LIVE_SIGNED_SECRET=$EXPORT_SIGNING_SECRET}
export ANUCLAW_POSTUREPULSE_LIVE_CLINICIAN_B_TOKEN=$CTB ANUCLAW_POSTUREPULSE_LIVE_BACKEND_DIR=$BE ANUCLAW_POSTUREPULSE_LIVE_DATABASE_URL=$DATABASE_URL
EOT
(cd "$ANU" && source "$WORK/live-env.sh" && export JWT_SECRET PATIENT_DATA_KEY && ANUCLAW_TEST_PG_URL="$PGADMIN" npx vitest run src/integrations/posturepulse/posturepulse-live.test.ts 2>&1 | grep -E "✓|×|→|Test Files|Tests ")
