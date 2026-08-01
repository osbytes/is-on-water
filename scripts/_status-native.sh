#!/usr/bin/env bash
set -euo pipefail
CID=$(docker ps -q | head -n1)
echo "container=${CID:-none}"
if [[ -n "${CID}" ]]; then
  docker ps --format '{{.ID}} {{.Status}} {{.Names}}'
  docker stats --no-stream --format 'cpu={{.CPUPerc}} mem={{.MemUsage}} block={{.BlockIO}}' "$CID"
  docker exec "$CID" sh -c 'cat /proc/1/io; echo ---; ls -la /proc/1/fd; echo ---; ls -lah /work/'
fi
df -h /home
ls -lah /home/dillo/osm-inland-work/europe/ 2>/dev/null || true
ls -lah /mnt/c/workspace/is-on-water/data/_osm_inland/europe-water.tmp.fgb 2>/dev/null || echo 'no host europe fgb yet'
