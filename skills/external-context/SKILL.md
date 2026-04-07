---
name: external-context
description: Fetch SDK and API documentation via parallel web searches and synthesize into a reusable context file
triggers: fetch docs, get docs, fetch documentation, external docs, sdk docs, api docs
---

<Purpose>
External Context decomposes a documentation request into 2-4 focused search facets, spawns
parallel document-specialist subagents to fetch each facet, then synthesizes the results into
a structured context file. This context file is available to Scout and Architect for the
remainder of the session.
</Purpose>

<Use_When>
- User says "fetch docs" followed by a library or framework name
- Scout or Architect needs SDK reference for an unfamiliar library
- The codebase imports a library and no local documentation exists
</Use_When>

<Do_Not_Use_When>
- Documentation is already present in `.oh-my-link/context/`
- The library is well-known and covered by the model's training (e.g., standard Node.js APIs)
- The user only needs a quick definition, not a comprehensive reference
</Do_Not_Use_When>

<Steps>

## Step 1 — Parse the Query

Extract from the user's prompt:
- Library or framework name (e.g., "React", "Stripe SDK", "Supabase Auth")
- Specific area of interest if mentioned (e.g., "hooks", "webhooks", "RLS policies")
- Version if mentioned

If no library name is identifiable, ask the user to clarify before proceeding.

## Step 2 — Decompose into Search Facets

Generate 2-4 targeted search facets. Each facet is a focused sub-question.

Examples for "fetch docs React hooks":
1. "React hooks API reference — useState useEffect useCallback"
2. "React hooks rules and constraints"
3. "React hooks cleanup functions and subscriptions"
4. "React hooks common pitfalls and anti-patterns"

Limit to 4 facets maximum to avoid redundancy.

## Step 3 — Spawn Parallel Document-Specialist Subagents

Spawn one subagent per facet simultaneously. Each subagent:
1. Uses `pplx-wrapper search --query "{facet}" --recency month --limit 3` to find sources
2. Uses WebFetch on the top result URL to retrieve the actual documentation page
3. Returns a structured summary: key concepts, API signatures, code examples, gotchas

Subagents are leaf agents — no further spawning.

## Step 4 — Synthesize Results

Collect all subagent outputs. Deduplicate overlapping content.
Write to `.oh-my-link/context/{library-slug}.md`:

```markdown
# {Library Name} — External Context
Fetched: {date}
Facets: {list}

## Overview
{1 paragraph summary of the library's purpose and key concepts}

## Key APIs
{Most important API signatures and their parameters}

## Code Examples
{1-3 representative examples from the fetched docs}

## Gotchas and Constraints
{Known pitfalls, version differences, breaking changes}

## Sources
{URLs fetched}
```

## Step 5 — Report

Output:
- Path to the written context file
- Count of facets fetched and sources used
- Any facets that returned no useful results

</Steps>

<Tool_Usage>
- Bash: run `pplx-wrapper search` for each facet
- WebFetch: retrieve documentation pages identified by search
- Write: context file in `.oh-my-link/context/`
- Agent spawning: parallel document-specialist subagents (one per facet)
- No external coordination service interaction needed
</Tool_Usage>
