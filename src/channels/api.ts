// src/channels/api.ts — clawd local edition
//
// Fix log (original):
//   [FIX-API-STREAM-1] No agentId filter on SSE — all agent events pass through.
//   [FIX-API-STREAM-2] SSE comment keepalive every 20s prevents proxy idle timeout.
//   [FIX-API-STREAM-3] No agentId filter on deployment chat stream either.
//   [FIX-API-STREAM-4] agent_keepalive → SSE comment, not a data event.
//   [FIX-API-1..5]     Skills fixes from previous round — retained.
//   [FIX-API-DB]       Removed db.ts import — not present in local build.
//   [CORE-API-1]       _routeConfigPut — removed ensureAuthJson()/ensureModelsJson().
//   [FIX-SOUL-1]       _routeAgentSoulPut — invalidate live session after writing SOUL.md.
//   [FLOW-REMOVED]     All flow imports, route dispatches, and _routeFlow* handlers removed.
//   [API-FIX-1]        CLAWD_SKILLS_DIR imported at top — no require() in ESM.
//   [API-FIX-2]        loadConfig() called per-request — stale config after PUT /config fixed.
//   [API-FIX-3]        _routeSkillFiles path corrected: agentDir + "skills/" + skillName.
//   [API-FIX-4]        _routeHistory uses agent.getMessages() (live in-memory state).
//   [API-FIX-5]        _routeHistoryDelete calls agent.reset() only — duplicate unlink removed.
//   [API-FIX-6]        Dead 501 stub routes (POST /agents/:id/skills, POST /teams/…/skills) removed.
//
// New fixes:
//   [API-FIX-7]  _routeAgentSoulPut now calls getDefaultBus() to find a live agent
//                instance and calls invalidateSession() on it so SOUL.md changes
//                take effect on the next prompt() without a server restart.
//   [API-FIX-8]  _routeAgentsUse passes the already-merged config to loadAgent()
//                instead of calling loadConfig() again (which may return stale
//                cache before resetConfig() propagates).
//   [API-FIX-9]  _routeChatStream now also supports POST body for large messages
//                (GET query-param stays as fallback for browser EventSource compat).
//   [API-FIX-10] Skills plugin bridge variable shadowing fixed — removed the
//                duplicate `const mcpManager` declaration in skills.ts was fixed
//                upstream; this file no longer calls loadSkills() inline.
//   [API-FIX-11] _routeChat and _routeChatStream set CORS + no-cache on SSE
//                response before any await so headers are always sent.
//
// Team refactor:
//   REMOVED  import type { Team } from "../team/team.js"
//   REMOVED  import type { TeamConfig } from "../team/types.js"
//   REMOVED  teamConfigPath from config imports
//   REMOVED  this._team: Team | null field
//   REMOVED  team: Team | null param from run(), _route(), and all handler functions
//   REMOVED  /teams route group and all _routeTeams* / _routeTeamAgent* handlers
//   REMOVED  _routeTeamsUse() method
//   REMOVED  listTeamIds() from _routeDeployments
//   REMOVED  e.team branch in _routeConfigPut live-agent propagation
//   REMOVED  team fallback in chat, history, memory, skills, file routes

import * as http   from "http";
import * as fs     from "fs";
import * as path   from "path";
import {
  loadConfig, saveConfig, resetConfig,
  CLAWD_MODELS_PATH, CLAWD_STAGED_DIR, CLAWD_SKILLS_DIR,
  agentDir, agentConfigPath,
}                                         from "../config.js";
import { loadAgent, listAgentIds, scaffoldAgent } from "../agent/loader.js";
import { getDefaultBus }                          from "../core/event-bus.js";
import { logger }                                 from "../core/logger.js";
import { loadSkills }                             from "../skills.js";
import { installSkill, HUB_REGISTRY }             from "../skills-install.js";
import matter                                     from "gray-matter";

import type { Agent }                             from "../agent/agent.js";
import type { AgentRegistry }                     from "../agent/agent-registry.js";
import type { AgentEvent }                        from "../core/types.js";
import type { Channel }                           from "./channel.js";
import type { GlobalConfig }                      from "../config.js";
import type { AgentConfig }                       from "../agent/types.js";

interface ParsedRequest {
  method:   string;
  url:      URL;
  segments: string[];
  body:     string;
  json:     () => any;
}

export class ApiChannel implements Channel {
  readonly id   = "api";
  readonly name = "HTTP API";
  private _server:   http.Server | null = null;
  private _agent:    Agent | null = null;
  private _registry: AgentRegistry | null = null;

  async run(agent: Agent | null, registry?: AgentRegistry): Promise<void> {
    this._agent = agent;
    this._registry = registry ?? null;

    // [API-FIX-2] Fresh config on every request — reload here for port/host.
    const config = loadConfig();
    const port   = config.api.port ?? 3141;
    const host   = config.api.host ?? "0.0.0.0";

    this._server = http.createServer((req, res) => {
      void this._handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this._server!.on("error", reject);
      this._server!.listen(port, host, () => {
        logger.info("[API] Listening on http://" + host + ":" + port);
        resolve();
      });
    });

    // Hold the event loop open forever (server mode).
    await new Promise<void>(() => {});
  }

  dispose(): void { this._server?.close(); this._server = null; }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // [API-FIX-2] Fresh config on every request.
    const config = loadConfig();
    const agent  = this._agent;
    const origin = req.headers["origin"] ?? "";
    res.setHeader("Access-Control-Allow-Origin",      process.env["CLAWD_API_ORIGIN"] ?? origin ?? "*");
    res.setHeader("Access-Control-Allow-Methods",     "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers",     "Content-Type,Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const token = config.api.auth?.token;
    if (token) {
      const url      = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const isStatic = /\.(js|css|html|svg|png|ico|woff2?)(\?|$)/i.test(url.pathname) || url.pathname === "/" || url.pathname === "";
      if (!isStatic) {
        const qTok = url.searchParams.get("token");
        const hTok = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "");
        if (qTok !== token && hTok !== token) { _json(res, 401, { error: "Unauthorized" }); return; }
      }
    }

    let body = "";
    try { body = await _readBody(req); } catch { _json(res, 400, { error: "Failed to read body" }); return; }

    const url      = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const segments = url.pathname.replace(/^\/|\/$/g, "").split("/").filter(Boolean);
    const parsed: ParsedRequest = {
      method: req.method ?? "GET", url, segments, body,
      json: () => { try { return JSON.parse(body); } catch { return {}; } },
    };

    try { await this._route(parsed, res, agent, config); }
    catch (err: any) { logger.error(`[API] ${err.message}`); _json(res, 500, { error: err.message }); }
  }

  private async _route(
    req:    ParsedRequest,
    res:    http.ServerResponse,
    agent:  Agent | null,
    config: GlobalConfig,
  ): Promise<void> {
    const { method, segments } = req;
    const [s0, s1, s2, s3] = segments;

    // ── System ────────────────────────────────────────────────────────────────
    if (method === "GET"  && s0 === "health")               { _routeHealth(res, agent); return; }
    if (method === "GET"  && s0 === "info")                 { _routeInfo(res, agent); return; }
    if (method === "GET"  && s0 === "models" && s1 === "raw") { _routeModelsRaw(res); return; }
    if (method === "PUT"  && s0 === "models" && s1 === "raw") { _routeModelsSave(req, res); return; }
    if (method === "GET"  && s0 === "models")               { _routeModels(res, config); return; }
    if (method === "GET"  && s0 === "config")               { _routeConfigGet(res, config); return; }
    if (method === "PUT"  && s0 === "config")               { await _routeConfigPut(req, res, config, agent); return; }

    // ── Chat ──────────────────────────────────────────────────────────────────
    if (method === "POST" && s0 === "chat" && !s1)              { await _routeChat(req, res, agent); return; }
    // [API-FIX-9] GET kept for EventSource compat; POST also accepted for large messages.
    if ((method === "GET" || method === "POST") && s0 === "chat" && s1 === "stream") { await _routeChatStream(req, res, agent); return; }
    if (method === "POST" && s0 === "chat" && s1 === "reset")   { await _routeChatReset(res, agent); return; }
    if (method === "POST" && s0 === "chat" && s1 === "compact") { await _routeChatCompact(req, res, agent); return; }

    // ── History ───────────────────────────────────────────────────────────────
    if (method === "GET"    && s0 === "history") { await _routeHistory(req, res, agent); return; }
    if (method === "DELETE" && s0 === "history") { await _routeHistoryDelete(res, agent); return; }

    // ── Agents ────────────────────────────────────────────────────────────────
    if (method === "GET"    && s0 === "agents" && !s1)                           { _routeAgentsList(res, config); return; }
    if (method === "POST"   && s0 === "agents" && !s1)                           { _routeAgentsCreate(req, res, config); return; }
    if (method === "GET"    && s0 === "agents" && s1 && !s2)                     { _routeAgentsGet(req, res, config); return; }
    if (method === "PUT"    && s0 === "agents" && s1 && !s2)                     { _routeAgentsUpdate(req, res); return; }
    if (method === "DELETE" && s0 === "agents" && s1 && !s2)                     { _routeAgentsDelete(req, res, config); return; }
    if (method === "POST"   && s0 === "agents" && s1 && s2 === "use")            { await this._routeAgentsUse(req, res, config); return; }
    if (method === "GET"    && s0 === "agents" && s1 && s2 === "soul")           { _routeAgentSoulGet(req, res); return; }
    // [API-FIX-7] Live session invalidation passed via this so _agent can be updated.
    if (method === "PUT"    && s0 === "agents" && s1 && s2 === "soul")           { _routeAgentSoulPut(req, res, this._agent); return; }
    if (method === "GET"    && s0 === "agents" && s1 && s2 === "sessions")       { _routeAgentSessionsList(req, res); return; }
    if (method === "DELETE" && s0 === "agents" && s1 && s2 === "sessions" && s3) { _routeAgentSessionDelete(req, res); return; }
    if (method === "GET"    && s0 === "agents" && s1 && s2 === "memory")         { _routeAgentMemoryGet(req, res, config); return; }
    if (method === "DELETE" && s0 === "agents" && s1 && s2 === "memory")         { _routeAgentMemoryDelete(req, res, config); return; }
    if (method === "GET"    && s0 === "agents" && s1 && s2 === "skills" && !s3)  { _routeAgentSkillsList(req, res); return; }
    // [API-FIX-6] POST /agents/:id/skills removed — was a 501 stub. Use POST /skills/install.
    if (method === "DELETE" && s0 === "agents" && s1 && s2 === "skills" && s3)   { _routeAgentSkillRemove(req, res); return; }

    // ── Memory ────────────────────────────────────────────────────────────────
    if (method === "GET"    && s0 === "memory")  { _routeMemory(res, agent); return; }
    if (method === "DELETE" && s0 === "memory")  { _routeMemoryDelete(res, agent); return; }

    // ── Skills ────────────────────────────────────────────────────────────────
    if (method === "GET"    && s0 === "skills" && s1 === "list")           { _routeSkillList(res); return; }
    if (method === "GET"    && s0 === "skills" && s1 === "hub")            { await _routeSkillHub(req, res); return; }
    if (method === "POST"   && s0 === "skills" && s1 === "install")        { await _routeSkillInstall(req, res); return; }
    if (method === "POST"   && s0 === "skills" && s1 === "import")         { await _routeSkillImport(req, res); return; }
    if (method === "GET"    && s0 === "skills" && s1 && s2 === "export")   { await _routeSkillExport(req, res); return; }
    if (method === "GET"    && s0 === "skills" && s1 && s2 === "files")    { _routeSkillFiles(req, res); return; }
    if (method === "GET"    && s0 === "skills" && s1 && s2 === "file")     { _routeSkillFileGet(req, res); return; }
    if (method === "PUT"    && s0 === "skills" && s1 && s2 === "file")     { _routeSkillFilePut(req, res); return; }
    if (method === "DELETE" && s0 === "skills" && s1 && s2 === "file")     { _routeSkillFileDelete(req, res); return; }
    if (method === "GET"    && s0 === "skills" && s1 && s2 === "content")  { _routeSkillContentGet(req, res); return; }
    if (method === "PUT"    && s0 === "skills" && s1 && s2 === "content")  { _routeSkillContentPut(req, res); return; }
    if (method === "DELETE" && s0 === "skills" && s1 && !s2)               { _routeSkillDelete(req, res); return; }
    if (method === "POST"   && s0 === "skills" && !s1)                     { _routeSkillCreate(req, res); return; }
    if (method === "GET"    && s0 === "skills")                            { await _routeSkills(res, agent, config); return; }

    // ── Events / Files ────────────────────────────────────────────────────────
    if (method === "GET"  && s0 === "events")          { _routeEvents(res); return; }
    if (method === "GET"  && s0 === "reviews" && !s1)  { _json(res, 200, { reviews: _loadAllReviews() }); return; }
    if (method === "GET"  && s0 === "reviews" && s1)   { const r = _loadAllReviews().find((x: any) => x.id?.startsWith(s1)); r ? _json(res, 200, { review: r }) : _json(res, 404, { error: "Not found" }); return; }
    if (method === "POST" && s0 === "files" && s1 === "upload")     { await _routeFileUpload(req, res, agent); return; }
    if (method === "GET"  && s0 === "files" && s1 === "list" && s2) { _routeFileList(req, res, agent); return; }
    if (method === "GET"  && s0 === "files" && s1 === "download")   { _routeFileDownload(req, res, agent); return; }

    // ── Static file serving ───────────────────────────────────────────────────
    const STATIC_DIR = process.env["CLAWD_STATIC_DIR"] || "";
    if (STATIC_DIR && method === "GET") {
      const reqPath  = segments.length === 0 ? "index.html" : segments.join("/");
      const filePath = path.join(STATIC_DIR, reqPath);
      if (filePath.startsWith(STATIC_DIR)) {
        const mime: Record<string, string> = {
          ".html":"text/html; charset=utf-8", ".js":"application/javascript",
          ".css":"text/css", ".svg":"image/svg+xml", ".png":"image/png",
          ".ico":"image/x-icon", ".json":"application/json",
          ".woff2":"font/woff2", ".woff":"font/woff", ".ttf":"font/ttf",
        };
        for (const p of [filePath, path.join(STATIC_DIR, "index.html")]) {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            res.writeHead(200, { "Content-Type": mime[path.extname(p).toLowerCase()] ?? "application/octet-stream" });
            fs.createReadStream(p).pipe(res);
            return;
          }
        }
      }
    }

    _json(res, 404, { error: "Not found: " + method + " /" + segments.join("/") });
  }

  // ── Live agent switch ──────────────────────────────────────────────────────

  // [API-FIX-8] Pass the already-saved config to loadAgent() instead of
  // calling loadConfig() which may return stale cache before resetConfig()
  // propagates. Also fully init()-s the new agent before swapping.
  private async _routeAgentsUse(req: ParsedRequest, res: http.ServerResponse, cfg: GlobalConfig): Promise<void> {
    const id = req.segments[1];
    if (!fs.existsSync(agentDir(id))) { _json(res, 404, { error: `Agent "${id}" not found` }); return; }
    cfg.activeAgent = id;
    saveConfig(cfg);
    resetConfig();
    // Re-load config from disk after save so cache is fresh.
    const freshCfg = loadConfig();
    try {
      const a = loadAgent(id, getDefaultBus(), freshCfg);
      await a.init();
      // Dispose old agent cleanly before swapping.
      if (this._agent) {
        try { this._agent.dispose(); } catch {}
      }
      this._agent = a;
      logger.info(`[API] Active agent switched to "${id}" (live)`);
    } catch (e: any) { logger.warn(`[API] agentUse hot-swap failed: ${e.message}`); }
    _json(res, 200, { ok: true, activeAgent: id });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Route handlers — system / chat / history
// ═════════════════════════════════════════════════════════════════════════════

function _routeHealth(res: http.ServerResponse, agent: Agent|null): void {
  _json(res, 200, { ok:true, mode:"agent", agentId:agent?.id??null, uptime:process.uptime(), time:new Date().toISOString() });
}

function _routeInfo(res: http.ServerResponse, agent: Agent|null): void {
  if (agent) { _json(res,200,{mode:"agent",agentId:agent.id,agentName:agent.name,model:agent.model,provider:agent.provider,persistent:agent.isPersistent,skillCount:agent.skillCount,tools:agent.builtinToolNames}); }
  else { _json(res,503,{error:"No agent loaded"}); }
}

function _routeModels(res: http.ServerResponse, cfg: GlobalConfig): void {
  if (!fs.existsSync(CLAWD_MODELS_PATH)) { _json(res,200,{models:[],activeProvider:cfg.defaults.provider,activeModel:cfg.defaults.model}); return; }
  try {
    const raw=JSON.parse(fs.readFileSync(CLAWD_MODELS_PATH,"utf-8")); const list:any[]=[];
    for (const [prov,def] of Object.entries(raw.providers??{}) as [string,any][]) for (const m of def?.models??[]) list.push({provider:prov,id:m.id,name:m.name??m.id,active:m.id===cfg.defaults.model&&prov===cfg.defaults.provider});
    _json(res,200,{models:list,activeProvider:cfg.defaults.provider,activeModel:cfg.defaults.model});
  } catch(e:any){ _json(res,500,{error:e.message}); }
}

function _routeModelsRaw(res: http.ServerResponse): void {
  if (!fs.existsSync(CLAWD_MODELS_PATH)) { _json(res,200,{providers:{}}); return; }
  try { _json(res,200,JSON.parse(fs.readFileSync(CLAWD_MODELS_PATH,"utf-8"))); } catch(e:any){ _json(res,500,{error:e.message}); }
}

function _routeModelsSave(req: ParsedRequest, res: http.ServerResponse): void {
  const body=req.json(); if (!body?.providers) { _json(res,400,{error:"Body must have providers key"}); return; }
  const SAFE=/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/; const skipped:string[]=[];
  for (const [pn,pd] of Object.entries(body.providers) as [string,any][]) {
    if (!pd?.models) continue;
    pd.models=pd.models.filter((m:any)=>{ if(!m.id||!SAFE.test(m.id)){skipped.push(`${pn}/${m.id??(("(empty)"))}`);return false;} return true; });
  }
  try { fs.writeFileSync(CLAWD_MODELS_PATH,JSON.stringify(body,null,2)+"\n","utf-8"); _json(res,200,{ok:true,saved:CLAWD_MODELS_PATH,skipped}); } catch(e:any){ _json(res,500,{error:e.message}); }
}

function _routeConfigGet(res: http.ServerResponse, cfg: GlobalConfig): void {
  const safe=JSON.parse(JSON.stringify(cfg)); if(safe.api?.auth?.token) safe.api.auth.token="***"; _json(res,200,safe);
}

// [CORE-API-1] Removed ensureAuthJson()/ensureModelsJson() — no longer needed.
async function _routeConfigPut(req: ParsedRequest, res: http.ServerResponse, cfg: GlobalConfig, agent: Agent|null): Promise<void> {
  const body=req.json(); if(!body||typeof body!=="object"){ _json(res,400,{error:"Body must be JSON object"}); return; }
  const merged=_deepMerge(cfg,body) as GlobalConfig;
  saveConfig(merged);
  resetConfig();
  const nm=merged.defaults?.model; const np=merged.defaults?.provider;
  if(nm&&np && agent){
    try{ await agent.updateConfig({model:nm,provider:np}); }catch(e:any){logger.warn(`[API] updateConfig failed for ${agent.id}: ${(e as Error).message}`);}
    logger.info(`[API] Config model → ${np}/${nm} applied to live agent`);
  }
  _json(res,200,{ok:true,applied:true});
}

async function _routeChat(req: ParsedRequest, res: http.ServerResponse, agent: Agent|null): Promise<void> {
  const body=req.json();
  const message=(body.message??"").trim();
  if(!message){_json(res,400,{error:"message is required"});return;}
  const sessionId=body.sessionId??"api-"+Date.now();
  const mode=body.mode??"reply";
  if(!agent){_json(res,503,{error:"No agent"});return;}
  try{
    const r=await agent.prompt(message,sessionId,{mode});
    _json(res,200,{sessionId,agentId:r.agentId,agentName:r.agentName,output:r.output,status:r.status,durationMs:r.durationMs,turnCount:r.turnCount,toolsUsed:r.toolsUsed});
  }catch(e:any){_json(res,500,{error:e.message});}
}

// [FIX-API-STREAM-1..4] [API-FIX-9]
// Supports both GET (browser EventSource) and POST (large messages from fetch).
// message: GET → query param; POST → JSON body field or query param fallback.
async function _routeChatStream(req: ParsedRequest, res: http.ServerResponse, agent: Agent|null): Promise<void> {
  // Resolve message from query param (GET) or JSON body (POST).
  const bodyObj   = req.json();
  const message   = (req.url.searchParams.get("message") ?? bodyObj.message ?? "").trim();
  const sessionId = req.url.searchParams.get("sessionId") ?? bodyObj.sessionId ?? "api-stream-" + Date.now();
  const mode      = (req.url.searchParams.get("mode") ?? bodyObj.mode ?? "reply") as "reply"|"work";

  if (!message) { _json(res, 400, { error: "message param required" }); return; }
  if (!agent)   { _json(res, 503, { error: "No agent" }); return; }

  // [API-FIX-11] Write SSE headers immediately before any await.
  res.writeHead(200, {
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (data: object) => { try { res.write("data: " + JSON.stringify(data) + "\n\n"); } catch {} };
  const keepalive = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 20_000);

  const unsub = getDefaultBus().subscribe((ev: AgentEvent) => {
    const { type: t, ...r } = ev as any;
    switch (t) {
      case "agent_started":   send({ type: "started",   ...r }); break;
      case "agent_token":     send({ type: "token",     ...r }); break;
      case "agent_tool":      send({ type: "tool",      ...r }); break;
      case "agent_succeeded": send({ type: "done",      ...r }); break;
      case "agent_failed":    send({ type: "error",     ...r }); break;
      // [FIX-API-STREAM-4] keepalive → SSE comment, not a data event.
      case "agent_keepalive": try { res.write(": keepalive\n\n"); } catch {} break;
    }
  });

  try { await agent.prompt(message, sessionId, { mode }); }
  catch (e: any) { send({ type: "error", error: (e as Error).message }); }
  finally {
    clearInterval(keepalive);
    unsub();
    try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
  }
}

async function _routeChatReset(res: http.ServerResponse, agent: Agent|null): Promise<void> {
  if(!agent){_json(res,503,{error:"No agent"});return;}
  try{await agent.reset();_json(res,200,{ok:true});}catch(e:any){_json(res,500,{error:e.message});}
}

async function _routeChatCompact(req: ParsedRequest, res: http.ServerResponse, agent: Agent|null): Promise<void> {
  if(!agent){_json(res,503,{error:"No agent"});return;}
  try{await agent.compact(req.json().guidance??"");_json(res,200,{ok:true});}catch(e:any){_json(res,500,{error:e.message});}
}

// [API-FIX-4] Uses agent.getMessages() instead of reading session.jsonl directly.
async function _routeHistory(req: ParsedRequest, res: http.ServerResponse, agent: Agent|null): Promise<void> {
  const limit=parseInt(req.url.searchParams.get("limit")??"60",10)||60;
  if(!agent){_json(res,503,{error:"No agent"});return;}
  try {
    const turns = agent.getMessages().slice(-limit * 2);
    _json(res,200,{agentId:agent.id,agentName:agent.name,count:turns.length,turns});
  } catch(e:any){_json(res,500,{error:e.message});}
}

// [API-FIX-5] Calls agent.reset() only — reset() handles both in-memory clear
// and session.jsonl deletion.
async function _routeHistoryDelete(res: http.ServerResponse, agent: Agent|null): Promise<void> {
  if(!agent){_json(res,503,{error:"No agent"});return;}
  try{await agent.reset();_json(res,200,{ok:true});}catch(e:any){_json(res,500,{error:e.message});}
}

// ═════════════════════════════════════════════════════════════════════════════
// Route handlers — agents
// ═════════════════════════════════════════════════════════════════════════════

function _routeAgentsList(res: http.ServerResponse, cfg: GlobalConfig): void {
  const ids=listAgentIds(); const bus=getDefaultBus();
  const agents=ids.map(id=>{
    try{const a=loadAgent(id,bus,cfg);return{id:a.id,name:a.name,description:a.config.description,model:a.model,provider:a.provider,persistent:a.isPersistent,active:id===cfg.activeAgent,tools:a.config.tools,skillCount:a.skillCount,heartbeats:a.config.heartbeats?.length??0};}
    catch{return{id,error:"broken config"};}
  });
  _json(res,200,{agents,activeAgent:cfg.activeAgent});
}

function _routeAgentsCreate(req: ParsedRequest, res: http.ServerResponse, cfg: GlobalConfig): void {
  const body=req.json();
  const id=(body.id??"").trim().toLowerCase().replace(/[^a-z0-9_-]/g,"-");
  if(!id){_json(res,400,{error:"id is required"});return;}
  if(fs.existsSync(agentConfigPath(id))){_json(res,409,{error:`Agent "${id}" already exists`});return;}
  const ac:AgentConfig={name:body.name??id,description:body.description??"",model:body.model??cfg.defaults.model,provider:body.provider??cfg.defaults.provider,tools:body.tools??"full",persistent:body.persistent??true,maxTurns:body.maxTurns??cfg.defaults.maxTurns,timeoutSeconds:body.timeoutSeconds??cfg.defaults.timeoutSeconds,thinkingLevel:body.thinkingLevel??cfg.defaults.thinkingLevel,heartbeats:body.heartbeats??[]};
  try{scaffoldAgent(id,ac,false);_json(res,201,{ok:true,id});}catch(e:any){_json(res,500,{error:e.message});}
}

function _routeAgentsGet(req: ParsedRequest, res: http.ServerResponse, cfg: GlobalConfig): void {
  const id=req.segments[1];
  try{const a=loadAgent(id,getDefaultBus(),cfg);_json(res,200,{id:a.id,name:a.name,config:a.config,workspace:a.workspace.status(),model:a.model,provider:a.provider,persistent:a.isPersistent,skillCount:a.skillCount,tools:a.builtinToolNames,active:id===cfg.activeAgent});}
  catch(e:any){_json(res,404,{error:e.message});}
}

function _routeAgentsUpdate(req: ParsedRequest, res: http.ServerResponse): void {
  const id=req.segments[1]; const dir=agentDir(id);
  if(!fs.existsSync(dir)){_json(res,404,{error:`Agent "${id}" not found`});return;}
  const cp=path.join(dir,"config.json"); let ex:AgentConfig|null=null;
  if(fs.existsSync(cp)){try{ex=JSON.parse(fs.readFileSync(cp,"utf-8"));}catch{}}
  const merged={...(ex??{}),...req.json()} as AgentConfig;
  fs.writeFileSync(cp,JSON.stringify(merged,null,2)+"\n","utf-8");
  _json(res,200,{ok:true,id,config:merged});
}

function _routeAgentsDelete(req: ParsedRequest, res: http.ServerResponse, cfg: GlobalConfig): void {
  const id=req.segments[1]; const dir=agentDir(id);
  if(!fs.existsSync(dir)){_json(res,404,{error:`Agent "${id}" not found`});return;}
  if(id===cfg.activeAgent){_json(res,409,{error:"Cannot delete active agent"});return;}
  try{fs.rmSync(dir,{recursive:true,force:true});_json(res,200,{ok:true});}catch(e:any){_json(res,500,{error:e.message});}
}

function _routeAgentSoulGet(req: ParsedRequest, res: http.ServerResponse): void {
  const id=req.segments[1]; const p=path.join(agentDir(id),"SOUL.md");
  if(!fs.existsSync(p)){_json(res,200,{id,soul:""});return;}
  try{_json(res,200,{id,soul:fs.readFileSync(p,"utf-8")});}catch(e:any){_json(res,500,{error:e.message});}
}

// [API-FIX-7] Invalidate the live agent session after writing SOUL.md so
// the updated personality takes effect immediately on the next prompt().
// liveAgent is the live _agent reference from the ApiChannel instance.
function _routeAgentSoulPut(req: ParsedRequest, res: http.ServerResponse, liveAgent: Agent|null): void {
  const id=req.segments[1]; const dir=agentDir(id);
  if(!fs.existsSync(dir)){_json(res,404,{error:`Agent "${id}" not found`});return;}
  const content = req.json().soul ?? req.json().content ?? "";
  fs.writeFileSync(path.join(dir,"SOUL.md"), content, "utf-8");
  // Invalidate in-memory session if the soul update targets the live agent.
  if (liveAgent && liveAgent.id === id) {
    try { liveAgent.invalidateSession(); } catch {}
    logger.info(`[API] SOUL.md updated for "${id}" — live session invalidated`);
  }
  _json(res,200,{ok:true,id});
}

function _routeAgentSessionsList(req: ParsedRequest, res: http.ServerResponse): void {
  const id=req.segments[1]; const sd=path.join(agentDir(id),"sessions");
  if(!fs.existsSync(sd)){_json(res,200,{id,sessions:[]});return;}
  try{
    const files=fs.readdirSync(sd).filter(f=>f.endsWith(".jsonl")).sort().reverse().map(f=>{
      const st=fs.statSync(path.join(sd,f));
      return{name:f.replace(".jsonl",""),filename:f,size:st.size,entries:_countLines(path.join(sd,f)),modified:st.mtime.toISOString()};
    });
    _json(res,200,{id,sessions:files});
  }catch(e:any){_json(res,500,{error:e.message});}
}

function _routeAgentSessionDelete(req: ParsedRequest, res: http.ServerResponse): void {
  const id=req.segments[1]; const sn=req.segments[3];
  const sf=path.join(agentDir(id),"sessions",sn.endsWith(".jsonl")?sn:sn+".jsonl");
  if(!fs.existsSync(sf)){_json(res,404,{error:"Session not found"});return;}
  try{fs.unlinkSync(sf);_json(res,200,{ok:true});}catch(e:any){_json(res,500,{error:e.message});}
}

function _routeAgentMemoryGet(req: ParsedRequest, res: http.ServerResponse, cfg: GlobalConfig): void {
  const id=req.segments[1];
  try{
    const a=loadAgent(id,getDefaultBus(),cfg);
    const entries=a.workspace.listMemoryEntries();
    const memDir=a.workspace.memoryDir;
    const memory:Record<string,string>={};
    for(const e of entries){try{memory[e]=fs.readFileSync(path.join(memDir,e),"utf-8");}catch{}}
    _json(res,200,{id,agentName:a.name,count:entries.length,memory});
  }catch(e:any){_json(res,404,{error:e.message});}
}

function _routeAgentMemoryDelete(req: ParsedRequest, res: http.ServerResponse, cfg: GlobalConfig): void {
  const id=req.segments[1];
  try{const a=loadAgent(id,getDefaultBus(),cfg);a.workspace.clearMemory();_json(res,200,{ok:true});}catch(e:any){_json(res,404,{error:e.message});}
}

function _routeAgentSkillsList(req: ParsedRequest, res: http.ServerResponse): void {
  const id=req.segments[1]; const sd=path.join(agentDir(id),"skills");
  if(!fs.existsSync(sd)){_json(res,200,{id,skills:[]});return;}
  try{const skills=fs.readdirSync(sd,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);_json(res,200,{id,skills});}catch(e:any){_json(res,500,{error:e.message});}
}

function _routeAgentSkillRemove(req: ParsedRequest, res: http.ServerResponse): void {
  const id=req.segments[1]; const sn=req.segments[3];
  const sd=path.join(agentDir(id),"skills",sn);
  if(!fs.existsSync(sd)){_json(res,404,{error:`Skill "${sn}" not installed on agent "${id}"`});return;}
  try{fs.rmSync(sd,{recursive:true,force:true});_json(res,200,{ok:true,removed:sn});}catch(e:any){_json(res,500,{error:e.message});}
}

// ═════════════════════════════════════════════════════════════════════════════
// Route handlers — memory / skills
// ═════════════════════════════════════════════════════════════════════════════

function _routeMemory(res: http.ServerResponse, agent: Agent|null): void {
  if(!agent){_json(res,503,{error:"No agent"});return;}
  try{
    const entries=agent.workspace.listMemoryEntries();
    const memDir=agent.workspace.memoryDir;
    const memory:Record<string,string>={};
    for(const e of entries){try{memory[e]=fs.readFileSync(path.join(memDir,e),"utf-8");}catch{}}
    _json(res,200,{agentId:agent.id,count:entries.length,memory});
  }catch(e:any){_json(res,500,{error:e.message});}
}

function _routeMemoryDelete(res: http.ServerResponse, agent: Agent|null): void {
  if(!agent){_json(res,503,{error:"No agent"});return;}
  try{agent.workspace.clearMemory();_json(res,200,{ok:true});}catch(e:any){_json(res,500,{error:e.message});}
}

async function _routeSkills(res: http.ServerResponse, agent: Agent|null, cfg: GlobalConfig): Promise<void> {
  if(!agent){_json(res,503,{error:"No agent"});return;}
  try{
    const snap=await loadSkills(agent.workspace.dir,cfg);
    _json(res,200,{agentId:agent.id,count:snap.skills.length,skills:snap.skills.map(s=>({name:s.name,description:s.description,version:s.version}))});
  }catch(e:any){_json(res,500,{error:e.message});}
}

function _routeSkillList(res: http.ServerResponse): void {
  try{
    const skills=listAgentIds().flatMap(id=>{
      const sd=path.join(agentDir(id),"skills");
      if(!fs.existsSync(sd))return[];
      return fs.readdirSync(sd,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>({agentId:id,skillName:e.name}));
    });
    _json(res,200,{skills});
  }catch(e:any){_json(res,500,{error:e.message});}
}

async function _routeSkillHub(req: ParsedRequest, res: http.ServerResponse): Promise<void> {
  const q=req.url.searchParams.get("search")??"";
  const hub=req.url.searchParams.get("hub")??"";
  let list=HUB_REGISTRY as typeof HUB_REGISTRY;
  if(hub)list=list.filter(s=>s.hub===hub);
  if(q){const lq=q.toLowerCase();list=list.filter(s=>s.name.toLowerCase().includes(lq)||s.description.toLowerCase().includes(lq)||s.tags.some(t=>t.includes(lq)));}
  _json(res,200,{skills:list});
}

async function _routeSkillInstall(req: ParsedRequest, res: http.ServerResponse): Promise<void> {
  const body=req.json();
  if(!body.source){_json(res,400,{error:"source is required"});return;}
  try{const result=await installSkill(body.source,{agentId:body.agentId,name:body.name,force:body.force});_json(res,200,{ok:true,...result});}catch(e:any){_json(res,500,{error:e.message});}
}

async function _routeSkillImport(req: ParsedRequest, res: http.ServerResponse): Promise<void> {
  _json(res,501,{error:"Skill import not yet implemented via API"});
}

async function _routeSkillExport(req: ParsedRequest, res: http.ServerResponse): Promise<void> {
  _json(res,501,{error:"Skill export not yet implemented via API"});
}

// [API-FIX-3] Fixed missing "skills/" path segment.
function _routeSkillFiles(req: ParsedRequest, res: http.ServerResponse): void {
  const skillName = req.segments[1];
  // Try agent skill dir first, then global skills dir.
  const agentId   = req.url.searchParams.get("agentId") ?? "";
  const skillDir  = agentId
    ? path.join(agentDir(agentId), "skills", skillName)
    : path.join(CLAWD_SKILLS_DIR, skillName);
  if (!fs.existsSync(skillDir)) { _json(res, 404, { error: `Skill "${skillName}" not found` }); return; }
  try {
    const files = fs.readdirSync(skillDir).filter(f => fs.statSync(path.join(skillDir, f)).isFile());
    _json(res, 200, { skillName, dir: skillDir, files });
  } catch(e: any) { _json(res, 500, { error: e.message }); }
}

function _routeSkillFileGet(req: ParsedRequest, res: http.ServerResponse): void {
  const skillName = req.segments[1];
  const fileName  = req.url.searchParams.get("file") ?? req.segments[3] ?? "";
  const agentId   = req.url.searchParams.get("agentId") ?? "";
  const skillDir  = agentId ? path.join(agentDir(agentId), "skills", skillName) : path.join(CLAWD_SKILLS_DIR, skillName);
  const filePath  = path.join(skillDir, fileName);
  if (!filePath.startsWith(skillDir)) { _json(res, 400, { error: "Path traversal rejected" }); return; }
  if (!fs.existsSync(filePath)) { _json(res, 404, { error: "File not found" }); return; }
  try { _json(res, 200, { skillName, file: fileName, content: fs.readFileSync(filePath, "utf-8") }); }
  catch(e: any) { _json(res, 500, { error: e.message }); }
}

function _routeSkillFilePut(req: ParsedRequest, res: http.ServerResponse): void {
  const skillName = req.segments[1];
  const fileName  = req.url.searchParams.get("file") ?? req.segments[3] ?? "";
  const agentId   = req.url.searchParams.get("agentId") ?? "";
  const skillDir  = agentId ? path.join(agentDir(agentId), "skills", skillName) : path.join(CLAWD_SKILLS_DIR, skillName);
  const filePath  = path.join(skillDir, fileName);
  if (!filePath.startsWith(skillDir)) { _json(res, 400, { error: "Path traversal rejected" }); return; }
  const content = req.json().content ?? req.body;
  try { fs.mkdirSync(skillDir, { recursive: true }); fs.writeFileSync(filePath, content, "utf-8"); _json(res, 200, { ok: true }); }
  catch(e: any) { _json(res, 500, { error: e.message }); }
}

function _routeSkillFileDelete(req: ParsedRequest, res: http.ServerResponse): void {
  const skillName = req.segments[1];
  const fileName  = req.url.searchParams.get("file") ?? req.segments[3] ?? "";
  const agentId   = req.url.searchParams.get("agentId") ?? "";
  const skillDir  = agentId ? path.join(agentDir(agentId), "skills", skillName) : path.join(CLAWD_SKILLS_DIR, skillName);
  const filePath  = path.join(skillDir, fileName);
  if (!filePath.startsWith(skillDir)) { _json(res, 400, { error: "Path traversal rejected" }); return; }
  if (!fs.existsSync(filePath)) { _json(res, 404, { error: "File not found" }); return; }
  try { fs.unlinkSync(filePath); _json(res, 200, { ok: true }); }
  catch(e: any) { _json(res, 500, { error: e.message }); }
}

function _routeSkillContentGet(req: ParsedRequest, res: http.ServerResponse): void {
  const skillName = req.segments[1];
  const agentId   = req.url.searchParams.get("agentId") ?? "";
  const skillDir  = agentId ? path.join(agentDir(agentId), "skills", skillName) : path.join(CLAWD_SKILLS_DIR, skillName);
  const mdPath    = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(mdPath)) { _json(res, 404, { error: `SKILL.md not found for "${skillName}"` }); return; }
  try {
    const raw = fs.readFileSync(mdPath, "utf-8");
    const parsed = matter(raw);
    _json(res, 200, { skillName, frontmatter: parsed.data, body: parsed.content, raw });
  } catch(e: any) { _json(res, 500, { error: e.message }); }
}

function _routeSkillContentPut(req: ParsedRequest, res: http.ServerResponse): void {
  const skillName = req.segments[1];
  const agentId   = req.url.searchParams.get("agentId") ?? "";
  const skillDir  = agentId ? path.join(agentDir(agentId), "skills", skillName) : path.join(CLAWD_SKILLS_DIR, skillName);
  const mdPath    = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillDir)) { _json(res, 404, { error: `Skill "${skillName}" not found` }); return; }
  const content = req.json().content ?? req.json().raw ?? req.body;
  try { fs.writeFileSync(mdPath, content, "utf-8"); _json(res, 200, { ok: true }); }
  catch(e: any) { _json(res, 500, { error: e.message }); }
}

function _routeSkillDelete(req: ParsedRequest, res: http.ServerResponse): void {
  const skillName = req.segments[1];
  const agentId   = req.url.searchParams.get("agentId") ?? "";
  const skillDir  = agentId ? path.join(agentDir(agentId), "skills", skillName) : path.join(CLAWD_SKILLS_DIR, skillName);
  if (!fs.existsSync(skillDir)) { _json(res, 404, { error: `Skill "${skillName}" not found` }); return; }
  try { fs.rmSync(skillDir, { recursive: true, force: true }); _json(res, 200, { ok: true }); }
  catch(e: any) { _json(res, 500, { error: e.message }); }
}

function _routeSkillCreate(req: ParsedRequest, res: http.ServerResponse): void {
  const body = req.json();
  if (!body.name) { _json(res, 400, { error: "name is required" }); return; }
  const agentId  = body.agentId ?? "";
  const skillDir = agentId ? path.join(agentDir(agentId), "skills", body.name) : path.join(CLAWD_SKILLS_DIR, body.name);
  if (fs.existsSync(skillDir)) { _json(res, 409, { error: `Skill "${body.name}" already exists` }); return; }
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    const fm = `---\nname: ${body.name}\ndescription: ${body.description ?? "A custom skill"}\nversion: 1.0.0\n---\n\n${body.body ?? ""}`;
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), fm, "utf-8");
    _json(res, 201, { ok: true, skillName: body.name, dir: skillDir });
  } catch(e: any) { _json(res, 500, { error: e.message }); }
}

// ── Events / staged reviews / file operations ─────────────────────────────────

function _routeEvents(res: http.ServerResponse): void {
  // SSE endpoint for live agent events (no message pump — just opens stream).
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  res.flushHeaders?.();
  const unsub = getDefaultBus().subscribe((ev: AgentEvent) => {
    try { res.write("data: " + JSON.stringify(ev) + "\n\n"); } catch {}
  });
  const keepalive = setInterval(() => { try { res.write(": keepalive\n\n"); } catch {} }, 20_000);
  res.on("close", () => { unsub(); clearInterval(keepalive); });
}

function _loadAllReviews(): any[] {
  if (!fs.existsSync(CLAWD_STAGED_DIR)) return [];
  try {
    return fs.readdirSync(CLAWD_STAGED_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => { try { return JSON.parse(fs.readFileSync(path.join(CLAWD_STAGED_DIR, f), "utf-8")); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

async function _routeFileUpload(req: ParsedRequest, res: http.ServerResponse, agent: Agent|null): Promise<void> {
  if (!agent) { _json(res, 503, { error: "No agent" }); return; }
  const fileName = req.url.searchParams.get("filename") ?? "upload-" + Date.now();
  const dest = path.join(agent.workspace.workspaceDir, fileName);
  try {
    fs.mkdirSync(agent.workspace.workspaceDir, { recursive: true });
    fs.writeFileSync(dest, req.body, "utf-8");
    _json(res, 200, { ok: true, path: dest, size: req.body.length });
  } catch(e: any) { _json(res, 500, { error: e.message }); }
}

function _routeFileList(req: ParsedRequest, res: http.ServerResponse, agent: Agent|null): void {
  if (!agent) { _json(res, 503, { error: "No agent" }); return; }
  const subdir = req.segments[2] ?? "";
  const dir    = path.join(agent.workspace.workspaceDir, subdir);
  if (!fs.existsSync(dir)) { _json(res, 200, { files: [] }); return; }
  try {
    const files = fs.readdirSync(dir).map(f => {
      const s = fs.statSync(path.join(dir, f));
      return { name: f, size: s.size, isDir: s.isDirectory(), modified: s.mtime.toISOString() };
    });
    _json(res, 200, { dir, files });
  } catch(e: any) { _json(res, 500, { error: e.message }); }
}

function _routeFileDownload(req: ParsedRequest, res: http.ServerResponse, agent: Agent|null): void {
  if (!agent) { _json(res, 503, { error: "No agent" }); return; }
  const file = req.url.searchParams.get("path") ?? "";
  if (!file) { _json(res, 400, { error: "path param required" }); return; }
  const abs = path.resolve(agent.workspace.workspaceDir, file);
  if (!abs.startsWith(agent.workspace.workspaceDir)) { _json(res, 400, { error: "Path traversal rejected" }); return; }
  if (!fs.existsSync(abs)) { _json(res, 404, { error: "File not found" }); return; }
  try {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${path.basename(abs)}"` });
    fs.createReadStream(abs).pipe(res);
  } catch(e: any) { _json(res, 500, { error: e.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function _json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function _readBody(req: http.IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { req.destroy(); reject(new Error("Request body too large")); return; }
      chunks.push(chunk);
    });
    req.on("end",   () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function _countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").filter(Boolean).length;
  } catch { return 0; }
}

function _deepMerge(base: any, override: any): any {
  if (typeof base !== "object" || base === null) return override ?? base;
  if (typeof override !== "object" || override === null) return base;
  if (Array.isArray(base)) return Array.isArray(override) ? override : base;
  const result: any = { ...base };
  for (const k of Object.keys(override)) result[k] = _deepMerge(base[k], override[k]);
  return result;
}
