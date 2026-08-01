#!/usr/bin/env bash
# Extract one Geofabrik continent's inland water polygons via GDAL on WSL
# native disk (avoids slow /mnt/<drive> 9p random I/O).
set -euo pipefail

REGION="${1:?region required}"
REPO="${REPO:-/mnt/c/workspace/is-on-water}"
NATIVE_ROOT="${OSM_NATIVE_WORK:-/home/dillo/osm-inland-work}"
GDAL_IMAGE="${GDAL_IMAGE:-ghcr.io/osgeo/gdal:alpine-normal-latest}"
WHERE="(natural = 'water' OR landuse = 'reservoir' OR waterway = 'riverbank' OR water IN ('river', 'canal', 'pond', 'basin', 'oxbow', 'lake', 'lagoon', 'reservoir', 'moat', 'reflecting_pool'))"

WORK="${NATIVE_ROOT}/${REGION}"
HOST_PBF="${REPO}/data/_osm_inland/${REGION}-latest.osm.pbf"
HOST_OUT="${REPO}/data/_osm_inland/${REGION}-water.tmp.fgb"
HOST_CONF="${REPO}/scripts/osmconf-water.ini"
NATIVE_PBF="${WORK}/${REGION}-latest.osm.pbf"
NATIVE_OUT="${WORK}/${REGION}-water.tmp.fgb"

mkdir -p "${WORK}"
df -h "${NATIVE_ROOT}" /home || df -h /

if [[ ! -f "${HOST_PBF}" ]]; then
  echo "Missing ${HOST_PBF}" >&2
  exit 1
fi

if [[ -f "${HOST_OUT}" && -s "${HOST_OUT}" ]]; then
  echo "Already have ${HOST_OUT} ($(du -h "${HOST_OUT}" | cut -f1)); skip."
  exit 0
fi

if [[ ! -f "${NATIVE_PBF}" ]] || [[ "$(stat -c%s "${NATIVE_PBF}" 2>/dev/null || echo 0)" -lt "$(stat -c%s "${HOST_PBF}")" ]]; then
  echo "Copying $(basename "${HOST_PBF}") ($(du -h "${HOST_PBF}" | cut -f1)) to native disk…"
  cp -f "${HOST_PBF}" "${NATIVE_PBF}"
fi
cp -f "${HOST_CONF}" "${WORK}/osmconf-water.ini"
rm -f "${NATIVE_OUT}"

echo "Extracting inland water polygons from ${REGION} (native)…"
docker run --rm \
  -v "${WORK}:/work" \
  -v "${HOST_CONF}:/osmconf.ini:ro" \
  "${GDAL_IMAGE}" \
  ogr2ogr --config OSM_CONFIG_FILE /osmconf.ini \
    -f FlatGeobuf -nlt PROMOTE_TO_MULTI -nln water \
    -where "${WHERE}" \
    -select natural,landuse,waterway,water \
    "/work/${REGION}-water.tmp.fgb" \
    "/work/${REGION}-latest.osm.pbf" \
    multipolygons

cp -f "${NATIVE_OUT}" "${HOST_OUT}"
ls -lah "${HOST_OUT}"
echo "Done ${REGION}."
