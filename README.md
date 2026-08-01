# `is-on-water`

Check whether a geographic coordinate is on water. Exposed via an HTTP API for single coordinate (`GET /api/water?lat=${lat}&lon=${lon}`) and batch (`POST /api/water` with `{ "coordinates": [{ lat, lon }, ...] }`) lookups.

Coverage is opt-in per deployment. Out of the box you get oceans, seas, and inland lakes ≥ 2 km²; enable `rivers` and `ponds` for OSM riverbanks and smaller inland water. See [Coverage layers](#coverage-layers).

Built on [Fastify](https://fastify.dev/) with optional OpenTelemetry, Swagger at `/documentation`, and rate limiting (in-memory by default; Redis when `REDIS_URL` is set).

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/MfUYQX?referralCode=ToZEjF&utm_medium=integration&utm_source=template&utm_campaign=generic)
## Installation

```sh
git clone https://github.com/osbytes/is-on-water

cd is-on-water

pnpm install

## run in development with hot-reload
pnpm dev

## OR build and run
pnpm build && pnpm start
```

## Configuration

See [`.env-example`](./.env-example) for all environment variables.

### Rate limiting

Rate limiting uses an **in-memory** store by default (no Redis required).

To share limits across multiple instances, set `REDIS_URL` (for example `redis://localhost:6379`). You can start Redis with:

```sh
docker compose --profile redis up
```

When `REDIS_URL` is set, `/health` also pings Redis and returns `503` if it is unreachable.

### OpenTelemetry

Disabled by default. Enable with `OTEL_ENABLED=true`.

By default the trace exporter writes to standard output. Set `OTEL_EXPORTER_OTLP_ENDPOINT` (for example `http://localhost:4318/v1/traces`) to export to a collector. `docker compose up` starts Jaeger; UI at http://localhost:16686.

## API

Interactive docs: `/documentation`

Errors use [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) Problem Details (`application/problem+json`).

### GET `/api/water`

```sh
curl "http://localhost:3000/api/water?lat=20.112682&lon=-37.048647"
```

```json
{ "water": true, "lat": 20.112682, "lon": -37.048647, "layer": "oceans:medium" }
```

`layer` names the enabled layer that matched, or is `null` when the coordinate is not on water in any enabled layer. Because coverage is configurable, `"water": false` means "not found in the layers this instance has enabled" rather than a guarantee of dry land.

Latitude must be between -90 and 90; longitude between -180 and 180.

### POST `/api/water`

Body: `{ "coordinates": [{ "lat", "lon" }, ...] }` (max `MAX_BATCH_SIZE`, default 500). A bare JSON array is also accepted.

```sh
curl -X POST http://localhost:3000/api/water \
  -H 'content-type: application/json' \
  -d '{"coordinates":[{"lat":20.112682,"lon":-37.048647},{"lat":40.292097,"lon":-98.613164}]}'
```

```json
{
  "results": [
    { "water": true, "lat": 20.112682, "lon": -37.048647, "layer": "oceans:medium" },
    { "water": false, "lat": 40.292097, "lon": -98.613164, "layer": null }
  ]
}
```

### GET `/api/layers`

Reports which layers this instance has enabled, so a client can interpret a `false` result.

```json
{
  "layers": [
    {
      "id": "oceans:medium",
      "feature": "oceans",
      "precision": "medium",
      "delivery": "bundled",
      "scope": "Oceans and seas; ~333 m shoreline detail",
      "license": "ODbL",
      "attribution": "© OpenStreetMap contributors"
    }
  ]
}
```

## Coverage layers

Coverage is addressed as `{feature}:{precision}` pairs. A **feature** is a kind of water; a **precision** controls how much geometric detail the artifact keeps and, for lakes, how small a water body has to be before it is dropped. Higher precision therefore means both finer shorelines *and* more water bodies — at the cost of a larger artifact.

| Feature  | Source                                                                                     | License   |
| -------- | ------------------------------------------------------------------------------------------ | --------- |
| `oceans` | [OSM coastline water polygons](https://osmdata.openstreetmap.de/data/water-polygons.html)   | ODbL      |
| `lakes`  | [HydroLAKES v1.0](https://www.hydrosheds.org/products/hydrolakes)                            | CC-BY 4.0 |
| `rivers` | OSM river/canal *area* geometries via [Geofabrik](https://download.geofabrik.de/) continent extracts | ODbL |
| `ponds`  | OSM ponds/small lakes/reservoirs (≤ 2 km²) via Geofabrik continent extracts                  | ODbL      |

| Precision | Simplify tolerance | Lakes min area | Ponds area window |
| --------- | ------------------ | -------------- | ----------------- |
| `low`     | 0.01° (~1.1 km)    | 10 km²         | 0.1–2 km²         |
| `medium`  | 0.003° (~330 m)    | 2 km²          | 0.01–2 km²        |
| `high`    | 0.0008° (~89 m)    | 0.5 km²        | 0.001–2 km²       |
| `full`    | none               | 0.1 km²        | ≤ 2 km²           |

`rivers` has no area filter — precision only changes shoreline simplification. Stream *centerlines* are out of scope at every precision; only mapped riverbank / river / canal polygons count.

Select layers with `WATER_LAYERS`:

```sh
WATER_LAYERS=oceans:medium,lakes:medium              # default
WATER_LAYERS=oceans,lakes,rivers,ponds               # max default-precision coverage
WATER_LAYERS=oceans:full,lakes:high,rivers:high,ponds:high
WATER_LAYERS=all                                     # every feature at its default precision
```

A bare feature name uses that feature's default precision, and a feature listed more than once collapses to the highest precision requested, so `oceans:low,oceans:full` resolves to `oceans:full`.

`oceans:medium` and `lakes:medium` ship in this repository. Global `rivers:medium` (~138 MB) and `ponds:medium` (~820 MB) are published as [GitHub Release assets](https://github.com/osbytes/is-on-water/releases/tag/data-v1) (`delivery: download`) and fetched once at boot into `WATER_LAYER_CACHE_DIR` (default `data/_layer-cache`), where they are verified against the checksum in the registry and reused across restarts. Higher-precision combinations use the same release channel.

To host artifacts yourself, or to add features this project does not ship, point `WATER_LAYERS_REGISTRY` at your own registry file modelled on [`data/layers.json`](./data/layers.json). Each artifact declares how it is delivered:

- `bundled` — read from the data directory
- `download` — fetched once at boot, checksum-verified, cached on disk
- `range` — never downloaded; queried in place over HTTP range requests, which keeps memory near zero at the cost of network latency per query

## Data

Each layer is a gzip-compressed FlatGeobuf file under [`data/layers/`](./data/layers), catalogued in [`data/layers.json`](./data/layers.json) with its source, license, checksum, and size.

Lookups query the FlatGeobuf packed Hilbert R-tree directly with a point-sized bounding box, so only the handful of polygons whose envelope contains the coordinate are ever parsed. Nothing is re-indexed in memory at startup.

Treat shoreline results as approximate: every bundled layer is Douglas–Peucker simplified, and river centerlines are out of scope at any precision.

Rebuild locally (requires Docker with a GEOS-enabled GDAL image, or `USE_HOST_OGR=1`):

```sh
pnpm dataset:build                              # oceans + lakes (bundled)
pnpm dataset:build:inland                       # rivers + ponds from Geofabrik PBFs
BUILD_LAYERS=oceans:full,lakes:high pnpm dataset:build
GEOFABRIK_REGIONS=europe,africa pnpm dataset:build:inland   # partial rebuild
```

`BUILD_LAYERS` chooses what to build and `BUNDLED_LAYERS` chooses which of those are committed rather than published as release assets. The inland builder caches Geofabrik continent PBFs under `data/_osm_inland/` (tens of GB) and merges them; set `GEOFABRIK_REGIONS` to limit which continents are included. Artifacts built by earlier runs are preserved in the registry, so building one precision does not drop the others.

### Nearest water

`GET /api/nearest?lat=&lon=` returns nearby water polygons from the enabled layers as a `nearest` array ordered by ascending distance, then descending area. Each hit is the **nearest shoreline point** on that body (not necessarily a coordinate that `/api/water` would mark `water: true`, since ring boundaries are outside the polygon fill).

| Param   | Default | Description |
| ------- | ------- | ----------- |
| `count` | `5`     | Max hits to return (1–25) |
| `type`  | all enabled | Comma-separated features: `oceans`, `lakes`, `rivers`, `ponds` |
| `maxKm` | `100`   | Search radius cap (0.1–500) |

A monthly GitHub Action checks the OSM zip’s `Last-Modified` / ETag, rebuilds `data/`, runs the dataset validation suite, and opens a PR when something changed.

© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL). HydroLAKES © HydroSHEDS / Messager et al. (CC-BY 4.0).

## Releasing

This repo uses [Changesets](https://github.com/changesets/changesets).

1. During development, record user-facing changes: `pnpm changeset`
2. On push to `main`, GitHub Actions opens (or updates) a **Version Packages** PR
3. Merging that PR bumps `package.json`, updates `CHANGELOG.md`, tags the release, and creates a GitHub Release

CI (typecheck, test, build) runs on every pull request and push to `main`.

## License

MIT — see [LICENSE](./LICENSE). Map data remains under OSM/ODbL as noted above.
