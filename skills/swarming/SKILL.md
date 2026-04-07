---
name: swarming
description: Parallel Worker orchestration — groups tasks into non-conflicting tracks and spawns concurrent Workers
---

<Purpose>
Swarming executes the approved plan in parallel by grouping tasks into independent
execution tracks (no shared files within a track) and spawning one Worker per track
simultaneously. It monitors results and falls back to sequential execution for any
failed links.
</Purpose>

<Use_When>
- User selected Parallel at Gate 3 after validation passed
- At least 2 tasks exist with non-overlapping file scopes
- The Validating skill returned READY
</Use_When>

<Do_Not_Use_When>
- User selected Sequential at Gate 3 — use sequential Worker spawning instead
- Only one task remains — spawn a single Worker directly
- Validation has not been run or returned BLOCKED
</Do_Not_Use_When>

<Steps>

## Step 1 — Load Tasks

Read all pending task files from `.oh-my-link/tasks/`.
Build a map: `link_id → file_scope[]`.

Filter to only tasks with `status: "pending"` and no unresolved dependencies
(all dependency link_ids must have `status: "done"`).

## Step 2 — Track Assignment (Union-Find)

Group tasks into parallel tracks such that no two tasks in the same track share a file.

Algorithm:
1. Start: each task is its own track
2. For every pair of tasks (A, B): if their `file_scope` sets intersect, merge their tracks
3. Result: a set of independent tracks, each a list of link_ids

Tasks within the same track must run sequentially (shared files).
Tasks in different tracks can run concurrently.

Example output:
```
Track 1: [task-01, task-04]  (share a file — sequential within track)
Track 2: [task-02]           (independent)
Track 3: [task-03, task-05]  (share a file — sequential within track)
```

## Step 3 — Spawn Workers

For each track, spawn one Worker agent via the Agent tool.
Pass the Worker its prompt file: `.oh-my-link/plans/worker-{link-id}.md`

All track-lead Workers are spawned simultaneously (parallel Agent calls).
Each Worker handles its track sequentially if the track contains multiple tasks.

## Step 4 — Monitor Results

Wait for all Workers to complete. Collect results:
- `done` — link implemented and self-verified
- `failed` — Worker encountered an unrecoverable error

## Step 5 — Failure Handling

For any `failed` link:
1. Log the failure with error context
2. Spawn a sequential fallback Worker for that link only
3. If the fallback also fails, escalate to Master with full error context

## Step 6 — Completion Report

After all links are done or failed-and-escalated:

```
SWARM COMPLETE

  Tracks spawned: N
  Links completed: X / Y
  Links failed: Z (escalated to Master)
  Total wall time: ~T minutes
```

Hand off to Reviewer.

</Steps>

<Tool_Usage>
- Read / Glob: load task files and worker prompt files
- Agent tool: spawn Worker agents (one per track, concurrently)
- Write: update `.oh-my-link/tasks/{link-id}.json` status fields as Workers report back
- No external coordination service required — coordination is file-based
</Tool_Usage>
