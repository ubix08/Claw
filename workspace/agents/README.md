# Custom Agent Roles

Place custom agent role JSON files in this directory.

Each file defines a named agent that the orchestrator (and the main assistant) can delegate tasks to.

## File format

`<n>.json`:

```json
{
  "name": "security-auditor",
  "description": "Specialized agent for finding security vulnerabilities in code",
  "tools": "readonly",
  "persistent": false,
  "maxTurns": 25,
  "timeoutSeconds": 180,
  "systemPromptSuffix": "## Your Role\n\nYou are a security expert. Focus on: injection flaws, auth issues, exposed secrets, insecure deps. Rate findings: Critical / High / Medium / Low."
}
```

## Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | (filename) | Unique identifier. Lowercase, `a-z0-9_-` only. |
| `description` | string | "Custom agent" | Shown in listings and tool help |
| `tools` | string | "coding" | `full`, `coding`, `readonly`, `bash`, `none` |
| `persistent` | bool | false | Persist session to JSONL between calls |
| `maxTurns` | number | 30 | Max LLM turns per call (1-200) |
| `timeoutSeconds` | number | 180 | Timeout per call (5-3600) |
| `provider` | string | (root config) | Override LLM provider |
| `model` | string | (root config) | Override model |
| `workspace` | string | (root workspace) | Override workspace directory |
| `systemPromptPrefix` | string | — | Injected before workspace files |
| `systemPromptSuffix` | string | — | Injected after workspace files (use for role) |
| `tags` | string[] | [] | Grouping tags |

## Tool sets

- `full` — read, write, edit, bash, grep, find, ls
- `coding` — read, write, edit, bash  
- `readonly` — read, grep, find, ls (cannot modify files)
- `bash` — read, bash
- `none` — no tools (pure text reasoning)

## Built-in roles

The following roles are always available without any JSON file:
`researcher`, `coder`, `reviewer`, `planner`, `writer`, `tester`

Override a built-in by creating a JSON file with the same name.

## CLI

```bash
clawd agents list                          # list all roles
clawd agents show researcher               # show full config
clawd agents run --agent researcher "..."  # run a role directly
clawd agents create my-role                # interactive wizard
```

## From the assistant

Once running `clawd start`, you can tell the assistant:

- "Use the researcher agent to find all TODO comments in the codebase"
- "Run the coder and reviewer agents in parallel on auth.ts"
- "Run a plan → implement → review pipeline on the feature I described"
