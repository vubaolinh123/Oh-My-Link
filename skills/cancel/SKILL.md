---
name: cancel
description: Clean cancellation of the active Oh-My-Link session — releases locks, marks tasks failed, stops persistent-mode hook
---

<Purpose>
Gracefully terminate an active Oh-My-Link session. Writes a cancel signal that
the stop-handler hook detects within its 30-second TTL window, then cleans up
all runtime state to leave the workspace in a consistent idle state.
</Purpose>

<Use_When>
- User says `cancel oml` or `cancel oh-my-link`
- A session is stuck or taking too long
- User wants to abandon the current feature workflow and start fresh
</Use_When>

<Steps>

## Step 1 — Check for active session

Read `~/.oh-my-link/projects/{hash}/session.json`.
If `active: false` or file missing: inform user there is no active session to cancel.
Exit early.

## Step 2 — Warn if in a critical phase

Check `current_phase` in session.json. If phase is one of:
  `executing`, `reviewing`, `merging`

Warn the user:
"The session is currently in phase '{phase}'. Cancelling now may leave partial
changes in the codebase. Uncommitted edits will remain. Proceed? [y/N]"

Do not proceed without confirmation for critical phases. For non-critical phases
(planning, clarifying, idle), proceed without confirmation.

## Step 3 — Write cancel signal

Write to `~/.oh-my-link/projects/{hash}/cancel-signal.json`:

```json
{
  "timestamp": "<ISO timestamp>",
  "reason": "user_requested",
  "phase_at_cancel": "<current_phase>"
}
```

The stop-handler hook checks for this file on every Stop event. If the signal
is present and within a 30-second TTL, the hook allows Claude Code to stop
without blocking.

## Step 4 — Release all file locks

Read all files in `.oh-my-link/locks/`.
Delete every lock file regardless of expiry.

Log: "Released N lock(s)."

## Step 5 — Mark in-progress tasks as failed

Read all files in `.oh-my-link/tasks/`.
For each task with `status: "in_progress"`:
  Set `status: "failed"`, add `cancelled_at: <ISO timestamp>`.
  Write the updated task file back.

Log: "Marked N task(s) as failed."

## Step 6 — Update session state

Write to `~/.oh-my-link/projects/{hash}/session.json`:
  Set `active: false`
  Set `current_phase: "cancelled"`
  Add `cancelled_at: <ISO timestamp>`

## Step 7 — Confirm to user

Report:
"Session cancelled.
  Locks released: N
  Tasks marked failed: N
  You can start a new session at any time with `start link <request>`."

</Steps>

<Tool_Usage>
- Read: session.json, lock files, task files
- Write: cancel-signal.json, session.json, updated task files
- Bash: only if needed to enumerate directory contents
- No Agent spawning — cancel runs synchronously in current session
</Tool_Usage>
