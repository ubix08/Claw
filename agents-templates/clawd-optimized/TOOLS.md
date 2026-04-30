# Tool Guidelines — When & How to Use Each Tool

**You have 22 tools.** This file teaches you when to use each one, how to combine them, and what to do when they fail.

---

## 📋 Tool Inventory

### **File Operations (5)**
- `read` - Read files, directories, images, notebooks
- `write` - Create new files  
- `edit` - Replace text in existing files
- `bash` - Execute shell commands
- `notebook_edit` - Edit Jupyter notebook cells

### **Search & Discovery (2)**
- `glob` - Fast file pattern matching
- `grep` - Fast code content search (ripgrep)

### **Code Intelligence (1)**
- `lsp_query` - LSP features (definition, references, hover, diagnostics)

### **Task Management (5)**
- `task_create` - Create task items
- `task_get` - Get task details
- `task_list` - List all tasks
- `task_update` - Update task status
- `task_stop` - Stop background tasks

### **MCP Integration (3)**
- `list_mcp_resources` - List resources from MCP servers
- `read_mcp_resource` - Read MCP resource content
- `tool_search` - Search for MCP tools on-demand

### **Workflow Automation (3)**
- `cron_create` - Schedule recurring tasks
- `cron_delete` - Remove cron jobs
- `cron_list` - List scheduled crons

### **Web Tools (2)**
- `web_search` - Search the web (Serper API)
- `web_fetch` - Fetch web page content

### **Agent Orchestration (1)**
- `agent` - Spawn subagents for parallel work

---

## 🎯 Tool Selection Matrix

### **"I need to find files"**

```
Pattern-based search?
├─ YES → glob({ pattern: "**/*.ts" })
│        Fast, supports wildcards, sorted by mtime
│
└─ NO → Complex conditions?
         └─ YES → bash({ command: "find src -name '*.ts' -mtime -7" })
                  More flexible but slower
```

**Examples:**

```typescript
// Find all TypeScript files
glob({ pattern: "src/**/*.ts" })

// Find config files anywhere
glob({ pattern: "**/*config*.{json,yaml,yml}" })

// Find recently modified files
glob({ pattern: "src/**/*.ts" })  // Already sorted by mtime!

// Complex: files modified in last 7 days
bash({ command: "find . -name '*.ts' -mtime -7" })
```

**Never:**
- ❌ `bash({ command: "ls -R" })` - Use glob instead
- ❌ Reading directories manually - Use glob
- ❌ `bash({ command: "find" })` for simple patterns - Use glob

---

### **"I need to search code content"**

```
What are you searching for?
│
├─ Symbol (function/class/variable)?
│  └─ Use lsp_query({ action: "definition" })
│     or lsp_query({ action: "references" })
│     Precise, understands code structure
│
├─ Text pattern / regex?
│  └─ Use grep({ pattern: "function\\s+\\w+" })
│     Fast (ripgrep), full regex, context flags
│
└─ Specific file content?
   └─ Use read({ path: "file.ts" })
      Direct access, line numbers
```

**Examples:**

```typescript
// Find all files containing "parseConfig"
grep({ 
  pattern: "parseConfig",
  output_mode: "files_with_matches"
})

// Find function definitions with context
grep({ 
  pattern: "function\\s+\\w+",
  output_mode: "content",
  "-B": 2,  // 2 lines before
  "-A": 5   // 5 lines after
})

// Case-insensitive search
grep({ 
  pattern: "error",
  "-i": true
})

// Search specific file types
grep({ 
  pattern: "import.*React",
  type: "js"  // Only .js files
})

// Multiline search
grep({ 
  pattern: "interface\\s+\\w+\\s*\\{[\\s\\S]*?\\}",
  multiline: true
})
```

**Performance:**
- grep is 10-100x faster than bash grep
- Use `output_mode: "files_with_matches"` first (fastest)
- Then use `output_mode: "content"` for details
- Use `head_limit` to avoid massive results

**Never:**
- ❌ `bash({ command: "grep -r" })` - Use grep tool
- ❌ Reading all files to search - Use grep
- ❌ Bash loops with grep - Use grep once

---

### **"I need to navigate code"**

```
What do you need?
│
├─ "Where is this function defined?"
│  └─ lsp_query({ action: "definition", path, line, column })
│
├─ "Where is this function used?"
│  └─ lsp_query({ action: "references", path, line, column })
│
├─ "What is the type of this variable?"
│  └─ lsp_query({ action: "hover", path, line, column })
│
├─ "What errors are in this file?"
│  └─ lsp_query({ action: "diagnostics", path })
│
└─ "LSP unavailable?"
   └─ Fallback to grep({ pattern: "functionName" })
```

**Workflow: Navigate to Definition**

```typescript
// Step 1: Find files containing symbol
grep({ 
  pattern: "MyClass",
  output_mode: "files_with_matches"
})
// Result: src/types.ts, src/utils.ts, tests/test.ts

// Step 2: Get exact definition location
lsp_query({
  action: "definition",
  path: "src/types.ts",  // Most likely file
  line: 10,               // From grep result
  column: 5
})
// Result: src/types.ts:45

// Step 3: Read definition with context
read({
  path: "src/types.ts",
  offset: 40,  // Definition line - 5
  limit: 20    // Show surrounding code
})
```

**Workflow: Find All Usages**

```typescript
// Step 1: Go to definition
lsp_query({
  action: "definition",
  path: "src/file.ts",
  line: 10,
  column: 5
})

// Step 2: Find all references from definition
lsp_query({
  action: "references",
  path: "src/types.ts",  // Definition location
  line: 45,
  column: 13
})
// Result: 12 references across 5 files

// Step 3: Read key usage locations
read({ path: "src/main.ts", offset: 100, limit: 10 })
read({ path: "src/utils.ts", offset: 50, limit: 10 })
```

**When LSP Unavailable:**

```typescript
// Fallback to grep for definition
grep({ 
  pattern: "class MyClass\\s*\\{",
  output_mode: "content"
})

// Fallback to grep for usages
grep({
  pattern: "MyClass",
  output_mode: "content",
  "-B": 1,
  "-A": 1
})
```

---

### **"I need to edit code"**

```
What kind of edit?
│
├─ Targeted string replacement?
│  └─ edit({ path, oldText, newText })
│     Safe, atomic, fails if ambiguous
│
├─ Bulk rename/replace?
│  └─ edit({ path, oldText, newText, replace_all: true })
│     Replaces all occurrences
│
├─ Jupyter notebook cell?
│  └─ notebook_edit({ path, cell_index, new_source })
│     Preserves outputs and metadata
│
└─ New file?
   └─ write({ path, content })
      Creates file and directories
```

**Best Practice: Always Read Before Edit**

```typescript
// WRONG: Edit without reading
edit({
  path: "src/file.ts",
  oldText: "const x = 1",
  newText: "const x = 2"
})
// What if there are multiple matches?
// What if the line doesn't exist?

// RIGHT: Read first
read({ path: "src/file.ts" })
// See the exact content, line numbers, context

// Then edit with precise oldText
edit({
  path: "src/file.ts",
  oldText: "  const x = 1;\n  return x;",  // Multi-line for uniqueness
  newText: "  const x = 2;\n  return x;"
})
```

**Handling Edit Failures**

```typescript
// Edit fails: "oldText not found"
edit({ path: "file.ts", oldText: "foo", newText: "bar" })
// ❌ Error

// Solution: Read the file
read({ path: "file.ts" })
// Oh, it's actually "  foo" with spaces

// Retry with correct whitespace
edit({ 
  path: "file.ts",
  oldText: "  foo",
  newText: "  bar"
})
// ✅ Success

// Edit fails: "matches 3 times"
edit({ path: "file.ts", oldText: "x", newText: "y" })
// ❌ Error: ambiguous

// Solution: Add more context
edit({
  path: "file.ts",
  oldText: "function test() {\n  x\n}",
  newText: "function test() {\n  y\n}"
})
// ✅ Success (unique match)

// Or use replace_all if intentional
edit({
  path: "file.ts",
  oldText: "x",
  newText: "y",
  replace_all: true
})
// ✅ Replaced 3 occurrences
```

**Notebook Editing**

```typescript
// Step 1: Read notebook to see cell indices
read({ path: "analysis.ipynb" })
// Shows: Cell 0 (markdown), Cell 1 (code), Cell 2 (code)

// Step 2: Edit specific cell
notebook_edit({
  path: "analysis.ipynb",
  cell_index: 1,
  new_source: "print('Updated code')",
  cell_type: "code"  // optional
})
// ✅ Cell 1 updated, outputs cleared
```

---

### **"I need to check for errors"**

```
What kind of errors?
│
├─ Type errors, linting issues?
│  └─ lsp_query({ action: "diagnostics", path })
│     Real-time from LSP server
│
├─ Build errors?
│  └─ bash({ command: "npm run build" })
│     Full build output
│
└─ Runtime errors?
   └─ bash({ command: "npm test" })
      Test suite output
```

**Workflow: Check and Fix Errors**

```typescript
// Step 1: Get diagnostics
lsp_query({ 
  action: "diagnostics",
  path: "src/file.ts"
})
// Result: 3 errors, 2 warnings

// Step 2: Read error locations
read({
  path: "src/file.ts",
  offset: 44,  // Error at line 45
  limit: 10
})

// Step 3: Fix errors
edit({
  path: "src/file.ts",
  oldText: "...",
  newText: "..."
})

// Step 4: Verify fix
lsp_query({
  action: "diagnostics",
  path: "src/file.ts"
})
// Result: 0 errors ✅
```

---

### **"I need to track work progress"**

```
Multi-step task?
│
├─ Create plan
│  └─ task_create({ 
│       title: "Implement feature X",
│       subtasks: ["Step 1", "Step 2", "Step 3"]
│     })
│
├─ Update as you work
│  └─ task_update({
│       id: "task-123",
│       status: "in_progress"
│     })
│
├─ Check status
│  └─ task_list({})
│
└─ Mark complete
   └─ task_update({
        id: "task-123",
        status: "completed"
      })
```

**Example: Feature Implementation**

```typescript
// Step 1: Create main task
task_create({
  title: "Add user authentication",
  description: "Implement JWT-based auth",
  subtasks: [
    "Create auth middleware",
    "Add login endpoint",
    "Add logout endpoint",
    "Add tests"
  ]
})
// Returns: { id: "task-123" }

// Step 2: Start work
task_update({
  id: "task-123",
  status: "in_progress"
})

// Step 3: Track progress
// (Implement auth middleware...)
task_update({
  id: "task-123",
  description: "✅ Auth middleware done\n⏳ Login endpoint in progress"
})

// Step 4: Complete
task_update({
  id: "task-123",
  status: "completed"
})

// Step 5: Review all tasks
task_list({})
```

---

### **"I need to schedule recurring work"**

```
Need to run something periodically?
│
├─ Create cron job
│  └─ cron_create({
│       schedule: "0 * * * *",  // Every hour
│       command: "npm run check-updates",
│       description: "Check for dependency updates"
│     })
│
├─ View scheduled jobs
│  └─ cron_list({})
│
└─ Remove job
   └─ cron_delete({ id: "cron-123" })
```

**Cron Schedule Examples**

```typescript
// Every 5 minutes
cron_create({
  schedule: "*/5 * * * *",
  command: "npm run health-check"
})

// Every day at 9 AM
cron_create({
  schedule: "0 9 * * *",
  command: "npm run daily-report"
})

// Every Monday at 8 AM
cron_create({
  schedule: "0 8 * * 1",
  command: "npm run weekly-cleanup"
})

// Every 15 minutes during work hours (9-5)
cron_create({
  schedule: "*/15 9-17 * * *",
  command: "npm run status-sync"
})
```

---

### **"I need external data"**

```
What kind of data?
│
├─ From MCP servers (GitHub, databases, APIs)?
│  ├─ List available resources
│  │  └─ list_mcp_resources({ server: "github" })
│  │
│  ├─ Read specific resource
│  │  └─ read_mcp_resource({ 
│  │       uri: "github://repos/user/repo"
│  │     })
│  │
│  └─ Find MCP tools
│     └─ tool_search({ query: "github issue" })
│
└─ From the web?
   ├─ Search query → web_search({ query: "..." })
   └─ Fetch page → web_fetch({ url: "..." })
```

---

### **"I need to parallelize work"**

```
Independent tasks?
│
└─ Spawn subagent
   └─ agent({
        description: "Explore authentication code",
        prompt: "Find all files related to auth, summarize the approach",
        subagent_type: "explore"  // Read-only, fast
      })
```

**When to Use Subagents:**

✅ **Good:**
- Exploring large codebases
- Independent research
- Parallel analysis
- When main context is getting full

❌ **Avoid:**
- Simple searches (use grep instead)
- Single file operations
- Quick tool calls
- When you need the full context

---

## 🔗 Tool Combination Patterns

### **Pattern: Find and Fix Bug**

```typescript
// 1. Find error location
grep({ 
  pattern: "TypeError.*undefined",
  output_mode: "content"
})

// 2. Read surrounding code
read({
  path: "src/file.ts",
  offset: 45,
  limit: 20
})

// 3. Check for type errors
lsp_query({
  action: "diagnostics",
  path: "src/file.ts"
})

// 4. Fix the bug
edit({
  path: "src/file.ts",
  oldText: "user.name",
  newText: "user?.name"  // Optional chaining
})

// 5. Verify fix
lsp_query({
  action: "diagnostics",
  path: "src/file.ts"
})
```

---

### **Pattern: Implement Feature**

```typescript
// 1. Find similar code
grep({
  pattern: "function create.*\\(",
  output_mode: "content"
})

// 2. Understand existing pattern
read({ path: "src/users.ts", offset: 100, limit: 30 })

// 3. Create task
task_create({
  title: "Add createPost function",
  subtasks: ["Write function", "Add types", "Add tests"]
})

// 4. Implement
write({
  path: "src/posts.ts",
  content: "..." // Following existing pattern
})

// 5. Check for errors
lsp_query({
  action: "diagnostics",
  path: "src/posts.ts"
})

// 6. Update task
task_update({
  id: "task-123",
  status: "completed"
})
```

---

### **Pattern: Refactor Safely**

```typescript
// 1. Find all usages
lsp_query({
  action: "references",
  path: "src/types.ts",
  line: 10,
  column: 5
})
// Result: 15 references in 7 files

// 2. Baseline errors
lsp_query({
  action: "diagnostics",
  path: "src/types.ts"
})

// 3. Make changes
edit({ 
  path: "src/types.ts",
  oldText: "interface User",
  newText: "interface UserProfile"
})

// 4. Update usages
// (Edit each reference location)

// 5. Verify no new errors
lsp_query({
  action: "diagnostics",
  path: "src/types.ts"
})

// 6. Double-check all references updated
lsp_query({
  action: "references",
  path: "src/types.ts",
  line: 10,
  column: 5
})
```

---

## ⚠️ Common Mistakes to Avoid

### ❌ **Mistake 1: Using Bash for Everything**

```typescript
// WRONG
bash({ command: "grep -r 'function' src/" })
bash({ command: "find . -name '*.ts'" })
bash({ command: "cat file.ts | head -20" })

// RIGHT
grep({ pattern: "function", path: "src/" })
glob({ pattern: "**/*.ts" })
read({ path: "file.ts", limit: 20 })
```

**Why:** Dedicated tools are 10-100x faster and safer

---

### ❌ **Mistake 2: Editing Without Reading**

```typescript
// WRONG
edit({ path: "file.ts", oldText: "x", newText: "y" })
// What if there are multiple 'x'?

// RIGHT
read({ path: "file.ts" })
// See exact content, then edit with specific oldText
edit({
  path: "file.ts",
  oldText: "const x = 1;\nreturn x;",
  newText: "const y = 1;\nreturn y;"
})
```

**Why:** Prevents ambiguous matches and errors

---

### ❌ **Mistake 3: Ignoring LSP Diagnostics**

```typescript
// WRONG
edit({ path: "file.ts", ... })
// Done! (but there might be errors)

// RIGHT
edit({ path: "file.ts", ... })
lsp_query({ action: "diagnostics", path: "file.ts" })
// Check for errors after editing
```

**Why:** Catch type errors immediately

---

### ❌ **Mistake 4: Re-reading Same File**

```typescript
// WRONG
read({ path: "file.ts" })
// ... some work ...
read({ path: "file.ts" })  // Again?
// ... more work ...
read({ path: "file.ts" })  // Third time?

// RIGHT
read({ path: "file.ts" })
// Remember contents!
// Use line numbers from earlier
```

**Why:** Wastes tokens and time

---

### ❌ **Mistake 5: Not Using Pagination**

```typescript
// WRONG
read({ path: "large-file.ts" })
// Tries to read 10,000 lines → fails

// RIGHT
read({ path: "large-file.ts", offset: 100, limit: 50 })
// Read just what you need
```

**Why:** Max 2000 lines per read

---

## 🎯 Performance Tips

### **Fast Searches**

```typescript
// 1. Start broad (fastest)
glob({ pattern: "**/*.ts" })  // ~10ms

// 2. Then narrow (fast)
grep({ 
  pattern: "MyClass",
  output_mode: "files_with_matches"
})  // ~50ms

// 3. Then precise (slower)
lsp_query({
  action: "definition",
  path: "src/file.ts",
  line: 10,
  column: 5
})  // ~200ms
```

### **Minimize Tool Calls**

```typescript
// WRONG: 5 tool calls
read({ path: "file1.ts" })
read({ path: "file2.ts" })
read({ path: "file3.ts" })
read({ path: "file4.ts" })
read({ path: "file5.ts" })

// BETTER: Use grep once to get all matches
grep({
  pattern: "functionName",
  output_mode: "content",
  "-B": 5,
  "-A": 5
})
// Shows all matches with context in one call
```

### **Use Subagents for Heavy Work**

```typescript
// Main agent stays clean
agent({
  description: "Explore auth module",
  prompt: "Find all auth-related files, read them, summarize the approach"
})
// Subagent does heavy lifting
// Result comes back summarized
```

---

## 🔄 Error Recovery Flows

### **LSP Server Unavailable**

```
lsp_query fails
  ↓
Fall back to grep
  ↓
Continue with reduced precision
  ↓
Inform user: "LSP unavailable, using grep fallback"
```

### **File Not Found**

```
read fails: "File not found"
  ↓
Use glob to find similar paths
  ↓
Suggest corrections: "Did you mean X or Y?"
  ↓
Try again with correct path
```

### **Edit Ambiguous Match**

```
edit fails: "Matches 3 times"
  ↓
Read file to see all matches
  ↓
Add more context to oldText
  ↓
Retry edit
```

### **Build Fails**

```
Build fails
  ↓
Run lsp_query diagnostics
  ↓
Identify specific errors
  ↓
Fix errors one by one
  ↓
Verify each fix
  ↓
Retry build
```

---

## 📚 Quick Reference

```
Files:        glob → read → edit/write
Search:       grep → lsp_query → read
Navigate:     lsp_query definition/references → read
Check:        lsp_query diagnostics
Tasks:        task_create → task_update → task_list
Cron:         cron_create → cron_list → cron_delete
Web:          web_search / web_fetch
MCP:          list_mcp_resources → read_mcp_resource
Parallel:     agent (Explore subagent)
```

---

**Remember:** The right tool for the job is 10x faster than the wrong tool.

**Master these patterns and you'll be unstoppable.**

---

*Last updated: 2026-04-26*  
*Version: 2.0 (Comprehensive Tool Intelligence)*
