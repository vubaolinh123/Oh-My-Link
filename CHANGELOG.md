# Changelog

All notable changes to Oh-My-Link are documented here.

## [v0.11.1] — Fix Claude Code Marketplace Schema

**Patch release: makes the plugin installable via `Manage Plugins → Add Marketplace URL`.**

### Fixed
- `.claude-plugin/marketplace.json` was rejected by Claude CLI with `owner: Invalid input: expected object, received undefined`
- Added required `owner` object (`name`, `url`)
- Renamed plugin entry `path` → `source` to match the official schema
- Moved description/version into `metadata` per schema
- Synced version across `package.json`, `plugin.json`, and `marketplace.json`

### Install
Add `https://github.com/vubaolinh123/Oh-My-Link` as a marketplace URL in Claude Code (`/plugin marketplace add ...`).

---

## [v0.11.0] — HITL Gates, Review→Fix Loop, Lazy Artifact Dirs

**Workflow correctness fixes for Start Link mode + cleanup of accidental remote bloat.**

### Fixed: HITL Gate Transitions on Subagent Stop

- Scout exploration finishing now transitions session to `gate_1_pending` with `awaiting_confirmation=true`
- Scout synthesis (CONTEXT.md produced) advances to `phase_2_planning`
- Architect planning (plan.md produced) → `gate_2_pending` + awaiting
- Verifier validation done → `gate_3_pending` + awaiting
- Resolves the spam-reinforcement loop where Master kept getting blocked at gates because `awaiting_confirmation` was never set on subagent stop

### New: Review→Fix Loop Enforced at Hook Level

- Reviewer `VERDICT: FAIL` at `phase_6_review` regresses session to `phase_5_execution` and increments `revision_count` so Master re-spawns Worker with feedback
- Circuit breaker at `MAX_REVISIONS=3` sets `awaiting_confirmation=true` to escalate
- Replaces the previous LLM-instruction-only behavior that was unreliable

### Changed: Lazy Folder Creation

- `ensureArtifactDirs` no longer pre-creates empty `.oh-my-link/history/` and `.oh-my-link/context/`
- They are created on demand by the skills that actually use them

### Fixed: Restored Model Tier Differentiation

- `DEFAULT_MODELS` (config.ts) and `DEFAULT_MODEL_BINDINGS` (model-provider.ts) restored:
  master/scout/architect/code-reviewer = Opus 4.7;
  reviewer/verifier/security-reviewer/worker/executor = Sonnet 4.6;
  fast-scout/explorer = Haiku 4.5
- Aligns Anthropic-direct fallback with Ollama Cloud role intent

### Cleanup

- Removed 50 `mempalace-main/*` files accidentally committed to the remote in the previous Ollama-fix commit

### Tests

- 4 gate-transition tests
- 5 review-loop tests (FAIL regress, FAIL circuit-break, PASS preserve, MINOR preserve)
- Lazy artifact dir test
- Full suite: **551 passed / 0 failed / 5 skipped (35/35 files)**

---

## [v0.9.8] — Session Audit, Locked-Field Hardening & Debug Diagnostics

**Instrumentation to track session.json corruption + raw hook payload capture for diagnosing tool_output=0.**

### New: Session-Write Audit

- Every write to `session.json` is now logged to `~/.oh-my-link/session-write-audit.log`
- Audit entries include: timestamp, PID, argv, phase/active/mode, and a 3-frame stack trace
- Auto-rotates at 200KB to prevent unbounded growth
- New exported helper: `sessionWriteAudit(sessionPath, message)`

### New: locked_* Field Hardening

- `writeJsonAtomic` now preserves `locked_mode` and `locked_phase` from existing `session.json`
- If incoming data tries to overwrite locked fields → old values restored + `LOCKED_FIELD_CORRECTED` audit entry
- If incoming data omits locked fields → old values carried forward automatically
- Prevents LLM or buggy hooks from corrupting session role inference

### New: Raw Hook Payload Capture

- `parseHookInput()` now writes raw stdin payloads to `~/.oh-my-link/debug/payloads/` when `debug_mode` is on
- Each payload saved as `{timestamp}-{hookname}-{pid}.json` (capped at 200KB)
- Directory auto-cleaned to max 50 files
- Enables diagnosing what Claude Code actually sends in hook payloads

### New: Raw Key Diagnostics

- `post-tool-verifier` logs `post-tool-raw` with all keys Claude Code sends + `has_tool_output` flag
- `pre-tool-enforcer` logs `pre-tool-raw` with all incoming keys
- Purpose: confirm Claude Code's actual hook payload schema (suspected `tool_output` is never sent)

### Changed: Extracted `isDebugMode()` Helper

- Replaces duplicated config-reading logic in `debugLog` and payload capture
- Checks both global and project-level config
- Exported for use in tests and other modules

### Tests

- New test file: `test/test-session-audit.mjs` — 12 tests (3 skipped) covering session audit, locked_* hardening, and isDebugMode
- Total test count: 421 passed (up from 409), 1 pre-existing flaky failure in test-statusline

## [v0.9.7] — Open MCP Registry

**MCP management system: users can register any MCP server and control agent→MCP priority.**

### New: Open MCP Registry (`src/mcp-config.ts`)

- **Open, not hardcoded**: Users register ANY MCP server (not just built-in suggestions) via `oml setup` or by editing `~/.oh-my-link/mcp-config.json`
- **Per-role mapping**: Configure which agents use which MCPs, in priority order, with custom guidance text per role
- **3-layer config merge**: defaults ← global (`~/.oh-my-link/mcp-config.json`) ← per-project (`{cwd}/.oh-my-link/mcp-config.json`)
- **Full CRUD API**: `registerProvider`, `removeProvider`, `setProviderInstalled`, `addMcpToRole`, `removeMcpFromRole`, `setRoleMcps`
- **5 suggested providers ship as defaults** (context7, grep_app, playwright, augment-context-engine, browser-use) — users can add/remove freely

### New: Dynamic MCP Injection

- `subagent-lifecycle.ts` now calls `getMcpGuidanceForRole()` on every `SubagentStart` event
- MCP guidance is appended to the hook's `additionalContext` — agents see which MCPs are available and how to use them
- Only **installed** MCPs appear in guidance; uninstalled ones are silently omitted

### Changed: Agent Skill Files

- All 10 agent .md files (scout, fast-scout, explorer, architect, worker, executor, reviewer, code-reviewer, security-reviewer, test-engineer) now use a short dynamic reference instead of hardcoded MCP blocks
- MCP guidance is resolved at runtime from `mcp-config.json` via the hook system

### Changed: Setup Skill

- Added Phase D (MCP Configuration) to the setup wizard
- Users can mark installed MCPs, add custom MCPs, and configure role mappings during `oml setup`
- MCP config is global (one-time setup) with optional per-project overrides

### Tests

- New test file: `test/test-mcp-config.mjs` — 29 tests across 7 suites covering the full MCP config module
- Total test count: 409 passed (up from 380)

## [v0.9.6] — Fix Role Inference & Remove Dead Hook Enforcement

**Root-cause fixes for three interconnected bugs discovered from real workflow debug logs.**

### Problem
From a real `start fast` workflow run, debug logs revealed:
1. `role=none` on every `pre-tool` call — role enforcement completely bypassed
2. First agent always inferred as `worker`, causing phase to jump to `phase_5_execution`
3. All subsequent agents also inferred as `worker` — no scouts, architects, or reviewers

### Root Cause
Claude Code hooks are **separate Node.js processes** per invocation. The `OML_AGENT_ROLE` env var was never set by CC's runtime — it appeared in SubagentStart payloads but not as a process env var. This meant:
- `pre-tool-enforcer` role restrictions: 100% dead code
- `keyword-detector` subagent guard: unreachable
- File locking `OML_AGENT_ID`: always fell through to `agent-${process.pid}` (different PID per hook)

Additionally, the imperative prompt instructed Claude to "Update session.json phase at every transition" — Claude would overwrite `current_phase` with invented values, corrupting `inferRoleFromSession()`.

### Fixes

#### P0: Immutable session fields (`locked_mode`, `locked_phase`)
- Added `locked_mode` and `locked_phase` to `SessionState` — set once at session creation
- `inferRoleFromSession()` reads locked fields first (immune to LLM overwriting)
- `locked_phase` cleared after first successful inference so subsequent agents use `current_phase` (managed by hooks)

#### P1: Removed session management from imperative prompts
- `buildStartLinkPrompt`: "Update session.json phase at every transition" → "DO NOT write to session.json — the OML hook system manages phase transitions automatically"
- This eliminates the root cause of phase corruption

#### P2: Gutted dead role enforcement from pre-tool-enforcer
- Removed `ROLE_RESTRICTIONS` constant and all role-based tool/file blocking
- Removed `OML_AGENT_ROLE` env var reading (never set by CC)
- Pre-tool-enforcer now does only: Bash hard-block patterns + file locking
- Role enforcement is prompt-based (via `[OML:role]` tags in agent descriptions)

#### P3: Fixed file locking identity
- Uses `agent_id` from hook input payload instead of `process.env.OML_AGENT_ID`
- Falls back to `hook-${process.pid}` (honest about the identity)

### Test Results
- 379 tests passing across 20 files (18/20 green, 1 pre-existing statusline timeout, 1 skipped)
- Updated 15+ tests to reflect removed role enforcement (dead code → passing correctly)

## [v0.9.5] — HITL Gate UX: Seamless User Interaction at Gates

**Fixes the UX issue where Claude presents gate questions then freezes for minutes instead of stopping cleanly for user input.**

### Problem
At HITL gates (Gate 1/2/3), Claude would:
1. Present questions as text
2. "Cogitate" for 4+ minutes deciding what to do
3. Eventually stop with no indication it's waiting for user input
4. User's typed answer on next turn had no pipeline context

### Fixes

#### Gate Instructions (keyword-detector)
- Gate 1: Now explicitly says "END YOUR RESPONSE IMMEDIATELY after presenting questions" + shows `⏳ Vui lòng trả lời...` prompt
- Gate 2: Same pattern — end response immediately, show waiting prompt
- Gate 3: Same pattern for execution mode choice

#### Gate Continuation (keyword-detector)
- **New feature**: When user types during an active gate phase (`gate_1_pending`, `gate_2_pending`, `gate_3_pending`), keyword-detector now:
  1. Detects the session is at a gate via `isGatePhase()`
  2. Builds rich continuation context via `buildGateContinuationContext()` containing:
     - User's raw answer
     - Explicit next steps (which agent to spawn, what to update)
     - Orchestrator rules reminder
  3. Clears `awaiting_confirmation` flag
  4. Injects as plain stdout so Claude continues the pipeline seamlessly
- Works both with always-on mode AND without keyword match

#### Stop Handler
- At gate phases with `awaiting_confirmation`, stop handler now outputs descriptive message (e.g., "Waiting for your answers to the Scout questions above") instead of silent allow

### Tests
- 394 tests passing (19/20 files green)

## [v0.9.4] — Session-Aware Role Inference (Fixes Phase Skip Bug)

**Fixes critical bug where SubagentStart lacks description/prompt → role misdetected → phase skip.**

### Root Cause (from production debug logs)
Claude Code's `SubagentStart` hook payload only contains 6 fields: `session_id`, `transcript_path`, `cwd`, `agent_id`, `agent_type`, `hook_event_name`. The `description` and `prompt` fields that OML relies on for role detection are **not included** — both are empty strings. This means the `[OML:role-name]` tags embedded in agent descriptions never reach the hook.

With `agent_type="general-purpose"` and no description, `detectRole()` blindly mapped to `worker`, causing:
- Start Fast: phase jumped `light_scout` → `light_execution` (skipping fast-scout entirely)
- Start Link: similar phase skips for scout/architect roles

### Fix: Session-Aware Role Inference
When `agent_type` is `general-purpose` (or any builtin) AND description is empty, `handleStart()` now uses the **session's current phase + mode** to infer the expected agent role:
- `mylight` + `light_scout` + `standard` intent → `fast-scout`
- `mylight` + `light_scout` + `turbo` intent → `executor`
- `mylink` + `bootstrap` → `scout`
- `mylink` + `gate_1_pending` → `architect`
- etc.

This is deterministic: at each phase, exactly one role is expected next.

### Performance Analysis (from same debug session)
- OML hook overhead: **<100ms per tool call** (pre-tool + post-tool)
- 14-minute total time was 100% Claude API latency (1.5–3 min "thinking" between tool calls)
- OML contributed <2s of the 14-minute total

### Tests
- 4 new tests for session-aware role inference (all passing)
- Total: 394 tests passing

## [v0.9.3] — Plain Stdout Injection for Imperative Orchestration

**Switches keyword-detector from soft `additionalContext` to plain text stdout — the strongest prompt injection mechanism in Claude Code's hook system.**

### Critical Change: Prompt Injection Strategy
- **keyword-detector now uses `promptContextOutput()`** (plain text stdout) instead of `hookOutput()` (JSON `additionalContext`) for imperative orchestration prompts. Per Claude Code docs, plain text stdout is shown as visible context in the transcript, making it far more likely that Claude follows the orchestration instructions and spawns subagents.
- This applies to all three modes: Turbo, Standard Fast, and Start Link.

### Improved Agent Spawning Instructions
- All three prompt builders (`buildTurboPrompt`, `buildStandardFastPrompt`, `buildStartLinkPrompt`) now include a **"HOW TO SPAWN AN AGENT"** section with explicit Task tool parameters (`subagent_type`, `description`, `prompt`), making it unambiguous how Claude should call the Agent/Task tool.

### Test Suite Updates
- Updated 9 tests across `run-tests.mjs`, `integration-hooks.mjs`, and `new-tests-1.mjs` to handle plain text output from keyword-detector instead of JSON parsing.
- All 390 tests passing (1 pre-existing statusline timeout unrelated to this change).

## [v0.9.2] — Critical Regression Fix + Diagnostic Logging

**Fixes v0.9.1 regression where subagent Edit/Write was blocked by pre-tool-enforcer.**

### Critical Fix
- **Revert master role inference in pre-tool-enforcer**: The v0.9.1 change to infer `role=master` when OML session is active caused ALL tool calls (including subagent Edit/Write) to be blocked, since PreToolUse hooks cannot distinguish root session from subagent processes. Root session orchestrator behavior is now enforced solely via imperative prompt rewrite.

### Improved Role Detection
- Expand SubagentStart field extraction: try `type`, `agentDescription`, `taskDescription`, `agentPrompt`, `taskPrompt` in addition to existing field names — defensive against Claude Code payload variations
- Add raw payload diagnostic logging (`agent-start-raw`) to debug.log: dumps all non-empty keys, agent_type, description snippet, and prompt start so actual SubagentStart payloads can be inspected

### Known Issue
- `detectRole` still returns `worker` for all `general-purpose` agents when SubagentStart doesn't include description/prompt fields. This causes phase tracking to skip `light_scout` and jump to `light_execution`. Diagnostic logging added to capture real payload structure for next fix.

## [v0.9.1] — Role Detection, Model Routing & Cancel Cleanup

Fixes critical production issues found in v0.9.0 field testing.

### Role Detection (3 fixes)
- Add `[OML:role-name]` tag system: imperative prompts now embed role tags in agent descriptions (e.g. `[OML:fast-scout]`, `[OML:executor]`) for reliable detection regardless of Claude's agent naming
- Fix `detectRole()`: handle `general-purpose` agent type (was only matching `general`), add prefix-match fallback for suffixed variants
- Fix `pre-tool-enforcer`: infer `master` role for root session when OML session is active — blocks root from Edit/Write (enforces orchestrator-only behavior)

### Model Routing
- Add `getModelInstruction()` helper: generates per-role model instructions from config
- Imperative prompts now include explicit model parameters for each spawned agent (e.g. "Set model to: claude-sonnet-4-6")
- Fixes issue where all subagents used Opus instead of configured Sonnet/Haiku per role

### Agent Failure Recovery
- Add "IF EXECUTOR FAILS" section to all imperative prompts
- Orchestrator is now instructed to re-spawn agents on failure instead of implementing fixes itself
- After 3 failures, instructs user to try `start link` for complex tasks

### BRIEF.md Path Consistency
- Unify Fast Scout output path to `.oh-my-link/plans/BRIEF.md` across all sources:
  - `agents/fast-scout.md`: was `.oh-my-link/context/BRIEF.md` → fixed
  - `agents/executor.md`: was `.oh-my-link/context/BRIEF.md` → fixed  
  - `subagent-lifecycle.ts`: was expecting `CONTEXT.md` → fixed to `BRIEF.md`
  - Imperative prompts and skill files already used correct path

### Cancel Cleanup
- `cancel oml` now releases expired locks via `cleanExpiredLocks()`
- `cancel oml` now marks all in-progress/pending tasks as `failed`
- `cancel oml` now sets `deactivated_reason: 'user_cancelled'` on session

## [v0.9.0] — Imperative Agent Orchestration

**Breaking change in how the plugin instructs Claude to delegate work.**

Previously, OML injected skill instructions via `additionalContext` — which Claude treated as soft guidance and often ignored, resulting in the root session doing all work itself instead of spawning subagents.

Now, OML rewrites the user prompt into explicit, imperative orchestration instructions:
- "Use the Agent tool to spawn a Fast Scout subagent with this prompt: ..."
- "Use the Agent tool to spawn an Executor subagent with this prompt: ..."
- "You are the orchestrator — never read source code, never write/edit code files"

This ensures Claude treats agent spawning as its PRIMARY task, not optional guidance.

### Changes
- Replace `additionalContext` skill injection with imperative prompt rewrite in `keyword-detector.ts`
- Add `buildImperativePrompt()` dispatcher with 3 prompt builders:
  - `buildTurboPrompt()` — single Executor spawn for trivial fixes
  - `buildStandardFastPrompt()` — Fast Scout → read BRIEF.md → Executor pipeline
  - `buildStartLinkPrompt()` — full 7-phase Master orchestration with explicit Agent tool instructions
- Non-orchestration actions (doctor, setup, cancel, debug, etc.) still use original skill injection
- Fix debug mode toggle to show actual debug log path and project hash
- Update tests to match new output format (OML START LINK / OML START FAST)

## [v0.8.1] — Resilient Resolution & Per-Project Config

- Add `resolvePluginRoot()` to `state.ts` — 3-strategy plugin root resolution (env var → setup.json → __dirname)
- Refactor `keyword-detector.ts` and `statusline.ts` to use `resolvePluginRoot()` instead of fragile `__dirname`
- Add setup.json fallback to `run.cjs` — reads `~/.oh-my-link/setup.json` pluginRoot when `CLAUDE_PLUGIN_ROOT` is unset/stale
- Add semver-aware sorting to `run.cjs` version directory scanning (replaces naive lexicographic sort)
- Add per-project config support — `{project}/.oh-my-link/config.json` overrides global `~/.oh-my-link/config.json`
- Update `loadConfig()` and `getModelForRole()` to accept optional `cwd` for project-level merge
- Add `loadProjectConfig()` export to `config.ts`
- Add 11 new tests (`test/test-new-features.mjs`): semver sort, setup.json fallback, resolvePluginRoot, config merge
- Total test count: 139 across 4 suites

## [v0.8.0] — Install Once, Use Everywhere

- Add global project registry (`~/.oh-my-link/projects/registry.json`) — auto-tracks all workspaces
- Add `registerProject()` and `listProjects()` to state engine
- Add `ProjectEntry` and `ProjectRegistry` types
- Session-start hook now auto-registers workspace on every session
- Add `oml list` command — view all registered workspaces with status
- Add `list-projects` skill (`skills/list-projects/SKILL.md`)
- Add fast-path to setup wizard (A-FAST) — skip setup if already configured globally
- Add `test/run-all.mjs` — aggregate test runner for all 19 test files (375+ tests)
- Add `npm run test:all` script

## [v0.7.0] — Marketplace-Ready Release

- Rewrite README.md with full agent roster, model configuration guide, and marketplace instructions
- Add custom model configuration documentation (`~/.oh-my-link/config.json`)
- Add Credits section (Claude Code source code leak)
- Bump all manifests to v0.7.0

## [v0.6.0] — Documentation & Packaging

- Rewrite README.md with workflow diagram and usage guide
- Add AGENTS.md with full agent/hook/session reference
- Add CHANGELOG.md with version history
- Add workflow diagram (`image/workflow.png`)

## [v0.5.0] — Test Suite & CI

- Add 106 core tests (state, helpers, config, task-engine, hooks, memory, prompt-leverage)
- Add 6 tests for `run.cjs` hook runner wrapper
- Add 16 tests for phase tracking, auto-completion, detectRole
- Add CI workflow (`.github/workflows/test.yml`) with absolute-path guard
- Add stress tests for file locking concurrency

## [v0.4.0] — Hook Wiring & Runtime

- Add `hooks/hooks.json` with canonical `${CLAUDE_PLUGIN_ROOT}` variable (no absolute dev paths)
- Add `scripts/run.cjs` hook runner wrapper (resolve target, scan version dirs, local dev fallback)
- Add `.claude-plugin/plugin.json` marketplace manifest
- Add `.claude/settings.json` with minimal permissions

## [v0.3.0] — Agent Definitions & Skills

- Add 12 agent role definitions (`agents/*.md`): master, scout, fast-scout, architect, worker, reviewer, explorer, executor, verifier, code-reviewer, security-reviewer, test-engineer
- Add 18 skill files (`skills/*/SKILL.md`): master, scout, fast-scout, architect, worker, reviewer, cancel, compounding, debugging, doctor, external-context, learner, mr-light, prompt-leverage, setup, statusline, swarming, update-plugin, using-oh-my-link, validating

## [v0.2.0] — Hook System & Statusline

- Add keyword-detector hook (detects `start link`, `start fast`, `cancel oml`)
- Add session-start / session-end lifecycle hooks
- Add pre-tool-enforcer (role-based tool/path restrictions)
- Add post-tool-verifier (hot path tracking, skill feedback)
- Add post-tool-failure handler
- Add stop-handler (phase continuation, cancel signal, terminal phase detection)
- Add pre-compact hook (state preservation before context compaction)
- Add skill-injector hook
- Add subagent-lifecycle hook (detectRole, auto-phase-advance, auto-completion, lock release)
- Add statusline renderer (phase, agents, context bar, recent agents display)

## [v0.1.0] — Core Engine

- Add project scaffolding (`package.json`, `tsconfig.json`, `.gitignore`)
- Add state management (`src/state.ts` — path normalization, project hashing, directory resolution)
- Add helpers (`src/helpers.ts` — JSON I/O, text clipping, phase detection, elapsed time)
- Add task engine (`src/task-engine.ts` — CRUD, file locking with mkdir mutex, dependency resolution)
- Add project memory (`src/project-memory.ts` — hot paths, directives, environment detection)
- Add prompt leverage (`src/prompt-leverage.ts` — task type detection, framework generation)
- Add config (`src/config.ts` — model resolution per role)
- Add type definitions (`src/types.ts` — HookInput, session, task types)
