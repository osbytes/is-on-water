# is-on-water

## 1.4.1

### Patch Changes

- bb13faa: Upgrade `@fastify/swagger-ui` and pin patched `find-my-way`, `@fastify/static`, and `brace-expansion` to clear Dependabot advisories.

## 1.4.0

### Minor Changes

- f9b8655: Add `GET /api/nearest` to return nearby water bodies as a distance-then-size ranked array. Callers can limit results with `count`, filter by feature `type` (e.g. `lakes` or `oceans,lakes`), and bound the search with `maxKm`.
- 5b1f0c3: Make coverage opt-in through `{feature}:{precision}` layers selected with `WATER_LAYERS`, and query the FlatGeobuf spatial index directly instead of rebuilding an RBush at startup (~1.05 GB resident to ~430 MB). Water responses now report the matching layer, and `GET /api/layers` reports which layers an instance has enabled. Adds opt-in global `rivers` and `ponds` layers built from Geofabrik OSM continent extracts (river/canal area polygons and small inland water ≤ 2 km²), published as `data-v1` release assets.
- 1fbe1e7: Replace geo-maps with OSM oceans/seas plus HydroLAKES inland lakes (≥2 km²).

## 1.3.0

### Minor Changes

- 492a891: Rename the API to `/api/water`, wrap batch payloads, and return RFC 9457 problem details.

## 1.2.0

### Minor Changes

- 712ac1b: Redesign the landing page for osbytes branding, serve waterbodies from FlatGeobuf, and clarify request log field names.

## 1.1.1

### Patch Changes

- 761cc4d: Upgrade `@fastify/static` to 9.3.0 to fix Dependabot advisories for path traversal and encoded path separator bypass.

## 1.1.0

### Minor Changes

- 73e04cf: Migrate to the Fastify template base with opt-in Redis rate limiting, zod validation, Swagger docs, and CI/Changesets.

  Also switch to a single waterbodies GeoJSON lookup, fix coordinate bounds, add MIT license plus OSM attribution, and improve the demo map (coordinate form, live API link, clearer copy).
