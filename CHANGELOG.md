# Changelog

All notable changes to Oh-My-Link are documented here.

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
