---
name: prompt-leverage
description: Automatically strengthen raw user prompts into execution-ready instruction sets by appending structured context, constraints, and success criteria
triggers: (transparent — runs on every keyword-triggered invocation)
---

<Purpose>
Prompt Leverage runs inside the keyword-detector hook before any skill is invoked. It classifies
the incoming task, infers execution intensity, and generates structured framework blocks that are
appended to the hook output. The result is a richer prompt that reduces Scout/Architect
clarification rounds and improves first-pass implementation quality.
</Purpose>

<Use_When>
- A keyword trigger (`start link`, `start fast`, `oml`, etc.) is detected
- The user's raw prompt is short or ambiguous
- Task type and intensity can be inferred from context
</Use_When>

<Do_Not_Use_When>
- The prompt is already structured with explicit context, constraints, and criteria
- User has explicitly disabled prompt augmentation
- The invocation is a cancel or doctor command
</Do_Not_Use_When>

<Steps>

## Step 1 — Classify Task Type

Assign one of:
- `bugfix` — fixing broken behavior
- `feature` — adding new functionality
- `refactor` — restructuring without behavior change
- `security` — vulnerability or auth concern
- `performance` — speed or resource optimization
- `docs` — documentation or comments only
- `config` — settings, env, or tooling changes
- `test` — test coverage or test fixes

Use the verb and subject of the user's prompt as signals.

## Step 2 — Infer Intensity

| Signal | Intensity |
|--------|-----------|
| Single file, clear target | light |
| Multi-file, clear requirements | moderate |
| Cross-cutting, unclear requirements | heavy |
| Security, data integrity, or production impact | critical |

Start Fast mode: cap intensity at `moderate` regardless of inference.

## Step 3 — Generate Framework Blocks

Append the following blocks to the hook output based on task type and intensity:

**Context block** (all intensities):
```
## Inferred Context
- Task type: {type}
- Intensity: {intensity}
- Likely scope: {1-2 sentence scope estimate}
```

**Constraints block** (moderate and above):
```
## Constraints
- {constraint relevant to task type, e.g. "do not change public API signatures"}
- {constraint relevant to intensity, e.g. "prefer targeted edits over full rewrites"}
- {constraint relevant to codebase, inferred from file patterns}
```

**Success criteria block** (heavy and critical):
```
## Success Criteria
- [ ] {measurable outcome 1}
- [ ] {measurable outcome 2}
- [ ] {measurable outcome 3}
```

## Step 4 — Append to Hook Output

The augmented blocks are appended directly to the hook's stdout. They appear after the
original user prompt and before the skill invocation. No file is written.

Runtime implementation: `src/prompt-leverage.ts`

</Steps>

<Tool_Usage>
- No file I/O at runtime — operates purely on prompt text
- No subagent spawning
- No external calls
- Read src/prompt-leverage.ts if implementation details are needed
</Tool_Usage>
