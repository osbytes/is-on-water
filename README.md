# `is-on-water`

Check whether a geographic coordinate is on water (oceans, seas, and inland lakes/reservoirs ≥ ~2 km²). Exposed via an HTTP API for single coordinate (`GET /api/water?lat=${lat}&lon=${lon}`) and batch (`POST /api/water` with `{ "coordinates": [{ lat, lon }, ...] }`) lookups. Smaller ponds and most rivers are not covered.

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
{ "water": true, "lat": 20.112682, "lon": -37.048647 }
```

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
    { "water": true, "lat": 20.112682, "lon": -37.048647 },
    { "water": false, "lat": 40.292097, "lon": -98.613164 }
  ]
}
```

## Data

Water polygons are stored as gzip-compressed FlatGeobuf in [`data/waterbodies.fgb.gz`](./data/waterbodies.fgb.gz), merged from:

1. **Oceans & seas** — [OSM coastline water polygons](https://osmdata.openstreetmap.de/data/water-polygons.html) (ODbL)
2. **Inland lakes & reservoirs** — [HydroLAKES v1.0](https://www.hydrosheds.org/products/hydrolakes) lakes with surface area ≥ 2 km² (CC-BY 4.0; Messager et al. 2016)

Both layers are Douglas–Peucker simplified (`OSM_SIMPLIFY` / `LAKES_SIMPLIFY`, default `0.003` degrees) so the artifact stays under GitHub’s 100 MB limit. Treat shoreline results as approximate. Ponds under 2 km² and river centerlines are out of scope (override `LAKES_MIN_AREA_KM2=0.1` for full HydroLAKES ≥ 10 ha if you host the larger artifact outside git).

Rebuild locally (requires Docker with a GEOS-enabled GDAL image, or `USE_HOST_OGR=1`):

```sh
pnpm dataset:build
```

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
