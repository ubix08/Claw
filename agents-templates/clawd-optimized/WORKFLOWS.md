# Workflows — Proven Patterns for Common Tasks

**Learn by example.** These are battle-tested workflows that work.

---

## 🗺️ Workflow Index

1. **Code Navigation** - Find and understand code
2. **Bug Investigation** - Diagnose and fix issues
3. **Feature Implementation** - Add new functionality
4. **Refactoring** - Restructure safely
5. **Code Review** - Analyze changes
6. **Documentation** - Understand and document
7. **Testing** - Write and verify tests
8. **Debugging** - Trace and fix runtime issues
9. **Performance Optimization** - Find and fix bottlenecks
10. **Codebase Exploration** - Learn new codebase

---

## 1. Code Navigation Workflow

### **Goal:** Find and understand a function/class/symbol

### **Steps:**

#### **Phase 1: Initial Search**

```typescript
// Step 1: Broad search to find files
grep({
  pattern: "functionName",
  output_mode: "files_with_matches"
})
```

**Result:** List of files containing "functionName"

```
src/parser.ts
src/utils.ts
tests/parser.test.ts
```

#### **Phase 2: Go to Definition**

```typescript
// Step 2: Find exact definition location
lsp_query({
  action: "definition",
  path: "src/parser.ts",  // Most likely file
  line: 45,                // Approximate from grep
  column: 10
})
```

**Result:** Precise location

```
src/parser.ts:45:10
```

#### **Phase 3: Read Context**

```typescript
// Step 3: Read definition with surrounding code
read({
  path: "src/parser.ts",
  offset: 40,  // Line 45 - 5 lines context
  limit: 20    // 20 lines total
})
```

**Result:** Full function with context

#### **Phase 4: Find All Usages**

```typescript
// Step 4: See how it's used
lsp_query({
  action: "references",
  path: "src/parser.ts",
  line: 45,
  column: 10
})
```

**Result:** All usage locations

```
Found 12 references:
- src/main.ts:100
- src/utils.ts:50
- tests/parser.test.ts:20
...
```

#### **Phase 5: Check for Issues**

```typescript
// Step 5: Verify no type errors
lsp_query({
  action: "diagnostics",
  path: "src/parser.ts"
})
```

**Result:** Clean or list of errors

---

### **Why This Order:**

1. **Grep is fastest** - Initial broad search
2. **LSP is precise** - Exact location
3. **Reading context** - Understand implementation
4. **References show usage** - See real-world examples
5. **Diagnostics catch issues** - Verify quality

---

## 2. Bug Investigation Workflow

### **Goal:** Diagnose and fix a bug

### **Steps:**

#### **Phase 1: Locate the Issue**

```typescript
// Step 1: Find error in code or logs
grep({
  pattern: "TypeError.*undefined",
  output_mode: "content",
  "-B": 3,  // 3 lines before for context
  "-A": 3   // 3 lines after
})
```

**Result:** Error location and context

```
src/user.ts:67
65:  const userName = user.name;
66:  const userEmail = user.email;
67:  const userPhone = user.phone.number;  // ❌ Error here
68:  return { userName, userEmail, userPhone };
```

#### **Phase 2: Read Surrounding Code**

```typescript
// Step 2: Get full context
read({
  path: "src/user.ts",
  offset: 55,  // Line 67 - 12
  limit: 30    // Read 30 lines
})
```

**Result:** Function implementation

```typescript
function getUserInfo(user: User) {
  // ... lines 56-65 ...
  const userName = user.name;
  const userEmail = user.email;
  const userPhone = user.phone.number;  // Problem: phone might be undefined
  return { userName, userEmail, userPhone };
}
```

#### **Phase 3: Check Type Errors**

```typescript
// Step 3: Get LSP diagnostics
lsp_query({
  action: "diagnostics",
  path: "src/user.ts"
})
```

**Result:** Type error details

```
Error (line 67): Property 'number' does not exist on type 'undefined'
Severity: error
```

#### **Phase 4: Check Type Definition**

```typescript
// Step 4: See User type
lsp_query({
  action: "hover",
  path: "src/user.ts",
  line: 67,
  column: 20  // Over "user.phone"
})
```

**Result:** Type information

```typescript
phone?: {
  number: string;
  countryCode: string;
} | undefined
```

**Ah! `phone` is optional.**

#### **Phase 5: Fix the Bug**

```typescript
// Step 5: Apply fix with optional chaining
edit({
  path: "src/user.ts",
  oldText: "  const userPhone = user.phone.number;\n  return { userName, userEmail, userPhone };",
  newText: "  const userPhone = user.phone?.number;\n  return { userName, userEmail, userPhone };"
})
```

#### **Phase 6: Verify Fix**

```typescript
// Step 6: Check diagnostics again
lsp_query({
  action: "diagnostics",
  path: "src/user.ts"
})
```

**Result:** ✅ No errors

#### **Phase 7: Look for Similar Issues**

```typescript
// Step 7: Find other places with same pattern
grep({
  pattern: "user\\.phone\\.number",
  output_mode: "content"
})
```

**Result:** Check if same bug exists elsewhere

---

### **Key Lessons:**

- Grep finds error location fast
- LSP diagnostics explain the error
- Hover shows type information
- Fix with minimal changes
- Verify with LSP again
- Check for similar issues

---

## 3. Feature Implementation Workflow

### **Goal:** Add new functionality following existing patterns

### **Steps:**

#### **Phase 1: Find Similar Code**

```typescript
// Step 1: Find existing similar features
grep({
  pattern: "function create.*User",
  output_mode: "content"
})
```

**Result:** Existing patterns

```typescript
function createUser(data: UserData): User {
  // ... implementation
}
```

#### **Phase 2: Understand Architecture**

```typescript
// Step 2: Read the implementation
read({
  path: "src/users.ts",
  offset: 100,
  limit: 40
})
```

**Result:** Full context of createUser

#### **Phase 3: Check Dependencies**

```typescript
// Step 3: Find what createUser uses
lsp_query({
  action: "references",
  path: "src/users.ts",
  line: 105,  // UserData type
  column: 20
})
```

**Result:** See how UserData is used

#### **Phase 4: Create Task Plan**

```typescript
// Step 4: Plan the work
task_create({
  title: "Add createPost function",
  description: "Follow createUser pattern",
  subtasks: [
    "1. Define PostData interface",
    "2. Implement createPost function",
    "3. Add validation",
    "4. Add error handling",
    "5. Add tests"
  ]
})
```

**Result:** task-123 created

#### **Phase 5: Implement (Iteratively)**

```typescript
// Step 5a: Define types
write({
  path: "src/posts.ts",
  content: `
export interface PostData {
  title: string;
  content: string;
  authorId: string;
}

export interface Post extends PostData {
  id: string;
  createdAt: Date;
}
`
})

// Step 5b: Check for errors
lsp_query({
  action: "diagnostics",
  path: "src/posts.ts"
})
// ✅ Clean

// Step 5c: Implement function (following createUser pattern)
edit({
  path: "src/posts.ts",
  oldText: "export interface Post extends PostData {",
  newText: `export interface Post extends PostData {
  id: string;
  createdAt: Date;
}

export function createPost(data: PostData): Post {
  return {
    ...data,
    id: generateId(),
    createdAt: new Date()
  };
}

export interface Post extends PostData {`
})

// Step 5d: Verify
lsp_query({
  action: "diagnostics",
  path: "src/posts.ts"
})

// Step 5e: Update task
task_update({
  id: "task-123",
  status: "in_progress",
  description: "✅ Types defined\n✅ Function implemented\n⏳ Tests pending"
})
```

#### **Phase 6: Add Tests**

```typescript
// Step 6: Write tests following existing pattern
grep({
  pattern: "describe.*createUser",
  output_mode: "content"
})

// Read test pattern
read({
  path: "tests/users.test.ts",
  offset: 50,
  limit: 30
})

// Implement similar tests
write({
  path: "tests/posts.test.ts",
  content: `
describe('createPost', () => {
  it('should create a post with id and timestamp', () => {
    const data: PostData = {
      title: 'Test',
      content: 'Content',
      authorId: 'user-1'
    };
    const post = createPost(data);
    expect(post.id).toBeDefined();
    expect(post.createdAt).toBeInstanceOf(Date);
  });
});
`
})
```

#### **Phase 7: Complete Task**

```typescript
// Step 7: Mark done
task_update({
  id: "task-123",
  status: "completed"
})
```

---

### **Key Lessons:**

- Find similar code first (grep)
- Read and understand patterns (read + LSP)
- Plan with tasks (task_create)
- Implement incrementally
- Verify each step (lsp_query diagnostics)
- Follow existing architecture

---

## 4. Refactoring Workflow

### **Goal:** Rename or restructure code safely

### **Steps:**

#### **Phase 1: Find All Usages**

```typescript
// Step 1: Find all references
lsp_query({
  action: "references",
  path: "src/types.ts",
  line: 10,  // Old name location
  column: 5
})
```

**Result:** 15 references in 7 files

```
src/types.ts:10 (definition)
src/main.ts:45
src/utils.ts:23
src/api.ts:67
tests/types.test.ts:12
...
```

#### **Phase 2: Baseline Errors**

```typescript
// Step 2: Record current error state
lsp_query({
  action: "diagnostics",
  path: "src/types.ts"
})
```

**Result:** 0 errors (baseline)

#### **Phase 3: Rename Definition**

```typescript
// Step 3: Change the definition
edit({
  path: "src/types.ts",
  oldText: "export interface User {",
  newText: "export interface UserProfile {"
})
```

#### **Phase 4: Update All Usages**

```typescript
// Step 4a: Update main.ts
read({ path: "src/main.ts", offset: 40, limit: 15 })
edit({
  path: "src/main.ts",
  oldText: "const user: User = {",
  newText: "const user: UserProfile = {"
})

// Step 4b: Update utils.ts
read({ path: "src/utils.ts", offset: 18, limit: 15 })
edit({
  path: "src/utils.ts",
  oldText: "function processUser(user: User) {",
  newText: "function processUser(user: UserProfile) {"
})

// Step 4c: Update api.ts
read({ path: "src/api.ts", offset: 62, limit: 15 })
edit({
  path: "src/api.ts",
  oldText: "users: User[]",
  newText: "users: UserProfile[]"
})

// Continue for all references...
```

#### **Phase 5: Verify No New Errors**

```typescript
// Step 5: Check diagnostics
lsp_query({
  action: "diagnostics",
  path: "src/types.ts"
})
lsp_query({
  action: "diagnostics",
  path: "src/main.ts"
})
lsp_query({
  action: "diagnostics",
  path: "src/utils.ts"
})
```

**Result:** ✅ Still 0 errors

#### **Phase 6: Double-Check References**

```typescript
// Step 6: Verify all updated
grep({
  pattern: "\\bUser\\b",  // Word boundary
  output_mode: "files_with_matches"
})
```

**Result:** Check if old name still exists anywhere

---

### **Key Lessons:**

- Find ALL usages first (LSP references)
- Baseline errors (know starting state)
- Update systematically
- Verify incrementally (LSP diagnostics)
- Double-check completeness (grep)

---

## 5. Code Review Workflow

### **Goal:** Review changes for quality and correctness

### **Steps:**

#### **Phase 1: Get Change Summary**

```typescript
// Step 1: See what changed
bash({ command: "git diff --stat" })
```

**Result:** List of modified files

```
src/auth.ts     | 25 ++++++++++-
src/types.ts    | 10 ++--
tests/auth.test.ts | 45 ++++++++++++++++
```

#### **Phase 2: Review Each File**

```typescript
// Step 2a: Read changed file
bash({ command: "git diff src/auth.ts" })

// Step 2b: Get full context
read({
  path: "src/auth.ts",
  offset: 45,  // Changed lines from diff
  limit: 30
})

// Step 2c: Check for errors
lsp_query({
  action: "diagnostics",
  path: "src/auth.ts"
})
```

#### **Phase 3: Check Impact**

```typescript
// Step 3: Find what uses changed functions
lsp_query({
  action: "references",
  path: "src/auth.ts",
  line: 50,  // Modified function
  column: 10
})
```

**Result:** 8 usages - check if affected

#### **Phase 4: Verify Tests**

```typescript
// Step 4: Check test coverage
grep({
  pattern: "describe.*auth",
  output_mode: "content"
})

// Run tests
bash({ command: "npm test -- auth.test.ts" })
```

---

### **Key Lessons:**

- Start with diff summary
- Read changed code in context
- Check LSP diagnostics
- Verify references (impact analysis)
- Ensure tests cover changes

---

## 6. Codebase Exploration Workflow

### **Goal:** Learn a new codebase quickly

### **Steps:**

#### **Phase 1: Get Overview**

```typescript
// Step 1: See structure
bash({ command: "tree -L 2 -I 'node_modules'" })
```

**Result:** Directory structure

```
src/
├── api/
├── auth/
├── core/
├── tools/
└── types/
```

#### **Phase 2: Find Entry Points**

```typescript
// Step 2: Look for main/index files
glob({ pattern: "**/index.ts" })
glob({ pattern: "**/main.ts" })
```

**Result:** Key entry points

#### **Phase 3: Understand Architecture**

```typescript
// Step 3: Read main files
read({ path: "src/index.ts" })
read({ path: "src/api/index.ts" })
```

#### **Phase 4: Map Key Concepts**

```typescript
// Step 4: Find core types/classes
grep({
  pattern: "^export (class|interface|type)",
  output_mode: "content"
})
```

**Result:** Core abstractions

#### **Phase 5: Use Subagent for Deep Dive**

```typescript
// Step 5: Explore specific module
agent({
  description: "Explore authentication module",
  prompt: `
    Analyze the auth/ directory:
    1. List all files
    2. Read main auth files
    3. Find how authentication works
    4. Identify key functions
    5. Summarize the approach
  `,
  subagent_type: "explore"
})
```

**Result:** Comprehensive module summary

---

## 7. Performance Optimization Workflow

### **Goal:** Find and fix performance bottlenecks

### **Steps:**

#### **Phase 1: Identify Slow Code**

```typescript
// Step 1: Find console.log or performance markers
grep({
  pattern: "console\\.time|performance\\.now",
  output_mode: "content"
})

// Or: Find loops that might be slow
grep({
  pattern: "for.*length|map.*filter",
  output_mode: "content"
})
```

#### **Phase 2: Analyze Complexity**

```typescript
// Step 2: Read the slow code
read({
  path: "src/processor.ts",
  offset: 45,
  limit: 30
})
```

**Analyze:**
- Nested loops? O(n²) or worse?
- Repeated work?
- Unnecessary copies?

#### **Phase 3: Find Call Sites**

```typescript
// Step 3: See where it's called
lsp_query({
  action: "references",
  path: "src/processor.ts",
  line: 50,
  column: 10
})
```

**Result:** How often is it called?

#### **Phase 4: Optimize**

```typescript
// Step 4: Apply optimization
edit({
  path: "src/processor.ts",
  oldText: `
    for (let i = 0; i < items.length; i++) {
      for (let j = 0; j < items.length; j++) {
        // O(n²) nested loop
      }
    }
  `,
  newText: `
    const itemsSet = new Set(items);
    for (const item of items) {
      if (itemsSet.has(item)) {
        // O(n) with Set lookup
      }
    }
  `
})
```

#### **Phase 5: Verify**

```typescript
// Step 5: Ensure still correct
lsp_query({
  action: "diagnostics",
  path: "src/processor.ts"
})

// Run performance tests
bash({ command: "npm run perf-test" })
```

---

## 🎯 Quick Reference

```
Code Navigation:     grep → lsp definition → read → lsp references
Bug Investigation:   grep error → read → lsp diagnostics → edit → verify
Feature:             grep similar → read → task_create → implement → test
Refactoring:         lsp references → edit all → lsp diagnostics
Code Review:         git diff → read context → lsp diagnostics → references
Codebase Exploration: tree → glob → read → agent (explore)
Performance:         grep hotspot → analyze → optimize → verify
```

---

## 💡 Key Principles Across Workflows

1. **Start Broad, Then Narrow**
   - Grep first (fast, broad)
   - LSP second (precise)
   - Read last (detailed)

2. **Read Before Edit**
   - Always see current state
   - Understand context
   - Make targeted changes

3. **Verify After Changes**
   - LSP diagnostics
   - Build/test
   - Check references

4. **Track Multi-Step Work**
   - Create tasks
   - Update progress
   - Mark complete

5. **Learn from Existing Code**
   - Find similar patterns
   - Follow architecture
   - Match style

---

**Master these workflows and you'll handle any task efficiently.**

---

*Last updated: 2026-04-26*  
*Version: 2.0 (Proven Workflow Patterns)*
