---
name: compounding
description: Capture post-feature learnings from Phase 7 by running 4 parallel analysis agents and writing structured learning files
triggers: compounding, capture learnings, phase 7 learnings, post-feature review
---

<Purpose>
Compounding runs after all links in a feature are closed (Phase 7). It spawns 4 specialist
analysis agents in parallel to extract maximum signal from the completed work — patterns,
decisions, failures, and outcome gaps — and writes durable learning files that make future
features faster.
</Purpose>

<Use_When>
- Phase 6 review is complete and all links are marked closed
- Master Orchestrator reaches Phase 7
- User explicitly requests post-feature learnings capture
</Use_When>

<Do_Not_Use_When>
- Links are still open or in_progress
- Phase 6 review has not completed
- The feature was trivial (fewer than 3 links) — use Learner instead
</Do_Not_Use_When>

<Steps>

## Step 1 — Verify Readiness

Before spawning agents, confirm:
1. All task issues for this session are closed
2. Phase 6 reviewer output exists in `.oh-my-link/history/`
3. A session slug is available (from session.json or plan.md frontmatter)

If not ready, output a clear message and stop.

## Step 2 — Spawn 4 Parallel Analysis Agents

Spawn all 4 simultaneously. Each receives:
- The plan.md
- The Phase 6 reviewer report
- The list of closed links with their implementation notes
- The WRAP-UP.md if available

**Agent 1 — Pattern Extractor**
Task: Identify reusable code, architecture, and process patterns.
Output format:
```
## Patterns
- {pattern name}: {description} | Reuse signal: HIGH/MEDIUM/LOW
```

**Agent 2 — Decision Analyst**
Task: Evaluate key decisions — what worked, what didn't, what surprised.
Output format:
```
## Decisions
- {decision}: {outcome} | Verdict: GOOD/BAD/NEUTRAL | Why
```

**Agent 3 — Failure Analyst**
Task: Catalog failures, blockers, and wasted effort. Produce prevention rules.
Output format:
```
## Failures
- {failure}: {cause} | Prevention: {rule}
```

**Agent 4 — Exit-State Auditor**
Task: Compare planned vs actual outcomes. Identify scope drift and estimation errors.
Output format:
```
## Planned vs Actual
- {item}: Planned {X} | Actual {Y} | Delta: {note}
```

## Step 3 — Synthesize Outputs

Collect all 4 agent outputs. Write to `.oh-my-link/history/learnings/YYYYMMDD-{slug}.md`:

```markdown
# Learnings: {feature name}
Date: {YYYYMMDD}
Links: {count}

## Patterns
{from Pattern Extractor}

## Decisions
{from Decision Analyst}

## Failures and Prevention
{from Failure Analyst}

## Planned vs Actual
{from Exit-State Auditor}

## Promoted to Critical
{list any HIGH-signal patterns promoted in next step}
```

## Step 4 — Promote Critical Findings

For any finding marked HIGH signal by any agent:
- Append a summary entry to `.oh-my-link/history/learnings/critical-patterns.md`
- Format: `{date} | {slug} | {one-line summary}`
- Create the file if it does not exist

## Step 5 — Report

Output:
- Path to the learnings file written
- Count of patterns, decisions, failures, and deltas captured
- List of items promoted to critical-patterns.md

</Steps>

<Tool_Usage>
- Read: plan.md, reviewer report, WRAP-UP.md, session artifacts; verify link closure before starting
- Write: learnings file and critical-patterns.md
- Agent spawning: 4 parallel specialist subagents (Step 2)
</Tool_Usage>
