---
name: setup
description: Interactive 3-phase setup wizard for Oh-My-Link — checks prerequisites, wires hooks with absolute paths, creates dirs, configures CLAUDE.md
level: 4
model: claude-sonnet-4-6
trigger: "setup oml|setup oh-my-link|oml setup"
---

<Purpose>
Interactive 3-phase setup wizard for Oh-My-Link. Validates prerequisites (Node.js, TypeScript build),
wires hooks, creates directories, configures CLAUDE.md, and tracks completion state. Designed to be
idempotent — running it twice is safe. Supports re-run after plugin update to refresh configs.
</Purpose>

<Use_When>
- First-time installation of Oh-My-Link
- After plugin update (session-start shows `[UPDATE]` banner)
- When hooks or directories are missing or misconfigured
- User says "setup oml", "setup oh-my-link", or "oml setup"
</Use_When>

<Do_Not_Use_When>
- Oh-My-Link is already fully configured (all checks pass)
- User wants to diagnose issues (use `doctor oml` instead)
- User wants to start a workflow (use `start link` or `start fast` keywords)
</Do_Not_Use_When>

<Critical_Design_Notes>

### Hook Path Resolution — ABSOLUTE PATHS REQUIRED

Oh-My-Link hooks MUST use **absolute paths** in the hook command strings written to
`.claude/settings.json`. This is because:

1. `${CLAUDE_PLUGIN_ROOT}` is NOT resolved by Claude Code for project-level hooks
2. Relative paths only work when cwd matches the plugin root — they FAIL when
   the user opens Claude Code from a different working directory
3. OML uses `${CLAUDE_PLUGIN_ROOT}` which works via its CJS wrapper (`run.cjs`) —
   ensure the wrapper is present

**The correct hook command format is:**
```
node "<absolute-path-to-plugin>/dist/hooks/<hook-name>.js"
```

Example (Windows):
```
node "D:/Oh-My-Link/dist/hooks/keyword-detector.js"
```

Example (Unix):
```
node "/path/to/oh-my-link/dist/hooks/keyword-detector.js"
```

The setup wizard MUST:
1. Determine the absolute plugin root path (where `dist/hooks/` lives)
2. Build all hook commands using this absolute path
3. Write these absolute-path commands to `.claude/settings.json`
4. Also update `hooks/hooks.json` to match (for consistency)

### How to Determine Plugin Root

The plugin root is the directory containing `package.json`, `dist/`, `hooks/`, `skills/`, etc.
Multiple detection methods (try in order):

1. The current working directory (if `.claude-plugin/plugin.json` exists there)
2. `$OML_PLUGIN_ROOT` environment variable (if set)
3. Ask the user to provide the path

</Critical_Design_Notes>

<Execution_Policy>
- Always check before modifying — never overwrite existing valid config
- Use clear status labels: CHECK / PASS / MISSING / FIXED / SKIP
- Proceed phase by phase: A (Pre-Check) -> B (Install/Wire) -> C (Configure)
- If everything passes in Phase A, report success and skip B/C
- Track completion in `~/.oh-my-link/setup.json` for idempotency
</Execution_Policy>

<Steps>

## Phase A: Pre-Check

Run all checks and collect results before making any changes.

### A-FAST. Global "Install Once" Fast-Path

**Before running the full wizard, check if OML is already globally configured.**

1. Check `~/.oh-my-link/setup.json` — does it exist and is `setupCompleted` true?
2. Check `~/.claude/settings.json` — are OML hooks present (search for `oh-my-link` in hook commands)?
3. Check `~/.claude/CLAUDE.md` — does it contain `<!-- OML:START -->` marker?

**If ALL three pass:**

> "OML is already configured globally (installed {date}, v{version})."
> "This workspace is ready to use — no setup needed."
> "Artifact directories will be auto-created on first `start link` / `start fast`."
> 
> Use `start link` or `start fast` to begin a task.
> Use `oml list` to see all registered workspaces.
> Use `oml doctor` to diagnose any issues.

**STOP HERE. Do not continue to A0 or any other phase.**

**If any check fails:** Continue with full wizard below.

### A0. Setup Completion Gate

Check `~/.oh-my-link/setup.json`:

```
Read ~/.oh-my-link/setup.json
```

**If file exists AND `setupCompleted` is set:**

Read the plugin version from `.claude-plugin/plugin.json`.

If `setupVersion` matches the current plugin version:

> "Oh-My-Link setup is already complete (v{version}, configured {date})."
> 1. **Quick update** -- Refresh CLAUDE.md only (skip to C1)
> 2. **Full wizard** -- Re-run all checks and reconfigure
> 3. **Cancel** -- Exit

If `setupVersion` is older than the current plugin version:

> "Oh-My-Link has been updated from v{old} to v{new}."
> 1. **Update config** -- Re-run checks and update (Recommended)
> 2. **Cancel** -- Keep current config

**If file does not exist:** Proceed with full wizard.

### A1. Check Node.js Version

```bash
node --version
```

**If >= 18:** CHECK Node.js ... PASS (v{version})
**If < 18:** CHECK Node.js ... ERROR (v{version}, requires >= 18)

### A2. Determine Plugin Root Path

Find the absolute path to the Oh-My-Link plugin root directory.

```bash
# Check if current directory is the plugin root
node -e "try{require('./package.json');console.log(process.cwd())}catch{console.log('NOT_FOUND')}"
```

Verify: the directory must contain `dist/hooks/keyword-detector.js`.
If `dist/` does not exist, note that a build is needed (A8 will catch this).

Store as `PLUGIN_ROOT` for use in all subsequent steps.

**If found:** CHECK Plugin root ... PASS ({absolute_path})
**If not found:** CHECK Plugin root ... ERROR (cannot determine plugin location)

### A3. Check TypeScript Build

```bash
# Check if dist/ exists and is up-to-date
node -e "const fs=require('fs');const s=fs.statSync('src/hooks/keyword-detector.ts').mtimeMs;const d=fs.existsSync('dist/hooks/keyword-detector.js')?fs.statSync('dist/hooks/keyword-detector.js').mtimeMs:0;console.log(d>=s?'FRESH':'STALE')"
```

**If FRESH:** CHECK TypeScript build ... PASS
**If STALE or dist/ missing:** CHECK TypeScript build ... STALE (will build in Phase B)

### A4. Check `.claude/settings.json`

```
Read .claude/settings.json (project-level)
```

**If file exists:** CHECK settings.json ... PASS
**If does not exist:** CHECK settings.json ... MISSING (will create in Phase B)

### A5. Check Hooks Wiring

Read `.claude/settings.json` for existing hook entries.
For each of the 10 hook events, check if a hook command exists that points to
the correct **absolute path** of the compiled hook script.

| Hook Event | Script |
|------------|--------|
| UserPromptSubmit | keyword-detector.js AND skill-injector.js |
| SessionStart | session-start.js |
| PreToolUse | pre-tool-enforcer.js |
| PostToolUse | post-tool-verifier.js |
| PostToolUseFailure | post-tool-failure.js |
| Stop | stop-handler.js |
| PreCompact | pre-compact.js |
| SubagentStart | subagent-lifecycle.js start |
| SubagentStop | subagent-lifecycle.js stop |
| SessionEnd | session-end.js |

A hook is "wired" if the command string contains the hook script filename
(e.g., `keyword-detector.js`).

A hook has "correct paths" if the command uses an absolute path to `PLUGIN_ROOT/dist/hooks/`.

**If all hooks present with correct paths:** CHECK hooks ... PASS (10/10)
**If hooks present but wrong paths (e.g. relative or ${CLAUDE_PLUGIN_ROOT}):**
  CHECK hooks ... STALE (paths need update)
**If some missing:** CHECK hooks ... PARTIAL (X/10)
**If none present:** CHECK hooks ... MISSING

### A6. Check Artifact Directories

Check for:
- `{cwd}/.oh-my-link/plans/`
- `{cwd}/.oh-my-link/history/`
- `{cwd}/.oh-my-link/tasks/`
- `{cwd}/.oh-my-link/locks/`
- `{cwd}/.oh-my-link/context/`
- `{cwd}/.oh-my-link/skills/`

**If all exist:** CHECK artifact dirs ... PASS (6/6)
**If some missing:** CHECK artifact dirs ... PARTIAL (X/6)

### A7. Check CLAUDE.md OML Section

```
Read ~/.claude/CLAUDE.md
```

Look for `<!-- OML:START -->` and `<!-- OML:END -->` markers.

**If OML markers exist with current version:** CHECK CLAUDE.md ... PASS
**If OML markers exist with older version:** CHECK CLAUDE.md ... UPDATE
**If no OML content:** CHECK CLAUDE.md ... MISSING
**If no CLAUDE.md file:** CHECK CLAUDE.md ... MISSING (will create)

### A8. Check Version Consistency

```
Read .claude-plugin/plugin.json -> version
Read .claude-plugin/marketplace.json -> version
```

**If all match:** CHECK versions ... PASS (v{version})
**If mismatch:** CHECK versions ... WARNING

### A9. Report Summary

Present all results:

```
=== Oh-My-Link Setup Pre-Check ===

| #  | Component              | Status  | Detail                        |
|----|------------------------|---------|-------------------------------|
| A1 | Node.js                | PASS    | v22.15.0                      |
| A2 | Plugin root            | PASS    | D:/Oh-My-Link                 |
| A3 | TypeScript build       | STALE   | src newer than dist           |
| A4 | .claude/settings.json  | PASS    |                               |
| A5 | Hooks wiring           | STALE   | paths use relative/wrong form |
| A6 | Artifact dirs          | PASS    | 6/6                           |
| A7 | CLAUDE.md OML section  | MISSING |                               |
| A8 | Version consistency    | PASS    | v0.1.0                        |

Items to configure: 3
```

**If all PASS:** "Oh-My-Link is fully configured. No changes needed." -> STOP.

**If any need fixing:**

> "Found N items to configure. Shall I proceed with setup?"
> 1. **Yes, configure everything** (Recommended)
> 2. **Let me choose** -- Select which items to fix
> 3. **Cancel** -- Exit without changes

---

## Phase B: Install/Wire

Execute only for items that need fixing from Phase A.

### B1. Build TypeScript

**Only if A3 was STALE.**

```bash
cd "{PLUGIN_ROOT}" && npm run build
```

Verify: `dist/hooks/keyword-detector.js` exists after build.

Report: FIXED TypeScript build ... compiled successfully

### B2. Wire Hooks (ABSOLUTE PATHS)

**Only if A5 was MISSING, PARTIAL, or STALE.**

Build the hook configuration using **absolute paths** to `PLUGIN_ROOT/dist/hooks/`.

**CRITICAL:** Use forward slashes in paths even on Windows (Node.js handles them correctly).
Convert backslashes: `C:\path\to\plugin` -> `C:/path/to/plugin`.

The hooks configuration to write/merge into `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/keyword-detector.js\"","timeout":5},
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/skill-injector.js\"","timeout":5}
    ]}],
    "SessionStart": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/session-start.js\"","timeout":5}
    ]}],
    "PreToolUse": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/pre-tool-enforcer.js\"","timeout":3}
    ]}],
    "PostToolUse": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/post-tool-verifier.js\"","timeout":5}
    ]}],
    "PostToolUseFailure": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/post-tool-failure.js\"","timeout":3}
    ]}],
    "Stop": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/stop-handler.js\"","timeout":5}
    ]}],
    "PreCompact": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/pre-compact.js\"","timeout":5}
    ]}],
    "SubagentStart": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/subagent-lifecycle.js\" start","timeout":3}
    ]}],
    "SubagentStop": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/subagent-lifecycle.js\" stop","timeout":5}
    ]}],
    "SessionEnd": [{"matcher":"","hooks":[
      {"type":"command","command":"node \"{PLUGIN_ROOT}/dist/hooks/session-end.js\"","timeout":30}
    ]}]
  }
}
```

Replace `{PLUGIN_ROOT}` with the actual absolute path (forward slashes).

Read existing `.claude/settings.json` (or create `{}`).
Merge the hooks entries. Preserve existing non-hook keys (like `permissions`).

Also update `hooks/hooks.json` in the plugin directory to match (for consistency).

Report: FIXED hooks ... 10/10 events wired (absolute paths)

### B3. Create Artifact Directories

**Only if A6 was PARTIAL.**

```bash
mkdir -p .oh-my-link/plans .oh-my-link/history .oh-my-link/tasks .oh-my-link/locks .oh-my-link/context .oh-my-link/skills
```

Report: FIXED artifact dirs ... 6/6 created

### B4. Configure Statusline

Check if `~/.claude/settings.json` has a `statusLine` entry.

If missing, add:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"{PLUGIN_ROOT}/dist/statusline.js\""
  }
}
```

If already set to a non-OML command: SKIP (do not overwrite user's statusline).

Report: FIXED statusline ... HUD configured

---

## Phase C: Configure + Finalize

### C1. Add OML Section to Global CLAUDE.md

**Only if A7 was MISSING or UPDATE.**

Read the OML block content from `skills/setup/references/global-claude-md.md`.

Read `~/.claude/CLAUDE.md` (if it exists).

**If `<!-- OML:START -->` and `<!-- OML:END -->` markers already exist:** Replace the content
between markers (inclusive) with the OML block from the reference file.

**If no `<!-- OML:START -->` markers exist but file exists:** Append the OML block at the end
of the file, separated by a blank line.

**If `~/.claude/CLAUDE.md` does not exist:** Create the file with the OML block content.

Preserve all other content in the file.

Report: FIXED CLAUDE.md ... OML block injected/updated

### C2. Write Setup Completion State

Write `~/.oh-my-link/setup.json`:

```json
{
  "setupCompleted": "<ISO-8601 timestamp>",
  "setupVersion": "<current plugin version from plugin.json>",
  "pluginRoot": "<absolute path to plugin>",
  "hooksWired": true,
  "buildFresh": true,
  "claudeMdUpdated": true,
  "checks": {
    "node": "pass",
    "plugin_root": "pass",
    "build": "pass",
    "settings": "pass",
    "hooks": "pass",
    "artifact_dirs": "pass",
    "claude_md": "pass",
    "versions": "pass"
  }
}
```

### C3. Final Summary

```
=== Oh-My-Link Setup Complete ===

| Component              | Status |
|------------------------|--------|
| Node.js                | PASS   |
| Plugin root            | PASS   |
| TypeScript build       | FIXED  |
| Hooks wiring           | FIXED  |
| Artifact dirs          | PASS   |
| CLAUDE.md              | FIXED  |

Oh-My-Link v{version} is ready!

Plugin root: {PLUGIN_ROOT}
Hook paths: absolute (portable)

Quick start:
  "start link <feature>"   -> Full 7-phase workflow
  "start fast <quick fix>" -> Lightweight execution
  "doctor oml"             -> Check workspace health

Note: Restart Claude Code to activate hook changes.
```

</Steps>

<MCP_Configuration>

## Phase D: MCP Configuration (Optional, after Phase C)

Oh-My-Link supports an **open MCP registry** — users can register ANY MCP server
(not just the built-in suggestions) and configure which agents use which MCPs.

The MCP config is stored at `~/.oh-my-link/mcp-config.json` (global) with optional
per-project overrides at `{cwd}/.oh-my-link/mcp-config.json`.

### D1. Show Current MCP Status

Read `~/.oh-my-link/mcp-config.json` (if exists).

Present the current status:

```
=== MCP Configuration ===

Registered MCPs:
| #  | MCP ID                  | Name                    | Installed | Tags           |
|----|-------------------------|-------------------------|-----------|----------------|
| 1  | context7                | Context7                | No        | docs, api-ref  |
| 2  | grep_app                | grep.app                | No        | search, example|
| 3  | playwright              | Playwright MCP          | No        | browser, test  |
| 4  | augment-context-engine  | Augment Context Engine  | No        | search, code   |
| 5  | browser-use             | Browser Use             | No        | browser, auto  |

These are the built-in suggestions. You can:
1. Mark MCPs you have installed as "installed" (so agents will use them)
2. Add your own custom MCP servers
3. Configure which agent roles use which MCPs
4. Skip MCP configuration for now
```

### D2. Mark Installed MCPs

Ask user which MCPs they already have available in their Claude Code environment.

> "Which of these MCPs do you have installed? (comma-separated numbers, or 'all', or 'none')"

For each selected MCP, update the config to mark `installed: true`.

### D3. Add Custom MCPs (Optional)

> "Do you want to register any additional MCP servers? (yes/no)"

If yes, collect for each:
- **id**: Short identifier (e.g., "my-rag-server")
- **name**: Display name
- **description**: What it does (1 sentence)
- **usage_hint**: When should agents use it? (e.g., "Use for internal knowledge base queries")
- **tags**: Optional comma-separated tags

Write the new provider entry to `~/.oh-my-link/mcp-config.json`.

### D4. Configure Role Mappings (Optional, Advanced)

> "Do you want to customize which agents use which MCPs? (yes/skip)"

If yes, show the current agent→MCP mapping table and let user modify.
If skip, use the sensible defaults (scout gets search MCPs, worker gets docs MCPs, etc.).

### D5. Save MCP Config

Write `~/.oh-my-link/mcp-config.json` with version 2 schema:

```json
{
  "version": 2,
  "providers": {
    "context7": {
      "id": "context7",
      "name": "Context7",
      "description": "Library documentation lookup",
      "installed": true,
      "usage_hint": "Look up library docs BEFORE using unfamiliar APIs.",
      "tags": ["docs", "api-reference"]
    },
    "my-custom-mcp": {
      "id": "my-custom-mcp",
      "name": "My RAG Server",
      "description": "Internal knowledge base search",
      "installed": true,
      "usage_hint": "Search internal docs before using external sources.",
      "tags": ["search", "internal"]
    }
  },
  "agent_map": {
    "scout": {
      "mcps": ["my-custom-mcp", "augment-context-engine", "grep_app"],
      "guidance": {
        "my-custom-mcp": "Check internal docs first before external sources."
      }
    }
  },
  "updated_at": "2026-04-08T..."
}
```

Report: FIXED MCP config ... N providers registered, M marked installed

</MCP_Configuration>

<Tool_Usage>
- Read: Check existing files (settings.json, CLAUDE.md, hooks.json, setup.json, plugin.json)
- Write: Create/update files when confirmed by user
- Edit: Merge config into existing files (settings.json, CLAUDE.md)
- Bash: node --version, npm run build, mkdir -p for artifact dirs
- Glob: Verify directory and file existence
- No Agent spawning -- setup runs in the current session
</Tool_Usage>

<Idempotency>
This wizard is designed to be run multiple times safely:
- Phase A0 checks `~/.oh-my-link/setup.json` to detect prior completion
- Phase A always checks current state before suggesting changes
- Phase B only modifies what is MISSING or STALE
- Phase C1 uses `<!-- OML:START/END -->` markers for surgical CLAUDE.md merge
- Phase C2 writes completion state for future idempotency
- Existing configurations from other plugins are preserved during merge
- Running the wizard when everything is configured results in "No changes needed"
</Idempotency>

<Error_Handling>
- If Node.js < 18: ERROR, stop (hooks won't work)
- If `.claude/settings.json` has invalid JSON: warn, offer to back up and recreate
- If `dist/` missing and build fails: report npm error, suggest manual `npm install && npm run build`
- If plugin root cannot be determined: ask user for the path explicitly
- If directory creation fails: report error, suggest checking permissions
- If CLAUDE.md write fails: show content to add manually
- If hooks are wired but paths are wrong: detect and offer to update (STALE status)
</Error_Handling>
