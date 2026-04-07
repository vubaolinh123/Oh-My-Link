# Changelog

All notable changes to Oh-My-Link are documented here.

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
