#!/usr/bin/env bash
# Offline, read-only AIKosh inventory using the local agent image (network disabled, data mounted read-only). Writes governance/aikosh/inventory.generated.json.
set -euo pipefail
cd "$(dirname "$0")/.."
IMG=${AIKOSH_INVENTORY_IMAGE:-anuclaw-agent:latest}
docker run --rm --network none --read-only --tmpfs /tmp -v "$PWD/data/aikosh:/d:ro" -v "$PWD/scripts/aikosh-inventory.py:/inv.py:ro" --entrypoint python "$IMG" /inv.py /d > governance/aikosh/inventory.generated.json.tmp
mv governance/aikosh/inventory.generated.json.tmp governance/aikosh/inventory.generated.json
echo "wrote governance/aikosh/inventory.generated.json ($(python3 -c "import json;print(json.load(open('governance/aikosh/inventory.generated.json'))['fileCount'])") files)"
