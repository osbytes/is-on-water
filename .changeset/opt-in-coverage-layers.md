---
"is-on-water": minor
---

Make coverage opt-in through `{feature}:{precision}` layers selected with `WATER_LAYERS`, and query the FlatGeobuf spatial index directly instead of rebuilding an RBush at startup (~1.05 GB resident to ~430 MB). Water responses now report the matching layer, and `GET /api/layers` reports which layers an instance has enabled. Adds opt-in `rivers` and `ponds` layers built from Geofabrik OSM continent extracts (river/canal area polygons and small inland water ≤ 2 km²).
