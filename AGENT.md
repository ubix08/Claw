# Claw — AI-OS Framework

This project is an agent operating system (AI-OS): a runtime and framework for
building, running, and orchestrating multi-agent systems from self-contained
agent folders.

## Architecture

Every agent is a **directory** containing:
- `config.json` — agent configuration (model, provider, tools, etc.)
- `SOUL.md` — identity, personality, mission
- `AGENT.md` — agent name, role
- `IDENTITY.md`, `USER.md`, `TOOLS.md` — additional identity files
- `skills/`, `memory/`, `sessions/`, `workspace/` — agent subdirectories

The runtime discovers agents by scanning project-level folders:
- `<project>/agents/<name>/` — project agent folders
- `.clawd/agents/<name>/` — clawd-managed agents
- `.claude/agents/<name>/` — Claude Code compat
- `.opencode/agents/<name>/` — OpenCode compat

## Current Phase

Refactoring from a Claude-Code-parity coding assistant to a general AI-OS platform.

### Phase 0 — Done (current)
- Removed coding-assistant-isms from Agent runtime
- Removed project-discovery from Agent init (app-level concern)
- Removed commands/AGENTS.md parsing
- Renamed tool sets: `coding`→`standard`, `readonly`→`observe`
- Stripped CA baggage from project-discovery.ts (now only discovers agent folders)
- Removed verbose tool examples, Todo.md injection, work mode, prior outputs

### Phase 1 — Next
- Make tools modular/loadable from agent config
- Remove coding-specific tools from core sets (git, grep, LSP, notebook-edit, tasks)
- Everything becomes optional/skill

### Phase 2  
- Project discovery → pure agent folder discovery

### Phase 3
- Orchestration → system definitions (system.json)
- Replace hardcoded plan→build→test→verify with generic step types

### Phase 4-6
- CLI/API → OS management interface
- Setup → system initialization
- Rename/reframe whole project (clawd → aios)

## Key Modules

| Module | Purpose |
|--------|---------|
| `src/agent/agent.ts` | Agent runtime (wraps pi-agent-core) |
| `src/agent/loader.ts` | Agent loading/scaffolding |
| `src/agent/workspace.ts` | Workspace identity file management |
| `src/agent/discovery.ts` | Agent template/definition discovery |
| `src/core/project-discovery.ts` | Agent folder discovery from project tree |
| `src/tools/index.ts` | Core tool factory (read, write, edit, bash, etc.) |
| `src/tools/agent.ts` | Subagent spawning tool |
| `src/channels/api.ts` | HTTP API server |
| `src/cli.ts` | CLI entry point |
| `src/cli-setup.ts` | First-run setup wizard |
