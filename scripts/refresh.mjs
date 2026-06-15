// Daily Regulatory Watch refresh — run by GitHub Actions (free), no human involvement.
// For each official source in data/sources.json:
//   1. fetch the landing page via the free Jina Reader (https://r.jina.ai/<url>), optional JINA_API_KEY bearer, 30s timeout
//   2. SHA-256 hash + char length of the cleaned text
//   3. diff against the stored snapshot in data/snapshots/<KEY>.txt
// Writes public/data/changes.json that the Regulatory Watch tab reads.
// First run for any source = baseline (snapshot written, no false "change" recorded).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SNAP_DIR = join(ROOT, "data", "snapshots");
const OUT_DIR = join(ROOT, "public", "data");
const OUT_FILE = join(OUT_DIR, "changes.json");

mkdirSync(SNAP_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const cfg = JSON.parse(readFileSync(join(ROOT, "data", "sources.json"), "utf-8"));
const JINA_API_KEY = process.env.JINA_API_KEY || "";

// Human-friendly region labels for the changes feed.
const REGION_LABEL = {
  us: "North America", eu: "European Union", global: "Global",
  uk: "United Kingdom", japan: "Japan", india: "India", australia: "Australia",
};

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function scrape(url) {
  const headers = { "X-Return-Format": "markdown" };
  if (JINA_API_KEY) headers["Authorization"] = `Bearer ${JINA_API_KEY}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000); // 30s timeout
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, { headers, signal: ctrl.signal });
    if (!r.ok) return null;
    return (await r.text()).trim();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Load existing changes.json so we can prepend rather than wipe history.
let existingChanges = [];
if (existsSync(OUT_FILE)) {
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, "utf-8"));
    if (Array.isArray(prev.changes)) existingChanges = prev.changes;
  } catch { /* corrupt or empty — start fresh */ }
}

const now = new Date();
const lastRun = now.toISOString();
const today = lastRun.slice(0, 10);

const sourceRows = [];
const newChanges = [];
const entries = Object.entries(cfg.sources);

for (const [key, s] of entries) {
  const region = REGION_LABEL[s.region] || s.region || "Global";
  process.stdout.write(`Checking ${key} … `);

  const text = await scrape(s.url);
  const snapPath = join(SNAP_DIR, `${key}.txt`);

  if (text == null) {
    // couldn't reach it — keep prior snapshot, report error, no false change
    console.log("UNREACHABLE (kept previous snapshot)");
    sourceRows.push({
      key, name: s.name, region, url: s.url,
      lastChecked: lastRun, status: "error", delta: 0,
    });
    await sleep(1200);
    continue;
  }

  const hash = sha256(text);
  const len = text.length;

  if (!existsSync(snapPath)) {
    // FIRST RUN for this source — baseline only, never a false change
    writeFileSync(snapPath, text);
    console.log(`baseline (${len} chars)`);
    sourceRows.push({
      key, name: s.name, region, url: s.url,
      lastChecked: lastRun, status: "baseline", delta: 0,
    });
    await sleep(1200);
    continue;
  }

  const prevText = readFileSync(snapPath, "utf-8");
  const prevHash = sha256(prevText);
  const delta = len - prevText.length;

  if (hash !== prevHash) {
    // real change detected
    writeFileSync(snapPath, text);
    console.log(`CHANGED (Δ ${delta >= 0 ? "+" : ""}${delta} chars)`);
    sourceRows.push({
      key, name: s.name, region, url: s.url,
      lastChecked: lastRun, status: "changed", delta,
    });
    const sign = delta >= 0 ? "+" : "";
    newChanges.push({
      date: today,
      region,
      authority: s.name,
      url: s.url,
      note: `Page content changed (${sign}${delta} characters since the last check). Review the source for the update.`,
    });
  } else {
    console.log("unchanged");
    sourceRows.push({
      key, name: s.name, region, url: s.url,
      lastChecked: lastRun, status: "unchanged", delta: 0,
    });
  }
  await sleep(1200); // ~1.2s between fetches — be polite to the free endpoint
}

// Prepend new changes, cap the running log at 100 entries.
const changes = [...newChanges, ...existingChanges].slice(0, 100);

const out = {
  meta: { lastRun, sourcesMonitored: entries.length },
  sources: sourceRows,
  changes,
};

writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
console.log(`Done. ${newChanges.length} new change(s); ${changes.length} in log; ${entries.length} sources monitored.`);
