// Serverless endpoint: POST /api/ask  { question: string }
// Flow: route question -> official sources -> scrape (free Jina Reader) -> ground LLM answer -> return {answer, sources}
// $0 stack: Jina Reader (no key needed) + Cerebras free-tier Llama. Groq/OpenAI-compatible also supported via env.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config (all optional; sensible free-tier defaults) ---
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.cerebras.ai/v1";
// Cerebras retired llama-4-scout. gpt-oss-120b is current and is the model you already use most.
// Other valid Cerebras IDs: "qwen-3-235b-a22b-instruct", "llama3.1-8b". Override via LLM_MODEL env var.
const LLM_MODEL = process.env.LLM_MODEL || "gpt-oss-120b";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.CEREBRAS_API_KEY || "";
const JINA_API_KEY = process.env.JINA_API_KEY || ""; // optional: raises Jina rate limits
const MAX_SOURCES = 3;
const MAX_CHARS_PER_SOURCE = 6000;
const FETCH_TIMEOUT_MS = 8000;

function loadSources() {
  // sources.json is bundled via vercel.json includeFiles
  const raw = readFileSync(join(__dirname, "..", "data", "sources.json"), "utf-8");
  return JSON.parse(raw);
}

// Deterministic, $0 routing: region match -> topic match -> default. No LLM call needed to pick sources.
function pickSources(question, cfg) {
  const q = question.toLowerCase();
  const keys = new Set();
  for (const [region, list] of Object.entries(cfg.regionRouting)) {
    if (q.includes(region)) list.forEach((k) => keys.add(k));
  }
  for (const [topic, list] of Object.entries(cfg.topicRouting)) {
    if (q.includes(topic)) list.forEach((k) => keys.add(k));
  }
  if (keys.size === 0) cfg.defaultSources.forEach((k) => keys.add(k));
  return [...keys].slice(0, MAX_SOURCES).map((k) => ({ key: k, ...cfg.sources[k] })).filter((s) => s.url);
}

async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Free clean-markdown scrape via Jina Reader.
async function scrape(source) {
  const headers = { "X-Return-Format": "markdown" };
  if (JINA_API_KEY) headers["Authorization"] = `Bearer ${JINA_API_KEY}`;
  try {
    const r = await fetchWithTimeout(`https://r.jina.ai/${source.url}`, { headers });
    if (!r.ok) return null;
    const text = (await r.text()).slice(0, MAX_CHARS_PER_SOURCE);
    return { ...source, text };
  } catch {
    return null;
  }
}

async function askLLM(question, docs) {
  const context = docs
    .map((d, i) => `[Source ${i + 1}] ${d.name} (${d.url})\n${d.text}`)
    .join("\n\n---\n\n");

  const system =
    "You are an automotive regulatory research assistant. Answer ONLY using the provided official sources. " +
    "Cite sources inline as [Source N]. If the provided sources do not contain the answer, say so plainly and tell the user which official body to check — DO NOT invent regulations, numbers, dates, or standard codes. " +
    "Be concise, accurate, and structured. End with a one-line reminder that the user should verify with the official authority for compliance.";

  const user = `Question: ${question}\n\nOfficial sources:\n${context}`;

  const r = await fetchWithTimeout(
    `${LLM_BASE_URL}/chat/completions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.1,
        max_tokens: 1200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    },
    15000
  );

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`LLM error ${r.status}: ${detail.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.choices?.[0]?.message?.content?.trim() || "No answer generated.";
}

// Fire-and-forget analytics: append one row to a Google Sheet via an Apps Script webhook.
// No DB, no cost. Captures coarse geo from Vercel edge headers. No personal identity is collected.
function logEvent(req, payload) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  const row = {
    type: "query",
    app: "Auto Reg Advisor",
    ts: new Date().toISOString(),
    country: req.headers["x-vercel-ip-country"] || "",
    region: req.headers["x-vercel-ip-country-region"] || "",
    city: req.headers["x-vercel-ip-city"] || "",
    ua: (req.headers["user-agent"] || "").slice(0, 200),
    ...payload,
  };
  // don't block the response; swallow all errors
  fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(row),
  }, 3000).catch(() => {});
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }
  if (!LLM_API_KEY) {
    res.status(500).json({ error: "Server missing LLM_API_KEY (set CEREBRAS_API_KEY in environment)." });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const question = (body.question || "").toString().trim();
    if (!question) {
      res.status(400).json({ error: "Missing 'question'." });
      return;
    }

    const cfg = loadSources();
    const selected = pickSources(question, cfg);

    const scraped = (await Promise.all(selected.map(scrape))).filter(Boolean);
    if (scraped.length === 0) {
      res.status(200).json({
        answer:
          "I couldn't reach the official regulatory sources just now (they may be slow or blocking automated reads). Please try again in a moment, or rephrase with a country/topic so I can route to a specific authority.",
        sources: selected.map((s) => ({ name: s.name, url: s.url })),
      });
      return;
    }

    const answer = await askLLM(question, scraped);
    logEvent(req, {
      question,
      sources: scraped.map((s) => s.key).join("|"),
      status: "ok",
      answer_chars: answer.length,
    });
    res.status(200).json({
      answer,
      sources: scraped.map((s) => ({ name: s.name, url: s.url })),
    });
  } catch (err) {
    res.status(200).json({
      answer: `System error while researching: ${err.message}. Please try again.`,
      sources: [],
    });
  }
}
