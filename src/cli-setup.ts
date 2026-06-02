// src/cli-setup.ts — First-run setup wizard
//
// Pure OpenClaw-compatible setup.
//
// Changes:
//   - Default agent no longer includes customTools: ["web_search", "web_fetch", ...]
//     (field removed from AgentConfig entirely).
//   - Wizard tip now directs users to install web-search skill via:
//     clawd skills install badlogic/pi-mono/packages/coding-agent/skills/web-search
//
// Team refactor fixes:
//   [SETUP-FIX-1] Removed "teams" from the ~/.clawd/ directory creation list.
//
//   [SETUP-FIX-2] Removed the "clawd teams import ./my-team/" line from the
//                 post-setup summary. That command no longer exists.
//
// Single-instance refactor:
//   [SETUP-FIX-3] Removed imports from ./instance/paths.js, ./instance/manager.js,
//                 ./instance/registry.js — these modules were deleted as part of
//                 the single-agent architecture. The multi-instance registry setup
//                 block and its console.log lines are also removed.

import chalk         from "chalk";
import * as fs       from "fs";
import * as path     from "path";
import * as os       from "os";
import * as readline from "readline";
import {
  loadConfig, saveConfig,
  CONFIG_PATH, CLAWD_DIR, CLAWD_AGENTS_DIR, CLAWD_MODELS_PATH,
  DEFAULT_AGENT_ID,
} from "./config.js";
import { scaffoldAgent, listAgentIds } from "./agent/loader.js";
import type { AgentConfig }    from "./agent/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function _rl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}
function _asker(rl: readline.Interface) {
  return (q: string, def = "") => new Promise<string>(r =>
    rl.question(
      chalk.cyan(`  ${q}`) + (def ? chalk.dim(` [${def}]`) : "") + ": ",
      a => r(a.trim() || def),
    ),
  );
}
function _confirmer(rl: readline.Interface) {
  return (q: string, def = false) => new Promise<boolean>(r =>
    rl.question(chalk.cyan(`  ${q}`) + chalk.dim(` (${def ? "Y/n" : "y/N"})`) + ": ", a => {
      const t = a.trim().toLowerCase();
      r(t ? t === "y" || t === "yes" : def);
    }),
  );
}

// ── Main wizard ───────────────────────────────────────────────────────────────

export async function _runSetupWizard(): Promise<void> {
  const rl      = _rl();
  const ask     = _asker(rl);
  const confirm = _confirmer(rl);
  const config  = loadConfig();

  console.log("\n" + chalk.bold.cyan("🦞 clawd setup wizard") + "\n");
  console.log(chalk.dim(
    "Sets up the ~/.clawd/ directory and the primary agent.\n",
  ));

  const userName      = await ask("Your name",      os.userInfo().username);
  const assistantName = await ask("Assistant name", "Clawd");

  const existingKey = process.env["ANTHROPIC_API_KEY"] || process.env["GROQ_API_KEY"];
  let apiKey = "";
  if (!existingKey) {
    apiKey = await ask("API key (Anthropic — leave blank to configure later via .env)", "");
  } else {
    console.log(chalk.dim("  (API key found in environment — skipping)"));
  }

  const provider = await ask("Default provider (anthropic/groq/openai/…)", config.defaults.provider);
  const model    = await ask("Default model",                               config.defaults.model);

  const enableApi = await confirm("Enable HTTP API server?", false);
  let apiPort  = 3141;
  let apiToken = "";
  if (enableApi) {
    apiPort  = parseInt(await ask("API port", "3141"), 10);
    apiToken = await ask("API auth token (blank = no auth)", "");
  }

  // ── 1. ~/.clawd/ structure ────────────────────────────────────────────────

  console.log("\n" + chalk.bold("Setting up ~/.clawd/…"));

  // [SETUP-FIX-1] "teams" removed — the Team subsystem was removed in the
  // refactoring. Creating ~/.clawd/teams/ would mislead users.
  for (const d of ["agents", "skills", "staged"]) {
    fs.mkdirSync(path.join(CLAWD_DIR, d), { recursive: true });
    console.log(chalk.green(`  ✓ ${d}/`));
  }

  if (apiKey) {
    const envPath    = path.join(CLAWD_DIR, ".env");
    const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
    const envVar     = provider === "groq" ? "GROQ_API_KEY" : "ANTHROPIC_API_KEY";
    if (!envContent.includes(envVar)) {
      fs.appendFileSync(envPath, `\n${envVar}=${apiKey}\n`, "utf-8");
      console.log(chalk.green(`  ✓ ${envVar} → .env`));
    }
  }

  if (!fs.existsSync(CLAWD_MODELS_PATH)) {
    const modelsJson = {
      providers: {
        anthropic: {
          baseUrl: "https://api.anthropic.com",
          apiKey:  "ANTHROPIC_API_KEY",
          models: [
            { id: "claude-opus-4-6",          name: "Claude Opus 4.6"  },
            { id: "claude-sonnet-4-6",         name: "Claude Sonnet 4.6" },
            { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
          ],
        },
        groq: {
          baseUrl: "https://api.groq.com/openai/v1",
          apiKey:  "GROQ_API_KEY",
          models: [
            { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile" },
          ],
        },
      },
    };
    fs.writeFileSync(CLAWD_MODELS_PATH, JSON.stringify(modelsJson, null, 2) + "\n", "utf-8");
    console.log(chalk.green("  ✓ models.json"));
  } else {
    console.log(chalk.dim("  · models.json (exists)"));
  }

  // Pure OpenClaw agent — no customTools field.
  // Web search / fetch capabilities are provided by installing skills:
  //   clawd skills install badlogic/pi-mono/packages/coding-agent/skills/web-search
  const defaultAgentCfg: AgentConfig = {
    name:           assistantName,
    description:    `${userName}'s personal AI assistant`,
    provider,
    model,
    tools:          "full",
    persistent:     true,
    maxTurns:       config.defaults.maxTurns,
    timeoutSeconds: config.defaults.timeoutSeconds,
    thinkingLevel:  config.defaults.thinkingLevel,
  };
  scaffoldAgent(DEFAULT_AGENT_ID, defaultAgentCfg, false);
  console.log(chalk.green(`  ✓ Default agent "${assistantName}" (${DEFAULT_AGENT_ID})`));

  // ── Default agent roles (OpenCode-style) ──────────────────────────────────
  // Scaffold a standard set of subagent roles that can be spawned via the agent tool.
  const defaultRoles: Array<{ id: string; name: string; desc: string; tools: AgentConfig["tools"] }> = [
    {
      id:    "explore",
      name:  "Explore",
      desc:  "Specialized codebase exploration agent. Fast, thorough, read-only.",
      tools: "observe",
    },
    {
      id:    "technical-writer",
      name:  "Technical Writer",
      desc:  "Specialized documentation agent. Writes clear, well-structured docs.",
      tools: "standard",
    },
    {
      id:    "qa-engineer",
      name:  "QA Engineer",
      desc:  "Specialized testing agent. Writes and runs tests, finds bugs.",
      tools: "standard",
    },
    {
      id:    "lead-architect",
      name:  "Lead Architect",
      desc:  "Specialized architecture agent. Designs system structure, reviews code.",
      tools: "standard",
    },
    {
      id:    "software-engineer",
      name:  "Software Engineer",
      desc:  "General-purpose engineering agent. Writes and refactors code.",
      tools: "full",
    },
  ];

  const existingIds = listAgentIds();
  let rolesScaffolded = 0;
  for (const role of defaultRoles) {
    if (existingIds.includes(role.id)) continue;
    const roleConfig: AgentConfig = {
      name:           role.name,
      description:    role.desc,
      provider,
      model,
      tools:          role.tools,
      persistent:     false,
      maxTurns:       config.defaults.maxTurns,
      timeoutSeconds: config.defaults.timeoutSeconds,
      thinkingLevel:  role.id === "lead-architect" ? "high" : config.defaults.thinkingLevel,
    };
    scaffoldAgent(role.id, roleConfig, false);
    rolesScaffolded++;
  }
  if (rolesScaffolded > 0) {
    console.log(chalk.green(`  ✓ ${rolesScaffolded} default agent roles scaffolded`));
  } else {
    console.log(chalk.dim("  · Default agent roles (already exist)"));
  }

  const userMd = path.join(CLAWD_AGENTS_DIR, DEFAULT_AGENT_ID, "USER.md");
  if (!fs.existsSync(userMd)) {
    fs.writeFileSync(
      userMd,
      `# User Profile\n\nName: ${userName}\n\n## Preferences\n- (Add here)\n\n## Address\n- Call me: ${userName}\n`,
      "utf-8",
    );
  }

  config.defaults.provider = provider;
  config.defaults.model    = model;
  config.activeAgent       = DEFAULT_AGENT_ID;
  config.api.enabled       = enableApi;
  config.api.port          = apiPort;
  if (apiToken) config.api.auth = { token: apiToken };
  saveConfig(config);
  console.log(chalk.green("  ✓ clawd.json"));

  // ── 2. Summary ────────────────────────────────────────────────────────────

  // [SETUP-FIX-2] Removed "clawd teams import ./my-team/" — teams were removed.
  // [SETUP-FIX-3] Removed multi-instance registry setup block.
  console.log(
    "\n" + chalk.bold.green("✓ Setup complete!\n") +
    chalk.dim("  1. Set API key:        export ANTHROPIC_API_KEY=sk-ant-...\n") +
    chalk.dim("  2. Start:              clawd start\n") +
    chalk.dim("  3. Browse skills:      clawd skills hub\n") +
    chalk.dim("  4. Install web-search: clawd skills install badlogic/pi-mono/packages/coding-agent/skills/web-search\n") +
    (enableApi ? chalk.dim("  5. Start API only:     clawd serve\n") : "") + "\n",
  );

  rl.close();
}