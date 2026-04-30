# TOOLS.md — Worker Agent Tool Routing Guide

This file defines how worker agents should select and use tools.
It is injected into the worker system prompt when `verbosity: "explicit"` is set.

---

## Core Principle: Bash First

**Always prefer `bash` for:**
- Reading files (`cat`, `head`, `grep`, `find`, `tree`)
- Compiling and type-checking (`tsc --noEmit`, `go build`, `cargo check`)
- Running tests (`npm test`, `pytest`, `go test ./...`)
- Moving, copying, creating directories (`mkdir -p`, `cp`, `mv`)
- Searching for patterns (`grep -r`, `rg`, `ag`)

**Use structured tools only for:**
- `web_search` — fetching live external information
- `lsp_diagnostics` — TypeScript diagnostics with cursor context

---

## Bash — Primary Tool

Use for everything file-related.

### Positive examples:

```bash
# Read a file before modifying it
cat src/auth/middleware.ts

# Find all route definitions
grep -r "router\." src/routes/ --include="*.ts" -n

# Check TypeScript errors before declaring done
tsc --noEmit 2>&1 | head -50

# Run only the relevant test file
npm test -- --testPathPattern oauth
```

### Negative examples (never do these):

- Do NOT use `web_search` to find what a file contains — use `cat` or `grep`.
- Do NOT use `web_search` to check if a function exists in the codebase — use `grep -r`.
- Do NOT skip running `tsc --noEmit` after writing TypeScript — always verify.
- Do NOT use `bash` to fetch URLs that require authentication — use `web_search` or `lsp_diagnostics`.
- Do NOT run the full test suite when you changed one file — use `--testPathPattern`.

---

## web_search — Live External Information Only

Use when you need current documentation, package versions, or external APIs
that cannot be found in the codebase.

### Positive examples:
- "passport-oauth2 options object TypeScript types"
- "express-session cookie options secure flag meaning"
- "npm @types/passport-oauth2 version latest"

### Negative examples (never do these):

- Do NOT use `web_search` to find how existing project code works — use `cat` and `grep`.
- Do NOT use `web_search` to check if a dependency is installed — use `cat package.json` or `ls node_modules/`.
- Do NOT use `web_search` to read local configuration — use `cat .env.example` or `cat tsconfig.json`.
- Do NOT use `web_search` to look for test framework syntax if the project already has tests — use `grep -r "describe\|it(" tests/`.

---

## lsp_diagnostics — TypeScript Errors with File Context

Use when you need to see TypeScript errors with their precise locations
and when `tsc --noEmit` output is not enough context.

### Positive examples:
- After writing a complex generic type, check if usage sites have errors
- When a function signature change might have downstream effects not caught by tsc alone

### Negative examples (never do these):

- Do NOT use `lsp_diagnostics` as a substitute for running `tsc --noEmit` — run tsc first.
- Do NOT use `lsp_diagnostics` on files you haven't modified — check the changed file only.
- Do NOT use `lsp_diagnostics` to find all files using a symbol — use `grep -r` instead.

---

## NOTES.md — Required Scratchpad

Before touching any source file, write your plan to `NOTES.md` in your workspace.

Structure:
```markdown
# Plan

## What I understand
<what the brief asks for>

## Files I need to read
- src/auth/middleware.ts — understand current auth flow
- src/routes/index.ts — see where middleware is applied

## Steps
1. Read existing auth files
2. Install required package
3. Write the implementation
4. Run tsc, fix errors
5. Confirm contract is satisfied
```

### Why this matters:
Models that plan before acting make 40% fewer backtracking moves.
The NOTES.md is your working memory — use it.

---

## Anti-patterns that cause step failures

| Anti-pattern | Why it fails | Correct approach |
|---|---|---|
| Writing code without reading existing code first | Creates conflicts, duplicate logic | `cat` relevant files first |
| Declaring "done" with tsc errors | Contract checks will fail | Always run `tsc --noEmit` last |
| Rewriting the whole file for a one-function change | Breaks unrelated logic | Use `str_replace` or targeted `sed` |
| Running `npm install` without checking `package.json` first | May install wrong version | `cat package.json` then install |
| Ignoring stderr in bash output | Hides real errors | Always read stderr before next action |
| Creating a new file when one already exists | Creates duplicates | `find . -name "*.ts"` first |
