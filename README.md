# Oh-My-Link — Multi-Agent Orchestration for Claude Code

<p align="center">
  <a href="README.vi.md">Vietnamese / Tiếng Việt</a>
</p>

<p align="center">
  <em>Seven phases. Twelve agents. File-based coordination.<br/>
  A structured pipeline that turns complex requests into reviewed, production-ready code.</em>
</p>

<p align="center">
  <a href="#installation"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js >= 18" /></a>&nbsp;
  <a href="#quick-start"><img src="https://img.shields.io/badge/Claude_Code-Plugin-7C3AED?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTIgMkM2LjQ4IDIgMiA2LjQ4IDIgMTJzNC40OCAxMCAxMCAxMCAxMC00LjQ4IDEwLTEwUzE3LjUyIDIgMTIgMnoiIGZpbGw9IndoaXRlIi8+PC9zdmc+&logoColor=white" alt="Claude Code Plugin" /></a>&nbsp;
  <a href="#license"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License" /></a>
</p>

---

Oh-My-Link (OML) is a Claude Code plugin that coordinates specialized agents through structured workflows. Built by studying the [Claude Code source code leak](https://github.com/anthropics/claude-code), it leverages the hook system, subagent lifecycle, and plugin architecture to orchestrate 12 agents across a 7-phase pipeline. All coordination uses **file-based JSON** — lightweight, portable, and self-contained.

## Quick Start

Just say `start link` or `start fast` in Claude Code.

```
start link build me a REST API with auth      # Full 7-phase workflow
start fast fix the login validation bug        # Lightweight 2-step workflow
cancel oml                                     # Cancel active session
```

## Two Modes

### Start Link — Full Autonomous Workflow

Seven phases with three mandatory human-in-the-loop (HITL) gates. Designed for complex features, multi-file changes, and new systems.

- **Phase 1** — Scout clarifies requirements via Socratic dialogue
- **Gate 1** — You approve locked decisions
- **Phase 2** — Architect produces implementation plan
- **Gate 2** — You approve plan (with feedback loop)
- **Phase 3** — Architect decomposes plan into tasks (links)
- **Phase 4** — Validation across multiple dimensions
- **Gate 3** — You choose Sequential or Parallel execution
- **Phase 5** — Workers implement tasks with file locking
- **Phase 6** — Reviewer evaluates per-task + full-feature review
- **Phase 7** — Summary and compounding (learning flywheel)

### Start Fast — Lightweight Workflow

Two steps, zero gates. Designed for bug fixes, small changes, and quick features.

| Tier | When | What Happens |
|------|------|--------------|
| **Turbo** | Trivial changes (typos, one-liner) | Direct execution, no planning |
| **Standard** | Moderate tasks (single feature, small refactor) | Quick scout → execute → verify |
| **Complex** | Scope too large | Promotes to full Start Link |

## Workflow Diagram

```
                        Start Link (7-phase)
                        ====================

  User ──> keyword-detector ──> prompt-leverage ──> Bootstrap
                                                       │
          ┌────────────────────────────────────────────┘
          v
  Phase 1: Scout (requirements clarification)
          │
      [GATE 1] ── user approves locked decisions
          │
  Phase 2: Architect (planning)
          │
      [GATE 2] ── user approves plan
          │
  Phase 3: Architect (decomposition into links/tasks)
          │
  Phase 4: Validation (pre-execution checks)
          │
      [GATE 3] ── user chooses Sequential / Parallel
          │
  Phase 5: Worker(s) implement links
          │
  Phase 6: Reviewer per-link + full-feature review
          │
  Phase 7: Summary + Compounding
          │
         Done


                        Start Fast (2-step)
                        ====================

  User ──> keyword-detector ──> prompt-leverage ──> Bootstrap
                                                       │
          ┌────────────────────────────────────────────┘
          v
  Step 1: Fast Scout (analyze, 0-2 questions)
          │
  Step 2: Executor (implement → verify → release)
          │
         Done
```

---

## Installation

### Marketplace (recommended)

Add to your `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "oh-my-link": {
      "source": {
        "source": "github",
        "repo": "vubaolinh123/Oh-My-Link"
      }
    }
  },
  "enabledPlugins": {
    "oh-my-link@oh-my-link": true
  }
}
```

Then run `setup oml` in Claude Code to initialize the workspace.

### Local Development

```bash
git clone https://github.com/vubaolinh123/Oh-My-Link.git
cd Oh-My-Link
npm install
npm run build
```

Claude Code auto-discovers `.claude-plugin/plugin.json` in the working directory.

### Verify Setup

```
doctor oml
```

If any hook fails, the doctor will diagnose the issue and suggest fixes.

---

## Agent Roster & Model Configuration

Each agent has a default model assignment optimized for its role. You can override any of these.

| Agent | Role | Writes Code | Default Model |
|-------|------|:-----------:|---------------|
| **Master** | Orchestrates the 7-phase pipeline, enforces gates | No | `claude-opus-4-6` |
| **Scout** | Codebase reconnaissance & requirements clarification | No | `claude-opus-4-6` |
| **Architect** | Planning, decomposition, task creation | No | `claude-opus-4-6` |
| **Code Reviewer** | Deep code quality review (style, patterns, bugs) | No | `claude-opus-4-6` |
| **Worker** | Implements a single task with file locking | Yes | `claude-sonnet-4-6` |
| **Reviewer** | Per-task and full-feature quality review | No | `claude-sonnet-4-6` |
| **Fast Scout** | Quick analysis for Start Fast mode | No | `claude-sonnet-4-6` |
| **Executor** | Runs commands, implements for Start Fast | Yes | `claude-sonnet-4-6` |
| **Verifier** | Validates deliverables against criteria | No | `claude-sonnet-4-6` |
| **Security Reviewer** | OWASP-focused security audit | No | `claude-sonnet-4-6` |
| **Test Engineer** | Writes and runs tests | Tests only | `claude-sonnet-4-6` |
| **Explorer** | Fast codebase search and pattern matching | No | `claude-haiku-4-5` |

### Why these defaults?

- **Opus** for roles that require deep reasoning: Master (orchestration decisions), Scout (requirement analysis), Architect (design), Code Reviewer (quality judgment)
- **Sonnet** for execution-heavy roles: Worker (coding), Reviewer (structured evaluation), Executor (fast implementation)
- **Haiku** for the Explorer — lightweight searches that need speed over depth

### Custom Model Configuration

**Global config** — applies to all projects:

Create or edit `~/.oh-my-link/config.json`:

```json
{
  "models": {
    "master": "claude-opus-4-6",
    "scout": "claude-opus-4-6",
    "architect": "claude-opus-4-6",
    "worker": "claude-sonnet-4-6",
    "reviewer": "claude-sonnet-4-6",
    "fast-scout": "claude-sonnet-4-6",
    "executor": "claude-sonnet-4-6",
    "explorer": "claude-haiku-4-5-20251001",
    "verifier": "claude-sonnet-4-6",
    "code-reviewer": "claude-opus-4-6",
    "security-reviewer": "claude-sonnet-4-6",
    "test-engineer": "claude-sonnet-4-6"
  },
  "quiet_level": 0
}
```

**You only need to include the roles you want to change.** Omitted roles use the defaults above.

**Per-project config** — overrides global for a specific workspace:

Create `{project}/.oh-my-link/config.json` with the same format. Project values override global values, which override defaults.

```json
// .oh-my-link/config.json (per-project)
{
  "models": {
    "worker": "claude-opus-4-6"
  },
  "quiet_level": 1
}
```

#### Examples

**Budget mode** — use Sonnet everywhere:
```json
{
  "models": {
    "master": "claude-sonnet-4-6",
    "scout": "claude-sonnet-4-6",
    "architect": "claude-sonnet-4-6",
    "code-reviewer": "claude-sonnet-4-6"
  }
}
```

**Maximum quality** — use Opus everywhere:
```json
{
  "models": {
    "worker": "claude-opus-4-6",
    "reviewer": "claude-opus-4-6",
    "fast-scout": "claude-opus-4-6",
    "executor": "claude-opus-4-6",
    "explorer": "claude-opus-4-6",
    "verifier": "claude-opus-4-6",
    "security-reviewer": "claude-opus-4-6",
    "test-engineer": "claude-opus-4-6"
  }
}
```

#### Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `models` | `object` | See table above | Model ID per agent role |
| `quiet_level` | `number` | `0` | `0` = verbose, `1` = less output, `2` = minimal |

Config locations (merged in order, later overrides earlier):
1. `~/.oh-my-link/config.json` (global) or `$OML_HOME/config.json`
2. `{project}/.oh-my-link/config.json` (per-project override)

---

## Commands

| Command | Description |
|---------|-------------|
| `start link <request>` | Full 7-phase pipeline for complex tasks |
| `start fast <request>` | Lightweight mode for simple tasks |
| `cancel oml` | Cancel the active session |
| `setup oml` | Run the setup wizard |
| `doctor oml` | Diagnose plugin health |
| `update oml` | Update the plugin |
| `fetch docs <topic>` | Fetch external documentation |
| `learn this` | Save a reusable pattern from this session |

**Aliases:** `startlink`, `full mode`, `deep mode`, `oml` also trigger Start Link. `startfast`, `quick start`, `fast mode`, `light mode` also trigger Start Fast.

---

## Skills

| Skill | Purpose |
|-------|---------|
| `using-oh-my-link` | Start Link bootstrap and entry point |
| `mr-light` | Start Fast bootstrap and entry point |
| `master` | Master Orchestrator (7-phase enforcement) |
| `scout` | Phase 1 — Socratic exploration |
| `fast-scout` | Start Fast — rapid analysis |
| `architect` | Phases 2-4 — planning and decomposition |
| `worker` | Phase 5 — single-task implementation |
| `reviewer` | Phase 6 — per-task review and full-feature review |
| `validating` | Phase 4 — pre-execution verification |
| `swarming` | Phase 5 (parallel) — orchestrated concurrent workers |
| `compounding` | Phase 7 — structured learning capture |
| `debugging` | Error recovery — triage, reproduce, diagnose, fix |
| `prompt-leverage` | Automatic prompt enhancement (both modes) |
| `cancel` | Cancel active session |
| `doctor` | Diagnose workspace health |
| `setup` | Initialize workspace and prerequisites |
| `statusline` | Live HUD configuration |
| `external-context` | Fetch and inject external docs |
| `learner` | Pattern learning and extraction |
| `update-plugin` | Plugin self-update |

---

## Features

| Feature | How It Works |
|---------|-------------|
| **Task Engine** | Task JSONs in `.oh-my-link/tasks/` with status flow: `pending` → `in_progress` → `done` / `failed` |
| **File Locking** | `mkdir`-based atomic mutex with 30s TTL. Workers must acquire locks before editing. |
| **Messaging** | JSON message files in `.oh-my-link/messages/` with thread-based routing |
| **Session State** | `session.json` at `~/.oh-my-link/projects/{hash}/` tracks phase, counters, failures |
| **Plugin Root Resolution** | 3-strategy resolution: `CLAUDE_PLUGIN_ROOT` → `~/.oh-my-link/setup.json` → `__dirname` inference |
| **Auto Phase Tracking** | Subagent lifecycle hooks automatically advance session phase (forward-only) |
| **Prompt Leverage** | Every invocation auto-augments your prompt with guardrails, constraints, and success criteria |
| **Learnings** | Patterns extracted from sessions are saved and loaded in future sessions (compounding flywheel) |

### Live Statusline

The plugin includes a HUD that shows real-time progress:

```
╭─ OML v0.8.1 ✧ Start.Link ✧ Phase 5: Execution
╰─ Ctx: [♥♥♥♥♡♡♡♡♡♡] 42% ┊ Session: 9m ┊ Agents: SAW ┊ R:0 F:0
```

---

## Project Structure

```
Oh-My-Link/
├── src/                  # TypeScript source
│   ├── hooks/            # 10 Claude Code hook handlers
│   ├── helpers.ts        # Shared utilities
│   ├── state.ts          # Path and state management
│   ├── types.ts          # Type definitions
│   ├── task-engine.ts    # File-based task + lock system
│   ├── statusline.ts     # Live HUD renderer
│   ├── config.ts         # Model configuration system
│   └── prompt-leverage.ts # Prompt augmentation framework
├── scripts/
│   └── run.cjs           # Hook runner wrapper (marketplace-safe)
├── agents/               # 12 agent prompt definitions
├── skills/               # Skill definitions (20+ skills)
├── hooks/
│   └── hooks.json        # Hook wiring configuration
├── test/                 # 138+ tests across 4 suites
├── .claude-plugin/       # Marketplace manifest
└── .oh-my-link/          # Runtime artifacts (per-project, not committed)
    ├── plans/            # CONTEXT.md, plan.md, review.md
    ├── tasks/            # Task JSONs
    ├── locks/            # File locks
    ├── messages/         # Agent messaging threads
    └── history/          # Session history, learnings
```

---

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Links** | Tasks in the task graph. Each link has an ID, file scope, acceptance criteria, and dependencies. |
| **Gates** | Human-in-the-loop checkpoints (G1, G2, G3). Nothing proceeds without your approval. |
| **Review Gate** | Workers don't auto-complete tasks. The Reviewer must issue a PASS verdict first. |
| **File Locking** | Atomic mutex prevents concurrent edits. Workers acquire locks before writing. |
| **Prompt Leverage** | Every invocation auto-augments your prompt with guardrails, constraints, and success criteria. |
| **Learnings** | Patterns extracted from sessions are saved and loaded in future sessions (compounding flywheel). |

---

## Hooks

OML registers 10 hooks into the Claude Code lifecycle:

| Hook Event | Script | Purpose |
|------------|--------|---------|
| `UserPromptSubmit` | `keyword-detector.js` | Detect `start link`, `start fast`, `cancel oml` triggers |
| `UserPromptSubmit` | `skill-injector.js` | Inject learned skills into context |
| `SessionStart` | `session-start.js` | Load project memory and session state |
| `PreToolUse` | `pre-tool-enforcer.js` | Role-based tool/path restrictions |
| `PostToolUse` | `post-tool-verifier.js` | Hot path tracking, skill feedback |
| `PostToolUseFailure` | `post-tool-failure.js` | Track and handle tool failures |
| `Stop` | `stop-handler.js` | Phase continuation, cancel signal, terminal detection |
| `PreCompact` | `pre-compact.js` | Save state before context compaction |
| `SubagentStart/Stop` | `subagent-lifecycle.js` | Agent role detection, phase advance, auto-completion |
| `SessionEnd` | `session-end.js` | Cleanup, release locks, archive session |

All hooks use the `run.cjs` wrapper for marketplace-safe path resolution — no absolute paths committed.

---

## Prerequisites

- **Node.js 18+** — all scripts are zero-dependency
- **Claude Code** — the plugin host environment

---

## Testing

```bash
npm run build
node test/run-tests.mjs           # 106 core tests
node test/test-run-cjs.mjs        # 6 hook runner tests
node test/test-phase-tracking.mjs # 16 phase tracking tests
node test/test-new-features.mjs   # 11 resolution & config tests
```

139 tests across 4 suites covering keyword detection, tool enforcement, state management, task engine, file locking, prompt leverage, session lifecycle, phase tracking, hook runner resolution, plugin root resolution, and per-project config merge.

---

## Troubleshooting

Run the doctor skill to diagnose workspace issues:

```
doctor oml
```

This checks hook configuration, state file integrity, agent definitions, and directory structure.

---

## Credits

Built by studying the [Claude Code source code leak](https://github.com/anthropics/claude-code) to understand the hook system, subagent lifecycle, and plugin architecture.

---

## License

MIT

---

<p align="center">
  <sub>Built for Claude Code</sub>
</p>
