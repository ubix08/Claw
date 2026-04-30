// src/tools/web-search.ts — web_search AgentTool (Serper.dev)
//
// [TOOLS-FIX-CRITICAL] parameters converted from plain JSON schema to
// TypeBox TSchema. Plain objects cause AJV validation to throw internally
// in pi-agent-core's agent loop, silently failing every tool call.
import { logger } from "../core/logger.js";
import { Type }   from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";

export interface WebSearchOptions {
  maxResults?: number;
  apiKey?:     string;
  language?:   string;
  country?:    string;
}

interface SearchResult {
  index:       number;
  title:       string;
  url:         string;
  snippet:     string;
  displayUrl?: string;
  date?:       string;
  sitelinks?:  Array<{ title: string; url: string }>;
}

interface SearchResponse {
  results:         SearchResult[];
  totalResults:    string;
  searchTime:      number;
  queryRewrite?:   string;
  answerBox?:      string;
  knowledgeGraph?: string;
}

type SerperSearchType = "search" | "news" | "images" | "shopping";

interface SerperParams {
  query: string; n: number; apiKey: string;
  language?: string; country?: string; dateRestrict?: string;
  safe?: string; sort?: string; type: SerperSearchType;
}

// ── TypeBox schema (replaces plain JSON schema) ────────────────────────────────

const webSearchSchema = Type.Object({
  query:        Type.String({ description: "Search query (3–8 words is best)." }),
  num:          Type.Optional(Type.Number({ description: "Results to return (1–10)." })),
  dateRestrict: Type.Optional(Type.Union([
    Type.Literal("d1"), Type.Literal("d3"), Type.Literal("d7"),
    Type.Literal("m1"), Type.Literal("m3"), Type.Literal("m6"),
    Type.Literal("y1"),
  ], { description: "Recency filter." })),
  siteSearch:   Type.Optional(Type.String({ description: "Restrict to domain e.g. github.com" })),
  gl:           Type.Optional(Type.String({ description: "Country code e.g. us" })),
  hl:           Type.Optional(Type.String({ description: "Language code e.g. en" })),
  safe:         Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("active")])),
  sort:         Type.Optional(Type.Union([Type.Literal("relevance"), Type.Literal("date")])),
  type:         Type.Optional(Type.Union([
    Type.Literal("search"), Type.Literal("news"),
    Type.Literal("images"), Type.Literal("shopping"),
  ])),
});

// ── Tool factory ───────────────────────────────────────────────────────────────

export function createWebSearchTool(opts: WebSearchOptions = {}): AgentTool {
  const defaultMaxResults = Math.min(opts.maxResults ?? 10, 10);
  return {
    name: "web_search", label: "Web Search",
    description:
      `Search the web using Serper and return ranked results.\n\n` +
      `Use when you need current facts, recent news, competitor research, or to find a URL to fetch.\n` +
      `Setup: set SERPER_API_KEY in ~/.clawd/.env  (free key at https://serper.dev)`,
    parameters: webSearchSchema,
    execute: async (_id, params: { query: string; num?: number; dateRestrict?: string; siteSearch?: string; gl?: string; hl?: string; safe?: string; sort?: string; type?: string }) => {
      const query = params.query?.trim();
      if (!query) return _toolResult("Error: query cannot be empty.");
      const n      = Math.min(Math.max(params.num ?? defaultMaxResults, 1), 10);
      const apiKey = opts.apiKey ?? process.env.SERPER_API_KEY;
      if (!apiKey) return _toolResult(`Error: SERPER_API_KEY not set. Add to ~/.clawd/.env  (free at https://serper.dev)`);

      const effectiveQuery = params.siteSearch
        ? `site:${params.siteSearch.replace(/^https?:\/\//, "").split("/")[0]} ${query}` : query;
      const searchType = (params.type ?? "search") as SerperSearchType;

      logger.info(`[web_search] "${effectiveQuery}" (n=${n}${params.dateRestrict ? ` date=${params.dateRestrict}` : ""})`);

      try {
        const response = await _searchWithRetry({ query: effectiveQuery, n, apiKey, language: params.hl ?? opts.language ?? "en", country: params.gl ?? opts.country ?? "us", dateRestrict: params.dateRestrict, safe: params.safe, sort: params.sort, type: searchType });
        if (!response.results.length && !response.answerBox && !response.knowledgeGraph) {
          return _toolResult(`No results found for: "${query}"`);
        }
        const parts: string[] = [];
        const header = [`Search results for: "${query}"`, `${response.results.length} results`, response.queryRewrite ? `Query interpreted as: "${response.queryRewrite}"` : ""].filter(Boolean).join("  ·  ");
        parts.push(header);
        if (response.answerBox)    parts.push(`\n[Answer Box]\n${response.answerBox}`);
        if (response.knowledgeGraph) parts.push(`\n[Knowledge Graph]\n${response.knowledgeGraph}`);
        if (response.results.length) {
          parts.push("");
          parts.push(response.results.map(r => {
            const lines: string[] = [`[${r.index}] ${r.title}`];
            lines.push(r.displayUrl ?? r.url);
            if (r.date)    lines.push(`Published: ${r.date}`);
            if (r.snippet) lines.push(r.snippet.replace(/\s+/g, " ").trim());
            if (r.sitelinks?.length) lines.push(`  Related: ${r.sitelinks.map(s => s.title).join(" · ")}`);
            return lines.join("\n");
          }).join("\n\n"));
        }
        return _toolResult(parts.join("\n"));
      } catch (e: any) { logger.warn(`[web_search] Error: ${e.message}`); return _toolResult(`Error: ${e.message}`); }
    },
  };
}

async function _searchWithRetry(p: SerperParams): Promise<SearchResponse> {
  const MAX_RETRIES = 3; const BASE_DELAY = 600;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) { await _sleep(BASE_DELAY * Math.pow(2, attempt - 1) + Math.random() * 200); }
    try { return await _serperSearch(p); } catch (e: any) { lastErr = e; if (!_isRetryable(e.message)) throw e; }
  }
  throw lastErr!;
}

function _isRetryable(msg: string): boolean {
  return /429|500|502|503|rate.?limit|quota|timeout|ECONNRESET|ETIMEDOUT/i.test(msg);
}

const DATE_RESTRICT_MAP: Record<string, string> = { d1:"qdr:d", d3:"qdr:d3", d7:"qdr:w", m1:"qdr:m", m3:"qdr:m3", m6:"qdr:m6", y1:"qdr:y" };
const SERPER_ENDPOINT: Record<SerperSearchType, string> = {
  search: "https://google.serper.dev/search", news: "https://google.serper.dev/news",
  images: "https://google.serper.dev/images", shopping: "https://google.serper.dev/shopping",
};

async function _serperSearch(p: SerperParams): Promise<SearchResponse> {
  const endpoint = SERPER_ENDPOINT[p.type]; const t0 = Date.now();
  const body: Record<string, unknown> = { q: p.query, num: p.n, gl: p.country ?? "us", hl: p.language ?? "en" };
  if (p.dateRestrict && DATE_RESTRICT_MAP[p.dateRestrict]) body.tbs = DATE_RESTRICT_MAP[p.dateRestrict];
  if (p.sort === "date" && p.type === "search") body.tbs = body.tbs ? `${body.tbs},sbd:1` : "sbd:1";
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
  let resp: Response;
  try {
    resp = await fetch(endpoint, { method: "POST", signal: controller.signal, headers: { "X-API-KEY": p.apiKey, "Content-Type": "application/json", "User-Agent": "clawd/1.0" }, body: JSON.stringify(body) });
  } finally { clearTimeout(timer); }
  const text = await resp.text();
  if (!resp.ok) {
    let errMsg = `Serper API ${resp.status} ${resp.statusText}`;
    try { const b = JSON.parse(text); if (b?.message) errMsg += `: ${b.message}`; } catch { errMsg += `: ${text.slice(0, 200)}`; }
    throw new Error(errMsg);
  }
  const data = JSON.parse(text) as any;
  let answerBox: string | undefined;
  if (data.answerBox) { const ab = data.answerBox; answerBox = [ab.title, ab.answer, ab.snippet].filter(Boolean).join("\n") || undefined; }
  let knowledgeGraph: string | undefined;
  if (data.knowledgeGraph) { const kg = data.knowledgeGraph; knowledgeGraph = [kg.title, kg.type ? `Type: ${kg.type}` : "", kg.description ?? "", kg.website ? `Website: ${kg.website}` : ""].filter(Boolean).join("\n") || undefined; }
  const queryRewrite: string | undefined = data.searchParameters?.q && data.searchParameters.q !== p.query ? data.searchParameters.q : undefined;
  let results: SearchResult[] = [];
  if (p.type === "search" && Array.isArray(data.organic)) {
    results = data.organic.slice(0, p.n).map((item: any, i: number) => ({ index: i+1, title: _cleanText(item.title ?? "(no title)"), url: item.link ?? "", displayUrl: _extractDomain(item.link), snippet: _cleanText(item.snippet ?? ""), date: item.date ? _normaliseDate(item.date) : undefined, sitelinks: Array.isArray(item.sitelinks) ? item.sitelinks.slice(0,4).map((s: any) => ({ title: s.title, url: s.link })) : undefined }));
  }
  if (p.type === "news" && Array.isArray(data.news)) {
    results = data.news.slice(0, p.n).map((item: any, i: number) => ({ index: i+1, title: _cleanText(item.title ?? "(no title)"), url: item.link ?? "", displayUrl: item.source ?? _extractDomain(item.link), snippet: _cleanText(item.snippet ?? ""), date: item.date ? _normaliseDate(item.date) : undefined }));
  }
  return { results, totalResults: String(results.length), searchTime: Date.now() - t0, queryRewrite, answerBox, knowledgeGraph };
}

function _extractDomain(url: string): string { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function _normaliseDate(raw: string): string { const d = new Date(raw); return (!isNaN(d.getTime()) && d.getFullYear() > 2000) ? d.toISOString().slice(0,10) : raw; }
function _cleanText(s: string): string { return s.replace(/\s+/g," ").replace(/\u00a0/g," ").replace(/[\u2018\u2019]/g,"'").replace(/[\u201c\u201d]/g,'"').trim(); }
function _sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function _toolResult(text: string) { return { content: [{ type: "text" as const, text }], details: {} }; }
