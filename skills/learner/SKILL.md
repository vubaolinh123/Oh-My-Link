---
name: learner
description: Extract reusable patterns from completed sessions and save them as discoverable skill files
triggers: learn this, learn, extract pattern, save pattern
---

<Purpose>
Learner reads the current session's artifacts, identifies reusable patterns through 3 quality
gates, and writes a structured skill file that the skill-injector hook can auto-discover and
inject into future sessions. It turns one-off solutions into compounding institutional knowledge.
</Purpose>

<Use_When>
- User says "learn this" after completing a feature or solving a non-trivial problem
- A pattern was discovered mid-session that would help future work
- A debugging strategy proved effective and should be repeatable
</Use_When>

<Do_Not_Use_When>
- The session produced only trivial changes (single-line fixes, typo corrections)
- The pattern is clearly project-specific and not transferable
- No CONTEXT.md, plan.md, or WRAP-UP.md exists to read from
</Do_Not_Use_When>

<Steps>

## Step 1 — Read Session Artifacts

Collect available artifacts in order of richness:

1. `.oh-my-link/history/{slug}/CONTEXT.md` — session context and problem framing
2. `.oh-my-link/plans/{slug}-plan.md` — architectural decisions made
3. `.oh-my-link/history/{slug}/WRAP-UP.md` — if available, the summary of outcomes
4. `.oh-my-link/tasks/*.json` — task definitions and completion reports

If none exist, read recent conversation history for context signals.

## Step 2 — Read Modified Files

For each file inferred from task `file_scope`, WRAP-UP.md, or other session artifacts:
- Read the modified sections, not whole files
- Note: what pattern does this implement? What problem does it solve?
- Identify if the pattern is structural (architecture), procedural (process), or tactical (code)

## Step 3 — Apply Quality Gates

Run all 3 gates. A pattern must pass all 3 to be saved.

**Gate 1: Generality**
Ask: "Could this pattern apply to a different project with a similar problem?"
- PASS: the pattern addresses a class of problems, not a specific one-off
- FAIL: the pattern is tightly coupled to this project's domain

**Gate 2: Non-Obviousness**
Ask: "Would a competent developer already know this without being told?"
- PASS: the pattern involves a subtle insight, a counterintuitive approach, or hard-won knowledge
- FAIL: it's standard practice any developer would apply by default

**Gate 3: Skill Expressibility**
Ask: "Can this be written as a step-by-step skill with clear trigger conditions?"
- PASS: the pattern has identifiable triggers and reproducible steps
- FAIL: it's too vague or situational to formalize into steps

If any gate fails, output a brief explanation of why and stop.

## Step 4 — Draft the Skill File

Create a slug from the pattern name (lowercase, hyphenated).
Write to `.oh-my-link/skills/{slug}.md`:

```markdown
---
name: {slug}
description: {one-line description of what the skill does}
triggers: {keyword1}, {keyword2}, {keyword3}
---

## Pattern
{2-4 sentences describing the pattern and why it works}

## When to Apply
- {condition 1}
- {condition 2}
- {condition 3}

## How to Apply
1. {step 1}
2. {step 2}
3. {step 3}

## Example
{brief concrete example if one is available from the session}

## Anti-Patterns
- {what NOT to do}
```

## Step 5 — Confirm and Report

Output:
- The slug and full path of the written file
- A one-sentence summary of the extracted pattern
- Which quality gate was closest to failing (transparency)

</Steps>

<Tool_Usage>
- Read: session artifacts and modified files
- Write: the new skill file in `.oh-my-link/skills/`
- No subagent spawning — Learner is a leaf agent
- No web search needed
</Tool_Usage>
