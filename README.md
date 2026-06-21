# sigpath-catalog

The community equipment catalog for **[sigpath](https://github.com/patricktr/sigpath)** —
a free, local-first AV signal-flow app. Each device is one small JSON file; CI compiles them
into a single snapshot the app syncs from a zero-egress CDN.

This is the **canonical source of truth** for the community library. There is no database —
git history *is* the catalog's versioning, audit log, and rollback. See the full design in
the app repo's `COMMUNITY.html`.

## Layout

```
devices/<manufacturer-slug>/<model-slug>.json   # one device per file; path = stable id
connectors/connectors.json                      # the controlled connector vocabulary
schema/device.schema.json                       # JSON Schema for a device source file
scripts/build-snapshot.mjs                       # devices/**.json → dist/ snapshot + manifest
LICENSE                                          # CC0 1.0 — all contributions are dedicated to the public domain
```

A device file is the **clean spec only** — `id`, `source`, `rev`, and `contentHash` are
*derived by the build*, never stored in the file. The file path is the id: a device at
`devices/apple/tv-4k.json` has id `apple/tv-4k`. Manufacturer-less generic gear lives under
`devices/generic/`.

```jsonc
// devices/apple/tv-4k.json
{
  "manufacturer": "Apple",
  "model": "TV 4K",
  "category": "source",          // coarse bucket — see schema/device.schema.json
  "type": "Media source",        // finer, user-facing type (optional)
  "ports": [
    { "name": "HDMI", "direction": "output", "connector": "hdmi" }
  ]
}
```

`connector` must be an id from `connectors/connectors.json`; the build cross-checks it.

## Contributing

Two paths, same result — a pull request that adds or edits a file under `devices/`:

1. **From the app (coming soon).** Build or correct a device in sigpath and hit *Submit to
   community*. A broker service opens the PR for you — no GitHub account needed.
2. **By hand.** Add or edit a `devices/<mfr>/<model>.json` file and open a PR. Run
   `npm run validate` first.

All submissions are released under **CC0 1.0** (public domain) — by contributing you affirm
the device data is your own / contains no proprietary content, and you waive copyright in it.
A maintainer reviews the diff and merges; merging republishes the snapshot.

## Build

```sh
npm run validate     # check every device against the schema + connector vocabulary
npm run build        # write dist/catalog-<rev>.json and dist/manifest.json
```

Zero dependencies — plain Node. The build validates, derives each id from its path, stamps
`source`/`rev`/`contentHash`, and emits the snapshot the app downloads.

> The published snapshot is JSON today. A gzipped-SQLite variant + row-level deltas slot in
> with the app's sync client (see `COMMUNITY.html` §3) — the manifest already has the shape.
