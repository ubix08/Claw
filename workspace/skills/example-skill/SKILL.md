---
name: hello-clawd
description: Example skill demonstrating the SKILL.md format. Greets the user with a custom message.
user-invocable: true
metadata: {"openclaw": {"emoji": "👋"}}
---

# hello-clawd

This is an example skill for clawd. It demonstrates the OpenClaw-compatible SKILL.md format.
Skills teach the agent how to use specific CLIs, APIs, or workflows.

## When to use

Use this skill when the user asks for a demonstration of the skills system,
or when you want to test that skills are loading correctly.

## Usage

```bash
echo "Hello from clawd skills! $(date)"
```

## Notes

- Replace this file with real skills from ClawHub (clawhub.com)
- Or write your own following this format
- The `metadata.openclaw.requires` field gates skill eligibility
- Skills with `requires.bins` are only shown when the binary is on PATH
- Skills with `requires.env` are only shown when the env var is set

## Adding real skills

Drop a folder with a SKILL.md into:
  - `workspace/skills/<skill-name>/SKILL.md` (per-session)
  - `~/.clawd/skills/<skill-name>/SKILL.md` (shared across sessions)

Or install from ClawHub:
  - Visit https://clawhub.com
  - Download a skill folder
  - Drop it into workspace/skills/
