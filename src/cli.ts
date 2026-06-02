// src/cli.ts — AI-OS API server entrypoint
//
// Architecture: ALL interaction is handled by the frontend via the HTTP API.
// The CLI's ONLY job is to:
//   1. Run first-time setup if ~/.clawd/ is not configured.
//   2. Load environment, config, and start the AgentRegistry.
//   3. Start the ApiChannel (HTTP server).
//
// All agents are pre-loaded at startup via AgentRegistry. User messages go to
// the Admin OS agent, which delegates tasks to worker agents through mailboxes.

import * as path    from "path";
import * as fs      from "fs";
import * as os      from "os";
import {
  loadConfig,
  loadEnv,
  overrideApiPort,
  getConfigPath,
  CLAWD_DIR,
  DEFAULT_AGENT_ID,
} from "./config.js";
import { logger }              from "./core/logger.js";
import { AgentRegistry }       from "./agent/agent-registry.js";
import { ApiChannel }          from "./channels/api.js";
import { _runSetupWizard }     from "./cli-setup.js";

interface CliArgs {
  port?:  number;
  host?:  string;
  setup:  boolean;
  help:   boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const result: CliArgs = { setup: false, help: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--setup")              { result.setup = true; continue; }
    if (a === "--help" || a === "-h") { result.help  = true; continue; }
    if (a === "--port" && args[i + 1]) {
      const p = parseInt(args[++i], 10);
      if (!isNaN(p) && p > 0 && p < 65536) result.port = p;
      continue;
    }
    if (a.startsWith("--port=")) {
      const p = parseInt(a.slice(7), 10);
      if (!isNaN(p) && p > 0 && p < 65536) result.port = p;
      continue;
    }
    if (a === "--host" && args[i + 1]) { result.host = args[++i]; continue; }
    if (a.startsWith("--host="))       { result.host = a.slice(7); continue; }
  }
  return result;
}

function printHelp(): void {
  console.log(`
clawd — AI-OS API server

Usage:
  clawd [options]

Options:
  --port <n>     Override API port (default from clawd.json, fallback 3141)
  --host <addr>  Override bind address (default from clawd.json, fallback 0.0.0.0)
  --setup        Force re-run the setup wizard
  --help, -h     Show this help

All interaction is done via the HTTP API.
The frontend connects to http://<host>:<port>.

Endpoints:
  GET   /health              — server health
  GET   /info                — active agent info
  POST  /chat                — send a message (JSON body: { message, sessionId?, mode? })
  GET   /chat/stream?message=…  — SSE streaming chat
  POST  /chat/reset          — clear conversation history
  GET   /history             — conversation history
  GET   /agents              — list agents
  POST  /agents/:id/use      — switch active agent
  GET   /skills              — list skills
  POST  /skills/install      — install a skill
  GET   /skills/hub          — browse skill hub
`.trim());
}

function isFirstRun(): boolean {
  return !fs.existsSync(getConfigPath());
}

function setupShutdown(dispose: () => void): void {
  const handler = (sig: string) => {
    process.stderr.write(`\n[clawd] Received ${sig} — shutting down…\n`);
    try { dispose(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT",  () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) { printHelp(); process.exit(0); }

  // ── 1. First-run setup ──────────────────────────────────────────────────────
  if (args.setup || isFirstRun()) {
    await _runSetupWizard();
    if (!fs.existsSync(getConfigPath())) {
      process.stderr.write("[clawd] Setup did not create clawd.json. Exiting.\n");
      process.exit(1);
    }
  }

  // ── 2. Load environment + config ────────────────────────────────────────────
  loadEnv();
  const config = loadConfig();

  if (args.port) {
    overrideApiPort(args.port);
    config.api.port = args.port;
  }
  if (args.host) {
    config.api.host = args.host;
  }

  logger.setLevel(config.log?.level ?? "info");

  // ── 3. Boot AgentRegistry (loads every agent from system.json) ───────────────
  const registry = new AgentRegistry();
  await registry.start(process.cwd());

  const admin = registry.admin;
  if (admin) {
    logger.info(`[clawd] Admin OS agent: "${admin.agent.id}" (${admin.agent.provider}/${admin.agent.model})`);
  } else {
    logger.warn("[clawd] No Admin OS agent loaded — some API endpoints will be unavailable");
  }

  // ── 4. Register shutdown hooks ───────────────────────────────────────────────
  setupShutdown(() => {
    registry.stop().catch(() => {});
  });

  // ── 5. Start the API channel ─────────────────────────────────────────────────
  const api = new ApiChannel();
  logger.info(`[clawd] Starting API server on ${config.api.host ?? "0.0.0.0"}:${config.api.port ?? 3141}`);

  try {
    await api.run(admin?.agent ?? null, registry);
  } catch (err: any) {
    logger.error(`[clawd] API server error: ${err.message}`);
    await registry.stop();
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[clawd] Fatal: ${err.message}\n${err.stack ?? ""}\n`);
  process.exit(1);
});
