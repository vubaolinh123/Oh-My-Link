import { TaskIntensity, PromptFramework } from './types';

// Task type detection patterns
const TASK_PATTERNS: Array<{ pattern: RegExp; type: string; intensity: TaskIntensity }> = [
  { pattern: /\b(fix|bug|error|broken|crash)\b/i, type: 'bugfix', intensity: 'moderate' },
  { pattern: /\b(security|auth|permission|encrypt)\b/i, type: 'security', intensity: 'critical' },
  { pattern: /\b(add|create|implement|build|new)\b/i, type: 'feature', intensity: 'heavy' },
  { pattern: /\b(refactor|clean|reorganize|restructure)\b/i, type: 'refactor', intensity: 'heavy' },
  { pattern: /\b(test|spec|coverage)\b/i, type: 'testing', intensity: 'moderate' },
  { pattern: /\b(deploy|ci|cd|pipeline|docker)\b/i, type: 'devops', intensity: 'moderate' },
  { pattern: /\b(doc|readme|comment|explain)\b/i, type: 'docs', intensity: 'light' },
  { pattern: /\b(perf|optimize|slow|fast|cache)\b/i, type: 'performance', intensity: 'heavy' },
  { pattern: /\b(write|draft|compose|outline|document)\b/i, type: 'writing', intensity: 'moderate' },
  { pattern: /\b(research|investigate|analyze|compare|evaluate)\b/i, type: 'research', intensity: 'moderate' },
];

/** Detect task type and intensity from prompt text */
export function detectTaskType(prompt: string): { type: string; intensity: TaskIntensity } {
  const scores: Record<string, { count: number; intensity: TaskIntensity }> = {};

  for (const { pattern, type, intensity } of TASK_PATTERNS) {
    const matches = prompt.match(new RegExp(pattern, 'gi'));
    if (matches) {
      if (!scores[type]) scores[type] = { count: 0, intensity };
      scores[type].count += matches.length;
    }
  }

  // Pick the type with the most keyword hits
  let bestType = 'general';
  let bestCount = 0;
  let bestIntensity: TaskIntensity = 'moderate';

  for (const [type, data] of Object.entries(scores)) {
    if (data.count > bestCount) {
      bestType = type;
      bestCount = data.count;
      bestIntensity = data.intensity;
    }
  }

  return { type: bestType, intensity: bestIntensity };
}

/** Generate a prompt framework with guardrails */
export function generateFramework(prompt: string, mode?: 'mylink' | 'mylight'): PromptFramework {
  const { type, intensity } = detectTaskType(prompt);

  // Cap intensity for Start Fast mode
  const effectiveIntensity: TaskIntensity =
    mode === 'mylight' ? capIntensity(intensity, 'light') : intensity;

  const constraints: string[] = [];
  const criteria: string[] = [];

  // Universal constraints
  constraints.push('Inspect relevant files and dependencies first. Validate with the narrowest useful checks before broadening scope.');
  constraints.push('Understand the problem broadly first, then go deep where risk is highest. Use first-principles reasoning before proposing changes.');

  // Task-specific constraints
  if (type === 'bugfix') {
    constraints.push('Trace the problem systematically. Read actual code/data before forming hypotheses.');
    criteria.push('Root cause analysis with evidence, affected scope, and recommended action.');
  } else if (type === 'feature') {
    constraints.push('Check for existing patterns and conventions in the codebase. Follow them consistently.');
    criteria.push('Feature works end-to-end, tests cover the change, no regressions introduced.');
  } else if (type === 'refactor') {
    constraints.push('Preserve behavior exactly. Refactoring changes structure, not output.');
    criteria.push('All existing tests pass, code is measurably simpler, no behavior changes.');
  } else if (type === 'security') {
    constraints.push('Never downgrade security. Check OWASP Top 10. Validate all inputs at system boundaries.');
    criteria.push('No new vulnerabilities, all auth paths verified, secrets are not exposed.');
  } else if (type === 'writing') {
    constraints.push('Match the tone and style of existing documentation. Be concise and reader-focused.');
    criteria.push('Content is clear, well-structured, and matches the project\'s documentation style.');
  } else if (type === 'research') {
    constraints.push('Gather facts from reliable sources. Compare alternatives objectively.');
    criteria.push('Analysis is comprehensive, sources are cited, recommendations are actionable.');
  }

  // Universal criteria
  criteria.push('Verify: code compiles/passes lint, tests cover the change, no regressions introduced, edge cases considered.');
  if (effectiveIntensity === 'heavy' || effectiveIntensity === 'critical') {
    criteria.push('Check correctness, completeness, and edge cases. Improve obvious weaknesses if a better approach is available within scope.');
  }

  return {
    context: `Task type: ${type}. Intensity: ${effectiveIntensity}.`,
    constraints,
    success_criteria: criteria,
    intensity: effectiveIntensity,
  };
}

/** Format framework as injection text */
export function formatFramework(framework: PromptFramework): string {
  const lines: string[] = [];
  if (framework.context) lines.push(framework.context);
  for (const c of framework.constraints) lines.push(c);
  for (const s of framework.success_criteria) lines.push(s);
  return lines.join('\n');
}

function capIntensity(intensity: TaskIntensity, max: TaskIntensity): TaskIntensity {
  const order: TaskIntensity[] = ['light', 'moderate', 'heavy', 'critical'];
  const iIdx = order.indexOf(intensity);
  const mIdx = order.indexOf(max);
  return iIdx <= mIdx ? intensity : max;
}
