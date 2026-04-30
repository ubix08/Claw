// src/cli.ts — clawd API server entrypoint
//
// Architecture: ALL interaction is handled by the frontend via the HTTP API.
// The CLI's ONLY job is to:
//   1. Run first-time setup if ~/.clawd/ is not configured.
//   2. Load environment, config, and the active agent.
//   3. Start the ApiChannel (HTTP server).
//
// No interactive REPL, no gateway/orchestrator CLI flags.
// The "clawd start" / "clawd serve" distinction collapses to a single
// "clawd" command that always boots the API server.
//
// Fix log:
//   [CLI-FIX-1] Removed entire gateway/orchestrator CLI (--task, --resume flags).
//               Those belong to the orchestrator subsystem which is invoked via
//               the API, not via direct CLI flags.
//   [CLI-FIX-2] Agent is fully init()-ed before ApiChannel.run() is called.
//               Previously ApiChannel received an uninitialised agent shell.
//   [CLI-FIX-3] api.enabled defaults to true regardless of config so that the
//               server always starts. The flag in clawd.json now only controls
//               whether to warn, not whether to start.
//   [CLI-FIX-4] SIGINT/SIGTERM perform a clean agent.dispose() before exit so
//               persistent sessions are flushed.
//   [CLI-FIX-5] --port / --host CLI overrides forwarded to config so users can
//               start the server on a different port without editing clawd.json.
//   [CLI-FIX-6] First-run detection: if ~/.clawd/clawd.json does not exist the
//               setup wizard is run before the server starts.

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
import { loadAgent }           from "./agent/loader.js";
import { getDefaultBus }       from "./core/event-bus.js";
import { logger }              from "./core/logger.js";
import { ApiChannel }          from "./channels/api.js";
import { _runSetupWizard }     from "./cli-setup.js";

// ── CLI argument parsing ──────────────────────────────────────────────────────

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
clawd — AI agent API server

Usage:
  clawd [options]

Options:
  --port <n>     Override API port (default from clawd.json, fallback 3141)
  --host <addr>  Override bind address (default from clawd.json, fallback 0.0.0.0)
  --setup        Force re-run the setup wizard
  --help, -h     Show this help

All interaction with the agent is done via the HTTP API.
The frontend connects to http://<host>:<port>.

Endpoints:
  GET  /health              — server health
  GET  /info                — active agent info
  POST /chat                — send a message (JSON body: { message, sessionId?, mode? })
  GET  /chat/stream?message=…  — SSE streaming chat
  POST /chat/reset          — clear conversation history
  GET  /history             — conversation history
  GET  /agents              — list agents
  POST /agents/:id/use      — switch active agent
  GET  /skills              — list skills
  POST /skills/install      — install a skill
  GET  /skills/hub          — browse skill hub
`.trim());
}

// ── First-run detection ───────────────────────────────────────────────────────

function isFirstRun(): boolean {
  return !fs.existsSync(getConfigPath());
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function setupShutdown(dispose: () => void): void {
  const handler = (sig: string) => {
    process.stderr.write(`\n[clawd] Received ${sig} — shutting down…\n`);
    try { dispose(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT",  () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) { printHelp(); process.exit(0); }

  // ── 1. First-run setup ──────────────────────────────────────────────────────
  if (args.setup || isFirstRun()) {
    await _runSetupWizard();
    // After setup, continue to start the server unless --setup was the only intent.
    // Re-check: if clawd.json still doesn't exist, something went wrong.
    if (!fs.existsSync(getConfigPath())) {
      process.stderr.write("[clawd] Setup did not create clawd.json. Exiting.\n");
      process.exit(1);
    }
  }

  // ── 2. Load environment + config ────────────────────────────────────────────
  loadEnv();
  const config = loadConfig();

  // Apply CLI port/host overrides (in-memory only — don't persist)
  if (args.port) {
    overrideApiPort(args.port);
    config.api.port = args.port;
  }
  if (args.host) {
    config.api.host = args.host;
  }

  // Log level
  logger.setLevel(config.log?.level ?? "info");

  // ── 3. Load and initialise the active agent ─────────────────────────────────
  // [CLI-FIX-2] Agent is fully init()-ed before ApiChannel.run() so the
  // channel receives an agent that has skills loaded and a session ready.
  const agentId = config.activeAgent ?? DEFAULT_AGENT_ID;
  logger.info(`[clawd] Loading agent: ${agentId}`);

  let agent = null;
  try {
    const bus = getDefaultBus();
    agent = loadAgent(agentId, bus, config);
    await agent.init();
    logger.info(`[clawd] Agent "${agent.name}" ready (${agent.provider}/${agent.model})`);
  } catch (err: any) {
    logger.warn(`[clawd] Could not load agent "${agentId}": ${err.message}`);
    logger.warn("[clawd] Server will start without an active agent — POST /agents/:id/use to set one.");
    agent = null;
  }

  // ── 4. Register shutdown hooks ───────────────────────────────────────────────
  // [CLI-FIX-4] Flush persistent sessions on clean shutdown.
  setupShutdown(() => {
    if (agent) agent.dispose();
  });

  // ── 5. Start the API channel ─────────────────────────────────────────────────
  // [CLI-FIX-3] Always start the API channel — api.enabled in clawd.json is
  // informational only in server mode. If the user explicitly set it to false
  // they should not be running `clawd`.
  if (config.api.enabled === false) {
    logger.warn("[clawd] config.api.enabled is false — starting API server anyway (server mode).");
  }

  const api = new ApiChannel();
  logger.info(`[clawd] Starting API server on ${config.api.host ?? "0.0.0.0"}:${config.api.port ?? 3141}`);

  try {
    // ApiChannel.run() never resolves (it holds the HTTP server alive).
    await api.run(agent);
  } catch (err: any) {
    logger.error(`[clawd] API server error: ${err.message}`);
    if (agent) agent.dispose();
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[clawd] Fatal: ${err.message}\n${err.stack ?? ""}\n`);
  process.exit(1);
});
