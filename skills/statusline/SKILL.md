---
name: statusline
description: Configure the Oh-My-Link status line HUD in Claude Code settings
triggers: statusline, status line, configure hud, setup statusline, reconfigure statusline
---

<Purpose>
Statusline configures Claude Code's `statusLine` setting to point at the compiled Oh-My-Link
statusline script. The HUD renders: mode, phase, link progress, active agent count, and session
duration. Auto-configured during setup — this skill handles manual reconfiguration.
</Purpose>

<Use_When>
- Status line is missing or showing stale data after an update
- User manually wants to reconfigure the HUD
- Setup was run but the statusLine setting was not applied
</Use_When>

<Do_Not_Use_When>
- Status line is already configured and working correctly
- User has not run setup and the compiled script does not exist
</Do_Not_Use_When>

<Steps>

## Step 1 — Verify the Compiled Script Exists

Check that the statusline script is compiled:
- Expected path: `~/.oh-my-link/bin/statusline` (or as configured in config.json)
- If not found, instruct the user to run `setup oml` first and stop

## Step 2 — Read settings.json

Read `~/.claude/settings.json`. Locate or create the `statusLine` key.

## Step 3 — Update the statusLine Entry

Set the value to the absolute path of the compiled statusline script.

Example result in settings.json:
```json
{
  "statusLine": "/Users/{user}/.oh-my-link/bin/statusline"
}
```

Preserve all other keys in the file. Do not reformat unrelated sections.

## Step 4 — Confirm

Output the updated `statusLine` value and instruct the user to restart Claude Code
for the change to take effect.

Runtime implementation: `src/statusline.ts`

</Steps>

<Tool_Usage>
- Read: `~/.claude/settings.json`
- Edit: update `statusLine` key only
- Bash: verify compiled script path exists
- No subagent spawning
</Tool_Usage>
