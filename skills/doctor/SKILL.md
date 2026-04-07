---
name: doctor
description: Diagnostic suite for Oh-My-Link workspace health -- checks runtime state, locks, tasks, hooks, build, and path resolution
---

<Purpose>
Run a full health check on the Oh-My-Link installation and active session.
Reports PASS/WARN/FAIL per check and offers auto-fix for common issues.
Useful after errors, unexpected stops, or before starting a complex workflow.
</Purpose>

<Use_When>
- User says `doctor oml` or `doctor oh-my-link`
- Something seems broken or stuck (especially "hook error" messages)
- After an interrupted session to detect orphaned state
- Routine health verification before starting a new feature
</Use_When>

<Steps>

## Step 1 -- Plugin root and build check

Determine the plugin root (from `~/.oh-my-link/setup.json` -> `pluginRoot` field,
or from current directory if `.claude-plugin/plugin.json` exists).

Check that `{pluginRoot}/dist/hooks/keyword-detector.js` exists.
Compare mtimes: any `src/**/*.ts` newer than the newest `dist/**/*.js`?

FAIL if dist/ does not exist.
WARN if build is stale (src newer than dist). Suggest: `npm run build`.
PASS if dist/ is up-to-date.

## Step 2 -- Hook path validation

Read `.claude/settings.json`. For each of the 10 hook events:

1. Check the hook entry exists
2. Check the hook command path resolves to an actual file on disk
3. Check the path is absolute (not relative, not using `${CLAUDE_PLUGIN_ROOT}`)

**Common failure modes:**
- `${CLAUDE_PLUGIN_ROOT}` in path -> "Variable not resolved. Run `setup oml` to fix."
- Relative path (`dist/hooks/...`) -> "Only works from plugin directory. Run `setup oml` to fix."
- Absolute path to non-existent file -> "Plugin may have been moved. Run `setup oml` to fix."
- Missing hook entry -> "Hook not wired. Run `setup oml` to fix."

PASS if all 10 hooks are wired with valid absolute paths.
WARN/FAIL otherwise with specific guidance per hook.

## Step 3 -- Runtime directory check

Compute project hash and check that `~/.oh-my-link/projects/{hash}/` exists.
Check for: `session.json`, `project-memory.json`.

PASS if all exist, WARN if directory exists but files missing, FAIL if missing entirely.

## Step 4 -- Artifact directory check

Verify in project root: `.oh-my-link/` with 6 subdirectories
(plans, history, tasks, locks, context, skills).

Report count present vs expected (6). Offer `mkdir -p` for missing ones.

## Step 5 -- Session state validity

Read `session.json`. Attempt JSON parse. Check required fields:
`active`, `mode`, `current_phase`, `started_at`.

FAIL if invalid JSON or missing required fields.
WARN if `active: true` but `started_at` > 24h ago (stale session).

## Step 6 -- Orphaned lock files

Read all files in `.oh-my-link/locks/`. Check `expires_at` timestamps.
WARN if any expired locks exist. Offer to delete them.

## Step 7 -- Orphaned tasks

Read all files in `.oh-my-link/tasks/`. For each `in_progress` task,
check if a corresponding subagent is still running.
WARN if tasks are in_progress with no active subagent. Offer to mark as `failed`.

## Step 8 -- Dependency cycle check

Load all task files. Build dependency graph. Run DFS cycle detection.
FAIL if cycles detected. PASS if clean.

## Step 9 -- Summary report

```
Check                          Status   Detail
------------------------------------------------------
Plugin root + build            PASS     D:/Oh-My-Link, fresh
Hook paths (10/10)             WARN     2 hooks use relative paths
Runtime dirs                   PASS
Artifact dirs (6/6)            PASS
Session state                  PASS     active, phase_5_execution
Orphaned locks                 PASS     0 expired
Orphaned tasks                 WARN     1 stale in_progress
Dependency cycles              PASS
------------------------------------------------------
Overall: 6 PASS  2 WARN  0 FAIL
```

For each WARN/FAIL with an auto-fix available, prompt user before applying.
For hook path issues, recommend: `setup oml` (the setup wizard handles path repair).

</Steps>

<Tool_Usage>
- Bash: stat for mtime comparisons, node -e for JSON parse checks, file existence tests
- Read: session.json, task files, lock files, settings.json, setup.json
- Write: only when auto-fixing (delete expired locks, update task status)
- No Agent spawning -- doctor runs diagnostics in the current session
</Tool_Usage>
