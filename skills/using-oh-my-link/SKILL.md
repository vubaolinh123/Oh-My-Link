---
name: using-oh-my-link
description: Bootstrap entry point for Oh-My-Link -- validates prerequisites, handles session resume, and hands off to Master
---

<Purpose>
The "front door" for Oh-My-Link. Loaded automatically by the keyword-detector
hook when the user says `start link` or `oml`. Validates the environment, handles
resume logic, and passes the user's actual request to the Master orchestrator.
Never does implementation work itself.
</Purpose>

<Use_When>
- Keyword `start link` or `oml` is detected in the user's prompt
- Invoked directly as `/oh-my-link:using-oh-my-link`
- At the start of any new Oh-My-Link session
</Use_When>

<Do_Not_Use_When>
- Already inside an active Oh-My-Link session (Master is running)
- User is using `start fast` / Start Fast -- that has its own entry path
- Utility commands: setup, doctor, cancel, update-plugin handle their own bootstrapping
</Do_Not_Use_When>

<Steps>

## Step 1 -- Prerequisite check (fast path)

Check `~/.oh-my-link/setup.json` exists and `checks` fields are all "pass".
Also verify that `pluginRoot` in setup.json points to a directory that actually
contains `dist/hooks/keyword-detector.js` (guards against moved plugin).

If setup.json is present, valid, and plugin root is intact: skip to Step 3 (fast path).
If setup.json is missing, any check is not "pass", or plugin root is stale: continue to Step 2.

## Step 2 -- Run setup wizard

Inform the user: "Oh-My-Link is not fully configured. Running setup wizard..."
Load the `setup` skill and execute it fully.
If setup fails or user declines required fixes: STOP. Do not proceed to Master.

## Step 3 -- Check for active session

Read `~/.oh-my-link/projects/{hash}/session.json`.
If `active: true`:
  Show: "Active session found -- Phase: {current_phase}, Started: {started_at}"
  Ask: "Resume this session or start fresh? [resume/fresh]"
  - `resume`: pass `RESUME=true` flag to Master
  - `fresh`: call the `cancel` skill to clean up, then proceed as new session

If no active session: proceed as new session.

## Step 4 -- Hooks wired check (lightweight)

Verify that `.claude/settings.json` exists and contains hook entries with
absolute paths pointing to the plugin root from setup.json.

If hooks are missing or use stale paths (relative, `${CLAUDE_PLUGIN_ROOT}`, or
pointing to a different directory): WARN and suggest running `setup oml` to repair.

Do NOT block -- this is a warning only, not a hard gate. The session may still
work if running from the plugin root directory.

## Step 5 -- Extract user request

Strip the trigger keyword (`start link`, `oml`) from the user's prompt to get the
actual feature request text. Pass this as the primary instruction to Master.

If the prompt is only the trigger keyword with no request body:
  Ask the user: "What would you like to build or fix?"
  Wait for response before continuing.

## Step 6 -- Hand off to Master

Load the Master skill. Pass:
- The user's feature request (stripped of trigger keyword)
- `resume: true/false`
- The project path (absolute cwd)

From this point, Master owns the session. This skill's work is complete.

</Steps>

<Tool_Usage>
- Read: ~/.oh-my-link/setup.json, session.json, ~/.claude/settings.json
- Bash: check if dist/hooks/ exists at pluginRoot path
- Skill: setup (if needed), cancel (if starting fresh over active session), master (handoff)
- No file writes -- bootstrap only
</Tool_Usage>
