#!/usr/bin/env node
/**
 * Build the published catalog snapshot + manifest from devices/**.json.
 *
 * Zero dependencies — plain Node. For each device file it: validates the spec,
 * derives the id from the file path, cross-checks connectors against the
 * vocabulary, generates stable port ids, and stamps source/rev/contentHash. It
 * then writes dist/catalog-<rev>.json and dist/manifest.json.
 *
 *   node scripts/build-snapshot.mjs            # validate + write dist/
 *   node scripts/build-snapshot.mjs --check    # validate only, write nothing
 *
 * IMPORTANT: contentHash() below must stay byte-for-byte compatible with
 * deviceContentHash() in the app (src/schema/device.ts) — same canonical shape,
 * same FNV-1a — or the app can't verify or dedup synced rows. Keep them in sync.
 */
import {
  readdirSync, readFileSync, writeFileSync, mkdirSync, statSync,
} from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEVICES_DIR = join(ROOT, "devices");
const DIST_DIR = join(ROOT, "dist");
const CHECK_ONLY = process.argv.includes("--check");

// Monotonic catalog revision. CI passes CATALOG_REV (the count of commits that
// touched devices/connectors, so it advances only on real content changes); local
// builds default to 1, matching the bundled snapshot the app ships with.
const REV = Number(process.env.CATALOG_REV) || 1;
const MIN_APP_VERSION = "0.4.0";

const CATEGORIES = new Set([
  "source", "display", "switcher", "matrix", "amplifier", "audio",
  "recorder", "converter", "network", "control", "power", "other",
]);
const TYPES = new Set([
  "Media source", "Camera", "Computer", "Video switcher", "Matrix router",
  "Converter", "Scaler", "Extender", "AV receiver", "Audio mixer", "Amplifier",
  "Speaker", "Display", "Projector", "Network switch", "Control processor",
  "Recorder", "Audio interface", "Power conditioner", "Wireless mic", "Microphone",
  "DSP", "PDU", "Touch panel", "Media player", "Encoder/Decoder", "Other",
]);
const DIRECTIONS = new Set(["input", "output", "bidirectional"]);

const vocab = JSON.parse(readFileSync(join(ROOT, "connectors", "connectors.json"), "utf8"));
const CONNECTOR_IDS = new Set(vocab.connectors.map((c) => c.id));

/** Lowercase, alphanumerics → single hyphens, trimmed. */
function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Stable hash of the identity-bearing spec. Mirror of the app's deviceContentHash(). */
function contentHash(spec) {
  const canonical = JSON.stringify({
    manufacturer: spec.manufacturer ?? "",
    model: spec.model,
    category: spec.category,
    type: spec.type ?? "",
    rackUnits: spec.rackUnits ?? null,
    ports: spec.ports.map((p) => [p.direction, p.connector, p.name, p.note ?? ""]),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** All *.json under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".json")) out.push(full);
  }
  return out;
}

const errors = [];
const seenIds = new Set();
const compiled = [];

for (const file of walk(DEVICES_DIR).sort()) {
  const rel = relative(DEVICES_DIR, file).split("\\").join("/");
  const id = rel.replace(/\.json$/, "");
  const at = `devices/${rel}`;

  let spec;
  try {
    spec = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    errors.push(`${at}: invalid JSON — ${e.message}`);
    continue;
  }

  if (typeof spec.model !== "string" || !spec.model.trim()) errors.push(`${at}: missing "model"`);
  if (!CATEGORIES.has(spec.category)) errors.push(`${at}: invalid category ${JSON.stringify(spec.category)}`);
  if (spec.type != null && !TYPES.has(spec.type)) errors.push(`${at}: invalid type ${JSON.stringify(spec.type)}`);
  if (spec.rackUnits != null && !(Number.isInteger(spec.rackUnits) && spec.rackUnits >= 1)) {
    errors.push(`${at}: rackUnits must be a positive integer`);
  }
  if (!Array.isArray(spec.ports) || spec.ports.length === 0) {
    errors.push(`${at}: needs at least one port`);
  }

  // The path must equal the manufacturer/model slug — that's the dedup key.
  if (spec.model) {
    const expected = `${slugify(spec.manufacturer ?? "generic")}/${slugify(spec.model)}`;
    if (id !== expected) errors.push(`${at}: rename to devices/${expected}.json (path = manufacturer/model slug)`);
  }
  if (seenIds.has(id)) errors.push(`${at}: duplicate id "${id}"`);
  seenIds.add(id);

  // Validate + assign stable, unique port ids (the app needs them; the source omits them).
  const portIds = new Set();
  const ports = (Array.isArray(spec.ports) ? spec.ports : []).map((p, i) => {
    if (!p || typeof p.name !== "string" || !p.name.trim()) errors.push(`${at}: port ${i} missing "name"`);
    if (!DIRECTIONS.has(p?.direction)) errors.push(`${at}: port ${i} invalid direction ${JSON.stringify(p?.direction)}`);
    if (!CONNECTOR_IDS.has(p?.connector)) errors.push(`${at}: port ${i} unknown connector ${JSON.stringify(p?.connector)}`);
    if (p?.accepts != null && !Array.isArray(p.accepts)) errors.push(`${at}: port ${i} "accepts" must be an array`);
    if (Array.isArray(p?.accepts)) {
      for (const a of p.accepts) {
        if (!CONNECTOR_IDS.has(a)) errors.push(`${at}: port ${i} unknown connector in accepts ${JSON.stringify(a)}`);
      }
    }
    let pid = slugify(p?.name) || `port-${i + 1}`;
    while (portIds.has(pid)) pid = `${pid}-${i + 1}`;
    portIds.add(pid);
    const port = { id: pid, name: p?.name, direction: p?.direction, connector: p?.connector };
    if (Array.isArray(p?.accepts) && p.accepts.length) port.accepts = p.accepts;
    if (p?.note) port.note = p.note;
    return port;
  });

  compiled.push({
    id,
    ...(spec.manufacturer ? { manufacturer: spec.manufacturer } : {}),
    model: spec.model,
    category: spec.category,
    ...(spec.type ? { type: spec.type } : {}),
    ports,
    ...(spec.rackUnits != null ? { rackUnits: spec.rackUnits } : {}),
    ...(spec.imageUrl ? { imageUrl: spec.imageUrl } : {}),
    ...(spec.sourceUrl ? { sourceUrl: spec.sourceUrl } : {}),
    source: "community",
    rev: REV,
    contentHash: contentHash(spec),
  });
}

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s) in the catalog:\n` + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}
compiled.sort((a, b) => a.id.localeCompare(b.id));
console.log(`✓ ${compiled.length} device(s) valid.`);

if (CHECK_ONLY) {
  console.log("check-only — no files written.");
  process.exit(0);
}

mkdirSync(DIST_DIR, { recursive: true });
const snapshotName = `catalog-${REV}.json`;
const snapshotJson = JSON.stringify(compiled, null, 2) + "\n";
writeFileSync(join(DIST_DIR, snapshotName), snapshotJson);

const manifest = {
  rev: REV,
  minAppVersion: MIN_APP_VERSION,
  generatedAt: new Date().toISOString(),
  full: {
    url: snapshotName,
    sha256: createHash("sha256").update(snapshotJson).digest("hex"),
    bytes: Buffer.byteLength(snapshotJson),
  },
  deltas: [],
};
writeFileSync(join(DIST_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`✓ wrote dist/${snapshotName} and dist/manifest.json (rev ${REV}, ${manifest.full.bytes} bytes).`);
