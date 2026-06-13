// Nightly self-refresh. Run by GitHub Actions (free) — no human involvement.
// Scrapes each official source landing page via free Jina Reader and writes a snapshot to data/cache/.
// The snapshot gives the app a fast, current fallback and is the basis for the (App D) change-monitor.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CACHE = join(ROOT, "data", "cache");
mkdirSync(CACHE, { recursive: true });

const cfg = JSON.parse(readFileSync(join(ROOT, "data", "sources.json"), "utf-8"));
const JINA_API_KEY = process.env.JINA_API_KEY || "";

async function scrape(url) {
  const headers = { "X-Return-Format": "markdown" };
  if (JINA_API_KEY) headers["Authorization"] = `Bearer ${JINA_API_KEY}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, { headers, signal: ctrl.signal });
    if (!r.ok) return null;
    return (await r.text()).slice(0, 20000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const index = { refreshedAt: new Date().toISOString(), sources: {} };

for (const [key, s] of Object.entries(cfg.sources)) {
  process.stdout.write(`Refreshing ${key} … `);
  const text = await scrape(s.url);
  if (text) {
    writeFileSync(join(CACHE, `${key}.md`), `# ${s.name}\n# ${s.url}\n# fetched ${index.refreshedAt}\n\n${text}`);
    index.sources[key] = { name: s.name, url: s.url, chars: text.length, ok: true };
    console.log(`ok (${text.length} chars)`);
  } else {
    index.sources[key] = { name: s.name, url: s.url, ok: false };
    console.log("FAILED (kept previous snapshot if any)");
  }
  await new Promise((r) => setTimeout(r, 1500)); // be polite to the free endpoint
}

writeFileSync(join(CACHE, "index.json"), JSON.stringify(index, null, 2));
console.log("Done.");
