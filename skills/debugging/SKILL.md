---
name: debugging
description: Systematic debugging for blocked Workers, test failures, and build errors
---

<Purpose>
The Debugging skill is a focused diagnostic agent. It takes a concrete error — from a
failed Worker, a broken build, or a failing test — and traces it to root cause using
structured investigation. It either proposes a fix or escalates to the Master when
the fix requires a scope change.
</Purpose>

<Use_When>
- A Worker has failed 2 or more retries
- Build or test fails after implementation
- A specific error message or stack trace is provided
- Master explicitly routes an error here
</Use_When>

<Do_Not_Use_When>
- Error is trivially obvious from the message (let the Worker fix it inline)
- No concrete error exists — do not debug hypotheticals
- The issue is architectural (escalate directly to Master)
</Do_Not_Use_When>

<Steps>

## Step 1 — Collect Error Context

Gather all available information:
- The raw error message / stack trace / test output
- The link_id and task description of the failing Worker
- The files the Worker was editing (from `file_scope`)

## Step 2 — Reproduce the Failure Mentally

Before reading code, reason through the error:
- What type of error is this? (import error, type mismatch, null reference, etc.)
- Which file and line does the stack trace point to?
- What was the Worker trying to do at that point?

## Step 3 — Read Affected Files

Read only the relevant sections:
1. The file and line indicated by the stack trace
2. Any files imported or called from that location
3. The Worker's task file to understand intended behavior

Avoid reading unrelated files — stay focused.

## Step 4 — Trace Root Cause

Work backward from the error:
- What precondition was violated?
- Was the error introduced by the Worker's change or was it pre-existing?
- Is there a mismatch between the plan's assumption and the actual code structure?

Document findings concisely.

## Step 5 — Propose Fix or Escalate

### If fix is within current file_scope:
- Describe the exact code change needed (file, line, what to change)
- Indicate whether it can be applied by re-running the Worker or requires direct edit

### If fix requires scope change:

<HARD-GATE>
Do NOT apply any fix that modifies files outside the link's `file_scope`.
Escalate to Master with:
  - Root cause summary
  - Required scope addition
  - Risk assessment (low / medium / high)
</HARD-GATE>

## Step 6 — Report

```
DEBUGGING REPORT — link-id: {id}

Error type: <classification>
Root cause: <1-2 sentences>
Location: <file>:<line>

Fix: <description of change>
  Scope change required: YES / NO
  Confidence: HIGH / MEDIUM / LOW

Next action: Re-run Worker / Apply fix directly / Escalate to Master
```

</Steps>

<Tool_Usage>
- Read: load affected files and task definition
- Glob / Grep: locate related symbols or patterns if stack trace is ambiguous
- Bash: run targeted build or test commands to confirm diagnosis
- Write: no writes — Debugging only diagnoses, it does not implement
- Agent tool: not used — Debugging is a leaf agent
</Tool_Usage>
