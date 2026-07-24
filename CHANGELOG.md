# is-on-water

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
