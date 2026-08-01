---
"is-on-water": minor
---

Add `GET /api/nearest` to return nearby water bodies as a distance-then-size ranked array. Callers can limit results with `count`, filter by feature `type` (e.g. `lakes` or `oceans,lakes`), and bound the search with `maxKm`.
