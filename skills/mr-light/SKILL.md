---
name: mr-light
description: Lightweight workflow for quick fixes and small changes in Oh-My-Link
---

<Purpose>
Start Fast is the fast-path execution mode for Oh-My-Link. It handles small, well-scoped
changes without the overhead of the full start link workflow. Routes requests into one of
three execution paths based on intent classification.
</Purpose>

<Use_When>
- Keyword `start fast` is present in the user request
- The change is clearly scoped to 1-3 files
- No architectural decisions are required
- The fix or change is understood without deep exploration
</Use_When>

<Do_Not_Use_When>
- Request involves system design, architecture, or new module creation
- Change touches more than 3 files or has unknown blast radius
- Migration, large-scale refactor, or cross-cutting concern is detected
- User has not used the `start fast` keyword
</Do_Not_Use_When>

<Steps>

## Step 1 — Intent Classification

Classify the request into one of three tiers:

```
TURBO signals (proceed without Fast Scout):
  typo, rename variable, fix import, update version string,
  change a literal/constant, add a missing semicolon/bracket

COMPLEX signals (decline and suggest start link):
  architect, design system, refactor entire X, new module,
  database migration, API redesign, multi-service change

STANDARD (default for everything else)
```

## Step 2 — Route by Tier

### Turbo Path
- Skip Fast Scout entirely
- Spawn Executor directly with the raw user request
- Executor self-verifies after applying the change
- Report completion

### Standard Path
- Spawn Fast Scout to analyze the request
- Fast Scout writes `.oh-my-link/plans/BRIEF.md`
- Spawn Executor with the BRIEF.md as context
- Executor implements and self-verifies
- Report completion

### Complex Path (BLOCKED)

<HARD-GATE>
Do NOT proceed. Inform the user:
"This request appears too complex for Start Fast. Consider using `start link` for a
full planning workflow with proper decomposition and review gates."
</HARD-GATE>

## Step 3 — Report

After Executor completes, summarize:
- What was changed
- Files affected
- Verification result (pass/fail)

</Steps>

<Tool_Usage>
- Agent tool: spawn Fast Scout (standard path) and Executor
- Read: inspect BRIEF.md before passing to Executor
- No external coordination service required — Start Fast is single-agent
</Tool_Usage>
