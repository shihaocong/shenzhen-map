# Route data pipeline

`build-route-data.mjs` uses only Node.js standard-library modules and the system
`unzip` command. It reads the route workbook, normalizes the stop list, geocodes
stops with Nominatim, and requests driving geometry from public OSRM.

```bash
node scripts/build-route-data.mjs --workbook "/path/to/routes.xlsx"
```

Useful flags:

- `--parse-only`: parse the workbook and merge any existing cache; no network.
- `--skip-routing`: geocode stops without requesting OSRM geometry.
- `--refresh`: refresh already resolved geocodes and cached OSRM routes.
- `--refresh-routing`: refresh OSRM geometry without refreshing geocodes.
- `--existing-data`: rebuild from the existing `data/routes.json` when the source workbook is unavailable.

The public Nominatim requests are serialized at no more than one request per
1.1 seconds. Results are written incrementally to `data/geocode-cache.json`.
OSRM results are stored in `data/osrm-cache.json`.

User-verified coordinates live in `data/manual-geocodes.json`. The pipeline
converts GCJ-02 entries to WGS84, records their source coordinates in the cache,
and protects current manual entries from geocoder refreshes.

## `data/routes.json`

The static frontend consumes this file. Top-level `stops` are the deduplicated
station registry. Route directions also contain their ordered stop instances so
the frontend can render without a join.

Each stop keeps `rawName`, `normalizedName`, WGS84 `lat`/`lng`, `confidence`,
`status`, and the provider's `displayName`. Coordinates are present only when a
candidate passed the name and region score; otherwise the status is
`ambiguous` or `unresolved` and coordinates remain `null`.

Each direction includes a GeoJSON `LineString` plus `geometryStatus`:

- `complete-routed`: every stop resolved and OSRM returned a route.
- `partial-routed`: OSRM routed the resolved waypoints, but stops are missing.
- `complete-fallback`: every stop resolved; direct station polyline used.
- `partial-fallback`: stops are missing and direct station polyline used.
- `unavailable`: fewer than two resolved waypoints.

`missingStopSequences` makes partial geometry explicit. A partial geometry must
not be presented as an accurate path through unresolved stops.
