# AGENTS.md — Oh-My-Link (OML)

## Overview

Oh-My-Link is a multi-agent orchestration plugin for **Claude Code**, built by studying the Claude Code source code leak. It leverages the hook system, subagent lifecycle, and plugin architecture to orchestrate 12 agents across a structured pipeline.

All coordination (task tracking, file locking, messaging) uses **file-based JSON** stored in the `.oh-my-link/` project directory. This makes OML fully self-contained and portable.

### Keyword Triggers

| Keyword | Mode | Description |
|---------|------|-------------|
| `start link` | Start Link | Full 7-phase pipeline for complex tasks |
| `start fast` | Start Fast | Lightweight mode for simple tasks |
| `cancel oml` | Cancel | Cancel active OML session |

---

## Modes

### Start Link — 7-Phase Pipeline

For complex, multi-file tasks. Follows a structured pipeline:

**Scout → Architect → Worker → Reviewer**

Phases: `init` → `scouting` → `architecture` → `work` → `review` → `revision` (if needed) → `complete`

### Start Fast — Lightweight Execution

Three tiers based on complexity assessment:

| Tier | When | Flow |
|------|------|------|
| **Turbo** | Trivial changes (typos, one-liner) | Direct execution, no planning |
| **Standard** | Moderate tasks (single feature, small refactor) | Light plan → execute → verify |
| **Complex** | Escalated from Standard if scope grows | Promotes to full Start Link |

---

## Agent Roles

| Agent | Skill File | Writes Code | Primary Responsibility |
|-------|-----------|-------------|----------------------|
| **master** | `master.md` | No | Orchestrates phases, delegates to agents, enforces workflow |
| **scout** | `scout.md` | No | Reads codebase, produces CONTEXT.md with findings |
| **fast-scout** | `fast-scout.md` | No | Lightweight scouting for Start Fast mode |
| **architect** | `architect.md` | No | Designs plan.md with tasks, dependencies, file assignments |
| **worker** | `worker.md` | **Yes** | Implements code changes per assigned tasks |
| **reviewer** | `reviewer.md` | No | Reviews worker output, produces review.md |
| **explorer** | `explorer.md` | No | Deep-dives into specific areas when scout needs more info |
| **executor** | `executor.md` | **Yes** | Runs commands (build, test, deploy) |
| **verifier** | `verifier.md` | No | Validates deliverables against plan and requirements |
| **code-reviewer** | `code-reviewer.md` | No | Focused code quality review (style, patterns, bugs) |
| **security-reviewer** | `security-reviewer.md` | No | Security-focused review (vulnerabilities, secrets, auth) |
| **test-engineer** | `test-engineer.md` | **Yes** | Writes and runs tests for worker output |

---

## 7-Phase Workflow

```
Phase 1: init           → Master parses intent, creates session
Phase 2: scouting       → Scout reads codebase, produces CONTEXT.md
Phase 3: architecture   → Architect designs plan.md with task graph
Phase 4: work           → Worker(s) implement tasks (claim via task-engine)
Phase 5: review         → Reviewer evaluates output, produces review.md
Phase 6: revision       → Worker fixes issues from review (if any)
Phase 7: complete       → Master summarizes, cleans up session
```

Each phase uses the **task-engine** (file-based JSON). Tasks are created, claimed, and completed through atomic file operations with mutex protection.

---

## Session State

Session stored at `$OML_HOME/projects/{hash}/session.json`:

| Field | Type | Description |
|-------|------|-------------|
| `active` | boolean | Whether session is currently running |
| `mode` | string | `"link"` or `"fast"` |
| `intent` | string | User's original request |
| `current_phase` | string | Current pipeline phase |
| `started_at` | ISO 8601 | Session start timestamp |
| `reinforcement_count` | number | Times reinforcement was applied |
| `failure_count` | number | Consecutive failures |
| `last_failure` | string | Last failure description |
| `revision_count` | number | Review → revision cycles |
| `awaiting_confirmation` | boolean | Waiting for user input |
| `session_ended_at` | ISO 8601 | When session completed |
| `deactivated_reason` | string | Why session was stopped |
| `is_final_phase` | boolean | Whether in completion phase |
| `context_limit_stop` | boolean | Stopped due to context window limit |

---

## Task Engine API

All operations are file-based with mutex protection.

### Task Management

| Function | Description |
|----------|-------------|
| `createTask(task)` | Create task JSON in `.oh-my-link/tasks/{link-id}.json` |
| `readTask(id)` | Read task by ID |
| `updateTaskStatus(id, status)` | Update task status (`pending` → `in_progress` → `done` / `failed`) |
| `listTasks(filter?)` | List tasks, optionally filtered by status |
| `getReadyTasks()` | Get tasks whose dependencies are all satisfied |
| `claimNextTask(agentId)` | Atomically claim next ready task (mutex-protected) |

### File Locking

| Function | Description |
|----------|-------------|
| `acquireLock(filePath, agentId)` | Acquire exclusive lock on a file |
| `releaseLock(filePath, agentId)` | Release lock held by agent |
| `releaseAllLocks(agentId)` | Release all locks for an agent |
| `checkLock(filePath)` | Check current lock status |

### Messaging

| Function | Description |
|----------|-------------|
| `sendMessage(thread, from, content)` | Send message to a thread |
| `readInbox(thread, since?)` | Read messages from a thread |

### Analysis

| Function | Description |
|----------|-------------|
| `detectCycles()` | Detect circular dependencies in task graph |
| `getTaskInsights()` | Summary stats: pending, in-progress, done, blocked |

---

## File Locking

OML uses **mkdir-based atomic mutex** for concurrency:

1. **Mutex acquisition**: `mkdir` is atomic on all OS — used as a spinlock
2. **Canonical path hashing**: File paths are normalized and hashed for lock filenames
3. **TTL / Stale detection**: Locks older than **30 seconds** are considered stale and can be force-acquired
4. **Lock files**: Stored in `.oh-my-link/locks/{hash}.json` containing `agentId`, `filePath`, `acquiredAt`

---

## Concurrency Rules

- All file modifications require acquiring a **file lock** via the task-engine
- Task claiming is **mutex-protected** — only one agent can claim a task at a time
- Lock contention uses backoff and retry
- Stale locks (>30s) are automatically broken
- No external server required — all coordination is file-based

---

## Directory Structure

### Project Workspace: `.oh-my-link/`

```
.oh-my-link/
├── tasks/              # Task JSON files: {link-id}.json
├── locks/              # Lock files: {path-hash}.json
├── messages/           # Messaging threads: {thread}/*.json
├── plans/              # Architect plans: plan.md
└── history/            # Completed session artifacts
```

### System State: `~/.oh-my-link/` (or `$OML_HOME`)

```
~/.oh-my-link/
└── projects/
    └── {project-hash}/
        ├── session.json          # Active session state
        ├── tool-tracking.json    # Tool usage stats per agent
        └── ...
```

---

## Hook Pipeline

Hooks execute in order on every tool call:

```
keyword-detector → skill-injector → pre-tool-enforcer → post-tool-verifier → stop-handler → session-end → pre-compact
```

| Hook | Purpose |
|------|---------|
| `keyword-detector` | Detects `start link`, `start fast`, `cancel oml` triggers |
| `skill-injector` | Injects agent skill files into context for the active role |
| `pre-tool-enforcer` | Blocks disallowed tools/paths/commands per role |
| `post-tool-verifier` | Validates tool outputs and enforces constraints |
| `stop-handler` | Detects stop conditions (failures, context limits) |
| `session-end` | Cleanup on session termination |
| `pre-compact` | Saves state before context compaction |

---

## Role Enforcement

The `pre-tool-enforcer` restricts agent capabilities:

### Tool Restrictions

| Role | Allowed Tools | Blocked Tools |
|------|--------------|---------------|
| scout, fast-scout | Read, Glob, Grep, Bash (read-only) | Write, Edit |
| architect | Read, Glob, Grep | Write (except plan files), Bash |
| worker | Read, Write, Edit, Bash, Glob, Grep | — |
| reviewer | Read, Glob, Grep | Write (except review.md), Edit |

### File Path Restrictions

- **Scout/Reviewer**: Cannot write outside `.oh-my-link/`
- **Worker**: Can only write to files assigned in the plan
- **Architect**: Can only write to `.oh-my-link/plans/`

### Bash Command Restrictions

- **Scout**: Read-only commands (`ls`, `cat`, `find`, `grep`, `git log`, `git diff`)
- **Worker**: Full access but no destructive git operations (`push --force`, `reset --hard`)
- **Reviewer**: Read-only commands only

---

## Deliverable Expectations

Each agent role produces specific artifacts:

| Agent | Deliverable | Location |
|-------|------------|----------|
| **scout** | `CONTEXT.md` — codebase analysis | `.oh-my-link/plans/CONTEXT.md` |
| **architect** | `plan.md` — task graph with dependencies | `.oh-my-link/plans/plan.md` |
| **worker** | Code changes per assigned tasks | Project source files |
| **reviewer** | `review.md` — pass/fail with findings | `.oh-my-link/plans/review.md` |
| **test-engineer** | Test files and test results | Project test directory |
| **verifier** | Verification report | `.oh-my-link/plans/verification.md` |

---

## Quick Start

### Full Pipeline (complex task)

```
User: start link Refactor the authentication module to use JWT tokens
```

This triggers the 7-phase pipeline: Scout analyzes the codebase → Architect designs the plan → Worker implements changes → Reviewer validates.

### Lightweight Mode (simple task)

```
User: start fast Fix the typo in the README header
```

Assessed as Turbo tier — executed immediately without planning overhead.

### Cancel Session

```
User: cancel oml
```

Stops the active session, releases all locks, and archives session state.

---

## Memory Self-Tagging

When you make a key decision, discover a constraint, encounter a notable problem, or state a preference, wrap the insight in `<remember>` tags so it is automatically persisted to project memory. This enables future sessions and agents to benefit from your findings without any user action.

**When to tag:**
- Architectural decisions ("we chose X over Y because...")
- Bug root causes ("the crash was caused by...")
- Discovered constraints ("this API has a 100-item limit")
- Conventions or preferences ("always use snake_case for DB columns")
- Milestones ("auth module refactor is complete and tested")

**Format:** `<remember>concise insight here</remember>`

You do NOT need to tag routine observations or intermediate work. Only tag information that would be valuable to a future agent or session working on this project.
