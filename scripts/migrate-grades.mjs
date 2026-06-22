#!/usr/bin/env node
// One-time migration: lift explicit bandwidth grades out of free-text port notes
// into the structured `port.grade` field on the source device specs. Mirrors the
// app's scripts/migrate-grades.mjs parser exactly — see design/SIGNAL-GRADE.html §7
// in the app repo.
//
// Principle: EXPLICIT grades only. We never guess a grade from the connector alone —
// a low default on an un-noted port would manufacture false "under-rated" errors in
// a high-grade show. Un-noted ports stay unrated and are never grade-checked.
//
// Usage:  node scripts/migrate-grades.mjs [--write]
//   without --write: dry run, prints the per-scale note→grade report only.
//
// After --write, run `npm run build` to regenerate dist/ with grades + new hashes.

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEVICES = join(ROOT, "devices");

// connector id → grade scale. Mirrors connectors.json gradeScale (and the app).
const SCALE = {
  sdi: "sdi", bnc: "sdi",
  hdmi: "hdmi", "mini-hdmi": "hdmi", "micro-hdmi": "hdmi",
  dp: "displayport", "mini-dp": "displayport",
  "usb-c": "usb", "usb-a": "usb", "usb-b": "usb", "usb-micro": "usb", thunderbolt: "usb",
  rj45: "ethernet", ethercon: "ethernet",
};

const RANK = {
  "sdi-sd": 0, "sdi-hd": 1, "sdi-3g": 2, "sdi-6g": 3, "sdi-12g": 4, "sdi-24g": 5,
  "hdmi-1.4": 0, "hdmi-2.0": 1, "hdmi-2.1": 2,
  "dp-1.2": 0, "dp-1.4": 1, "dp-2.0": 2,
  "usb-2.0": 0, "usb-5g": 1, "usb-10g": 2, "usb-20g": 3, "usb-40g": 4, "usb-80g": 5,
  "eth-100m": 0, "eth-1g": 1, "eth-2.5g": 2, "eth-5g": 3, "eth-10g": 4, "eth-25g": 5,
};

const TOKENS = {
  sdi: [
    [/\b24G\b/i, "sdi-24g"],
    [/\b12G\b|2082/i, "sdi-12g"],
    [/\b6G\b|2081/i, "sdi-6g"],
    [/\b3G\b|424M|425M/i, "sdi-3g"],
    [/HD-?SDI|\b1\.5G\b|\b292M?\b/i, "sdi-hd"],
    [/SD-?SDI|259M|270\s?Mb/i, "sdi-sd"],
  ],
  hdmi: [
    [/\b2\.1\b/i, "hdmi-2.1"],
    [/\b2\.0\b/i, "hdmi-2.0"],
    [/\b1\.[34]\b|1\.4b/i, "hdmi-1.4"],
  ],
  displayport: [
    [/\b2\.0\b|UHBR/i, "dp-2.0"],
    [/\b1\.4\b|HBR3/i, "dp-1.4"],
    [/\b1\.2\b|1\.2a|HBR2/i, "dp-1.2"],
  ],
  usb: [
    [/USB\s?4|Thunderbolt|\bTB[34]\b|\b40\s?Gb/i, "usb-40g"],
    [/Gen\s?2x2|\b20\s?Gb/i, "usb-20g"],
    [/3\.[12]\s?Gen\s?2\b|\b10\s?Gb/i, "usb-10g"],
    [/USB\s?3(\.[012])?\b|\b3\.[012]\b|Gen\s?1\b|SuperSpeed|\b5\s?Gb/i, "usb-5g"],
    [/USB\s?2(\.0)?\b|Hi-?Speed|\b480\s?Mb/i, "usb-2.0"],
  ],
  ethernet: [
    [/\b25G\b|25\s?Gb/i, "eth-25g"],
    [/\b10G\b|10\s?Gb|10GBASE/i, "eth-10g"],
    [/\b5G\b|\b5\s?Gb/i, "eth-5g"],
    [/2\.5G|2\.5\s?Gb/i, "eth-2.5g"],
    [/1000\s?(BASE|Base|Mbps|Mb)|\b1\s?Gb|Gigabit|802\.3ab/i, "eth-1g"],
    [/\b100\s?(BASE|Base|Mbps|Mb)|802\.3u/i, "eth-100m"],
  ],
};

function parseGrade(scale, rawNote) {
  if (!rawNote) return null;
  const note = rawNote.replace(/HDCP\s*[\d.]+(\s*\/\s*[\d.]+)?/gi, " ");
  let best = null;
  let bestRank = -1;
  for (const [re, gid] of TOKENS[scale]) {
    if (re.test(note) && RANK[gid] > bestRank) {
      best = gid;
      bestRank = RANK[gid];
    }
  }
  return best;
}

const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const f = join(d, n);
    return statSync(f).isDirectory() ? walk(f) : f.endsWith(".json") ? [f] : [];
  });

const write = process.argv.includes("--write");
const seen = {};
let graded = 0;
let filesChanged = 0;

for (const file of walk(DEVICES).sort()) {
  const spec = JSON.parse(readFileSync(file, "utf8"));
  let changed = false;
  for (const p of spec.ports ?? []) {
    const scale = SCALE[p.connector];
    if (!scale) continue;
    const grade = parseGrade(scale, p.note);
    if (grade && p.grade !== grade) {
      p.grade = grade;
      graded++;
      changed = true;
      (seen[scale] ??= new Map());
      const k = (p.note || "").trim();
      const cur = seen[scale].get(k);
      if (cur) cur.n++;
      else seen[scale].set(k, { grade, n: 1 });
    }
  }
  if (changed) {
    filesChanged++;
    if (write) writeFileSync(file, JSON.stringify(spec, null, 2) + "\n");
  }
}

for (const scale of Object.keys(seen)) {
  const rows = [...seen[scale].entries()].sort((a, b) => b[1].n - a[1].n);
  const total = rows.reduce((s, [, v]) => s + v.n, 0);
  console.log(`\n=== ${scale} === (${total} ports)`);
  for (const [note, { grade, n }] of rows) {
    console.log(`  ${String(n).padStart(3)}  ${grade.padEnd(9)} ← ${note}`);
  }
}
console.log(`\nTotal ports graded: ${graded} across ${filesChanged} files.`);
console.log(write ? "Wrote device files. Run `npm run build` next." : "(dry run — re-run with --write)");
