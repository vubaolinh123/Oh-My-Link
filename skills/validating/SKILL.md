---
name: validating
description: Pre-execution validation gate — structural, scope, and readiness checks before workers run
---

<Purpose>
The Validating skill is the mandatory gate between planning and execution. It catches
structural errors in task definitions, file conflicts between parallel tasks, and
unresolved risks before any Worker touches the codebase. A BLOCKED result stops
execution until issues are resolved.
</Purpose>

<Use_When>
- After the Architect produces task files (Phase 4 of start link workflow)
- Before spawning any Workers — sequential or parallel
- When the Master needs to confirm the plan is safe to execute
</Use_When>

<Do_Not_Use_When>
- Start Fast workflow (no formal task files exist)
- Re-running after a Worker completes (use Reviewer instead)
- Already ran and returned READY for the current plan version
</Do_Not_Use_When>

<Steps>

## Pass 1 — Structural Verification

Read all task JSON files from `.oh-my-link/tasks/`.

For each task, verify:
- [ ] `link_id` present and unique across all tasks
- [ ] `title` present and non-empty
- [ ] `description` present and non-empty
- [ ] `acceptance_criteria` is a non-empty array
- [ ] `file_scope` is a non-empty array
- [ ] `status` is `"pending"`
- [ ] `depends_on` field contains only valid `link_id` values

Dependency graph checks:
- No cycles (DFS with visited + in-stack detection)
- No self-referencing `link_id` in its own `depends_on` list

Fail conditions → add to BLOCKED list with specific task ID and field.

## Pass 2 — Scope Verification

For each `file_scope` entry across all tasks:

1. **File existence**: check whether the file exists on disk or is explicitly marked
   as a new file to be created. Unknown paths are flagged as warnings (not blockers
   unless ambiguous).

2. **Conflict detection**: build a map of `file_path → [link_ids]`.
   Any file appearing in two or more tasks that could run concurrently is a CONFLICT.
   Concurrent = tasks with no dependency relationship between them.

3. **Scale check**: if total unique file count exceeds 30, flag for manual review.
   This is a warning, not a blocker.

## Pass 3 — Readiness Assessment

Review the plan holistically:

- Are there any unresolved questions from the Scout phase (check
  `.oh-my-link/plans/decisions.md` if present)?
- Are there tasks marked HIGH risk without a spike or prototype task preceding them?
- Are acceptance criteria testable and specific (not vague like "works correctly")?

Flag issues that would predictably cause Worker failures.

## Output

### If all checks pass → READY

```
VALIDATION: READY

Structural: PASS (N tasks, no cycles, all fields present)
Scope: PASS (N files, no conflicts)
Readiness: PASS

Proceed to Gate 3 — choose execution mode:
  [S] Sequential  — one Worker at a time, safest
  [P] Parallel    — concurrent Workers on non-overlapping tracks
```

<HARD-GATE>
Do NOT spawn any Workers until the user responds to Gate 3.
Wait for explicit user selection of Sequential or Parallel.
</HARD-GATE>

### If any check fails → BLOCKED

```
VALIDATION: BLOCKED

Issues found:
  1. [STRUCTURAL] task-03: acceptance_criteria is empty
  2. [CONFLICT] file src/auth/middleware.ts claimed by task-01 and task-04
  3. [READINESS] task-06 is HIGH risk with no preceding spike

Resolve these issues before execution can proceed.
```

</Steps>

<Tool_Usage>
- Read: load task JSON files from `.oh-my-link/tasks/`
- Glob: enumerate task files
- Bash: check file existence for scope verification
- No Agent spawning — Validating is a leaf agent
- Write: optionally produce `.oh-my-link/plans/validation-report.md`
</Tool_Usage>
