// src/tools/web-fetch.ts — web_fetch AgentTool
//
// [TOOLS-FIX-CRITICAL] parameters converted from plain JSON schema to
// TypeBox TSchema. Plain objects cause AJV validation to throw internally
// in pi-agent-core's agent loop, silently failing every tool call.
import { logger } from "../core/logger.js";
import { Type }   from "@mariozechner/pi-ai";
import type { AgentTool } from "../agent/types.js";

export interface WebFetchOptions { maxChars?: number; timeoutMs?: number; extraHeaders?: Record<string, string>; }

// ── TypeBox schema (replaces plain JSON schema) ────────────────────────────────

const webFetchSchema = Type.Object({
  url:          Type.String({ description: "Full URL to fetch, including https://" }),
  selector:     Type.Optional(Type.String({ description: "CSS selector to extract a specific section." })),
  includeLinks: Type.Optional(Type.Boolean({ description: "Include hyperlinks as [text](url). Default false." })),
});

// ── Tool factory ───────────────────────────────────────────────────────────────

export function createWebFetchTool(opts: WebFetchOptions = {}): AgentTool {
  const maxChars  = opts.maxChars  ?? parseInt(process.env.FETCH_MAX_CHARS  ?? "20000", 10);
  const timeoutMs = opts.timeoutMs ?? parseInt(process.env.FETCH_TIMEOUT_MS ?? "20000", 10);
  return {
    name: "web_fetch", label: "Web Fetch",
    description:
      `Fetch the full content of a URL and return it as clean, readable Markdown.\n\n` +
      `Best used AFTER web_search to read the complete content of a specific page.\n` +
      `Returns page metadata (title, author, date) followed by up to ${maxChars.toLocaleString()} characters of content.\n` +
      `Limitations: cannot access login-required pages; JS-heavy SPAs may return sparse content.\n` +
      `Use the optional 'selector' param to focus on a specific section: "article", "main", "#id", ".class"`,
    parameters: webFetchSchema,
    execute: async (_id, params: { url: string; selector?: string; includeLinks?: boolean }) => {
      const url = params.url?.trim();
      if (!url) return _toolResult("Error: url is required.");
      if (!url.startsWith("http://") && !url.startsWith("https://")) return _toolResult(`Error: URL must start with http:// or https://. Got: "${url}"`);
      logger.info(`[web_fetch] ${url}`);
      try {
        const result = await _fetchWithRetry(url, { timeoutMs, maxChars, selector: params.selector, includeLinks: params.includeLinks ?? false, extraHeaders: opts.extraHeaders ?? {} });
        logger.debug(`[web_fetch] ${result.length} chars from ${url}`);
        return _toolResult(result);
      } catch (e: any) { logger.warn(`[web_fetch] ${e.message}`); return _toolResult(`Error fetching ${url}: ${e.message}`); }
    },
  };
}

// ── Fetch internals (unchanged from original) ──────────────────────────────────

interface FetchParams { timeoutMs: number; maxChars: number; selector?: string; includeLinks: boolean; extraHeaders: Record<string,string>; }

async function _fetchWithRetry(url: string, p: FetchParams, retries = 2): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i <= retries; i++) {
    try { return await _fetchOnce(url, p); }
    catch (e: any) {
      lastErr = e;
      if (i < retries && /429|500|502|503|ECONNRESET|ETIMEDOUT/i.test(e.message)) {
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
      } else { break; }
    }
  }
  throw lastErr!;
}

async function _fetchOnce(url: string, p: FetchParams): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; clawd/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        ...p.extraHeaders,
      },
    });
  } finally { clearTimeout(timer); }
  if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (_isBinaryContentType(ct)) return `Binary content (${ct}) — not readable as text. URL: ${url}`;
  const body = await resp.text();
  if (ct.includes("application/json")) {
    try { return _truncateAt(JSON.stringify(JSON.parse(body), null, 2), p.maxChars); } catch { return _truncateAt(body, p.maxChars); }
  }
  if (ct.includes("application/rss") || ct.includes("application/atom") || body.trim().startsWith("<?xml")) {
    return _truncateAt(_parseFeed(body, url), p.maxChars);
  }
  if (!ct.includes("html")) return _truncateAt(body, p.maxChars);
  return _truncateAt(_extractHtml(body, url, p), p.maxChars);
}

function _extractHtml(html: string, url: string, p: FetchParams): string {
  let cleaned = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, "");

  const title     = cleaned.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  const descMatch = cleaned.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ?? cleaned.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  const description = descMatch?.[1]?.trim() ?? "";
  const canonical   = cleaned.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? url;
  const ogTitle   = cleaned.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "";
  const author    = cleaned.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? cleaned.match(/<meta[^>]+property=["']article:author["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "";
  const pubDate   = cleaned.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "";

  let content = cleaned;
  if (p.selector) {
    const selMatch = _extractBySelector(cleaned, p.selector);
    if (selMatch) content = selMatch;
  } else {
    const candidates = ["article", "main", '[role="main"]', ".post-content", ".entry-content", ".article-body", ".article-content", ".story-body", "#content", "#main", ".content"];
    for (const sel of candidates) {
      const extracted = _extractBySelector(cleaned, sel);
      if (extracted && _textDensityScore(extracted) > 200) { content = extracted; break; }
    }
  }

  let markdown = _htmlToMarkdown(content, url, p.includeLinks);
  const metaParts: string[] = [];
  if (ogTitle || title) metaParts.push(`# ${_decodeHtmlEntities(ogTitle || title)}`);
  if (canonical !== url) metaParts.push(`URL: ${canonical}`);
  if (author)  metaParts.push(`Author: ${_decodeHtmlEntities(author)}`);
  if (pubDate) metaParts.push(`Published: ${pubDate.slice(0, 10)}`);
  if (description) metaParts.push(`\n${_decodeHtmlEntities(description)}`);
  if (metaParts.length > 0) markdown = metaParts.join("\n") + "\n\n---\n\n" + markdown;

  return markdown.replace(/\n{3,}/g, "\n\n").trim();
}

function _extractBySelector(html: string, selector: string): string {
  const sel = selector.replace(/['"]/g, "");
  let pattern: RegExp | null = null;
  if (sel.startsWith("#")) {
    const id = sel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`<[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)(?=<(?:div|section|aside|footer|header|nav)\\b|$)`, "i");
  } else if (sel.startsWith(".")) {
    const cls = sel.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`<[^>]+class=["'][^"']*${cls}[^"']*["'][^>]*>([\\s\\S]*?)(?=<(?:div|section|aside|footer|header|nav)\\b|$)`, "i");
  } else {
    const tag = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  }
  if (!pattern) return "";
  const match = html.match(pattern);
  return match ? match[0] : "";
}

function _htmlToMarkdown(html: string, baseUrl: string, includeLinks: boolean): string {
  return html
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => "\n" + "#".repeat(parseInt(n)) + " " + _stripInline(t) + "\n")
    .replace(/<(?:p|div)\b[^>]*>([\s\S]*?)<\/(?:p|div)>/gi, (_m, t) => { const s = _stripInline(t).trim(); return s ? "\n" + s + "\n" : ""; })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, (_m, t) => `**${_stripInline(t)}**`)
    .replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, (_m, t) => `**${_stripInline(t)}**`)
    .replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, (_m, t) => `_${_stripInline(t)}_`)
    .replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, (_m, t) => `_${_stripInline(t)}_`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, t) => `\`${_stripTags(t)}\``)
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, t) => "\n```\n" + _stripTags(t) + "\n```\n")
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t) => "\n> " + _stripInline(t).replace(/\n/g, "\n> ") + "\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
      const linkText = _stripInline(text).trim();
      if (!linkText) return "";
      if (!includeLinks) return linkText;
      try { const abs = new URL(href, baseUrl).toString(); const dom = _hostnameFromUrl(baseUrl); return abs.includes(dom) ? linkText : `[${linkText}](${abs})`; } catch { return linkText; }
    })
    .replace(/<img\b[^>]*alt=["']([^"']+)["'][^>]*\/?>/gi, (_m, alt) => alt.trim() ? `![${alt}]` : "")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => { const s = _stripInline(t).trim(); return s ? `\n- ${s}` : ""; })
    .replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_m, t) => _tableToMarkdown(t))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(parseInt(n, 10)); } catch { return ""; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCharCode(parseInt(h, 16)); } catch { return ""; } });
}

function _tableToMarkdown(tableHtml: string): string {
  const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (!rows.length) return "";
  const parsedRows = rows.map(([, rowContent]) => {
    const cells = [...rowContent.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(([, c]) => _stripInline(c).replace(/\|/g, "\\|").trim());
    return cells;
  });
  if (!parsedRows.length) return "";
  const maxCols = Math.max(...parsedRows.map(r => r.length));
  const padRow  = (r: string[]) => r.concat(Array(maxCols - r.length).fill("")).map(c => ` ${c} `).join("|");
  const lines   = [`|${padRow(parsedRows[0])}|`, `|${Array(maxCols).fill(" --- ").join("|")}|`, ...parsedRows.slice(1).map(r => `|${padRow(r)}|`)];
  return "\n" + lines.join("\n") + "\n";
}

function _stripInline(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}
function _stripTags(html: string): string { return html.replace(/<[^>]+>/g, ""); }
function _textDensityScore(html: string): number { const text = _stripTags(html); const wc = text.split(/\s+/).filter(Boolean).length; const tc = (html.match(/<[^>]+>/g) ?? []).length; return tc === 0 ? wc : wc / (tc + 1) * wc; }
function _decodeHtmlEntities(s: string): string { return s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ").replace(/&mdash;/g,"—").replace(/&ndash;/g,"–"); }
function _hostnameFromUrl(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
function _isBinaryContentType(ct: string): boolean { return ct.includes("application/pdf") || ct.includes("image/") || ct.includes("video/") || ct.includes("audio/") || ct.includes("application/zip") || ct.includes("application/octet-stream"); }

function _parseFeed(xml: string, feedUrl: string): string {
  const isAtom = xml.includes("<feed");
  const feedTitle = xml.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1]?.trim() ?? feedUrl;
  const itemTag = isAtom ? "entry" : "item";
  const pattern = new RegExp(`<${itemTag}[^>]*>([\\s\\S]*?)<\\/${itemTag}>`, "gi");
  const items: string[] = []; let m: RegExpExecArray | null; let count = 0;
  while ((m = pattern.exec(xml)) !== null && count < 20) {
    const item = m[1];
    const title   = _extractXmlField(item, ["title"]);
    const link    = _extractXmlField(item, ["link", "id"]);
    const date    = _extractXmlField(item, ["pubDate","published","updated","dc:date"]);
    const author  = _extractXmlField(item, ["author","dc:creator"])?.replace(/<[^>]+>/g,"").trim();
    const summary = _extractXmlField(item, ["description","summary","content:encoded"])?.replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim().slice(0, 300);
    const lines = [`### ${title || "(untitled)"}`];
    if (link)    lines.push(link.trim());
    if (date)    lines.push(`Published: ${date.slice(0,10)}`);
    if (author)  lines.push(`Author: ${author}`);
    if (summary) lines.push(`\n${summary}…`);
    items.push(lines.join("\n")); count++;
  }
  return [`# ${_decodeHtmlEntities(feedTitle)} (Feed)`, `Source: ${feedUrl}`, `${items.length} items`, "---", items.join("\n\n---\n\n")].join("\n\n");
}

function _extractXmlField(xml: string, tags: string[]): string {
  for (const tag of tags) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<\\!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i"));
    if (m) return _decodeHtmlEntities(m[1].trim());
    const linkHref = xml.match(new RegExp(`<${tag}[^>]+href=["']([^"']+)["'][^>]*\\/?>`, "i"));
    if (linkHref) return linkHref[1];
  }
  return "";
}

function _truncateAt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cutZone  = text.slice(maxChars - Math.floor(maxChars * 0.1), maxChars + 500);
  const paraBreak = cutZone.search(/\n\n/);
  const cutAt    = paraBreak !== -1 ? maxChars - Math.floor(maxChars * 0.1) + paraBreak : maxChars;
  return text.slice(0, cutAt).trimEnd() + `\n\n---\n_Content truncated at ${cutAt.toLocaleString()} characters._`;
}

function _toolResult(text: string) { return { content: [{ type: "text" as const, text }], details: {} }; }
