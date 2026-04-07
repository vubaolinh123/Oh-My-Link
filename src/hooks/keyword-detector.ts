import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, hookOutput, readJson, writeJsonAtomic, getCwd, getQuietLevel } from '../helpers';
import { loadMemory, saveMemory, addDirective } from '../project-memory';
import { loadConfig, DEFAULT_MODELS } from '../config';
import { generateFramework, formatFramework } from '../prompt-leverage';
import { getSessionPath, ensureDir, getProjectStateRoot, normalizePath } from '../state';
import { SessionState, HookInput, AgentRole } from '../types';

// ============================================================
// Oh-My-Link — Keyword Detector (UserPromptSubmit)
// ============================================================

interface KeywordRule {
  patterns: string[];
  action: string;
  skill?: string;
}

// Keyword table — checked in order (cancel first, modes last)
const KEYWORDS: KeywordRule[] = [
  // Cancel (highest priority)
  { patterns: ['cancel oml', 'cancel link', 'cancel fast', 'stop oml', 'stop link', 'stop fast', 'huy oml'], action: 'cancel', skill: 'oh-my-link:cancel' },
  // Utility commands
  { patterns: ['setup oml', 'oml setup', 'setup oh-my-link', 'oh-my-link setup', 'install oh-my-link', 'install oml', 'cai dat oh-my-link', 'cai dat oml'], action: 'setup', skill: 'oh-my-link:setup' },
  { patterns: ['doctor oml', 'oml doctor', 'doctor oh-my-link'], action: 'doctor', skill: 'oh-my-link:doctor' },
  { patterns: ['update oml', 'oml update', 'upgrade oml', 'oml upgrade'], action: 'update', skill: 'oh-my-link:update-plugin' },
  { patterns: ['fetch docs', 'find docs', 'external context'], action: 'external-context', skill: 'oh-my-link:external-context' },
  { patterns: ['learn this', 'save this', 'remember this pattern'], action: 'learn', skill: 'oh-my-link:learner' },
  // Mode invocations (checked last — broader patterns)
  { patterns: ['start fast', 'startfast', 'quick start', 'fast mode', 'light mode', 'simple mode'], action: 'invoke-light', skill: 'oh-my-link:mr-light' },
  { patterns: ['start link', 'startlink', 'full mode', 'deep mode', 'oml', 'oh-my-link'], action: 'invoke', skill: 'oh-my-link:master' },
];

// Complex task signals for Start Fast intent classification
const COMPLEX_SIGNALS = [
  'architect', 'design system', 'refactor entire', 'rewrite',
  'new module', 'new service', 'migration', 'multi-file',
  'redesign', 'rebuild', 'restructure', 'overhaul',
];

const TURBO_SIGNALS = [
  'typo', 'rename', 'fix import', 'update version', 'change string',
  'add comment', 'remove unused', 'bump version', 'update dependency',
];

// File:line + approach regex for turbo detection
const FILE_LINE_PATTERN = /(?:[\w./\\-]+\.\w+)(?::?\s*(?:line\s*)?\d+)/i;
const APPROACH_PATTERN = /\b(?:fix|change|replace|update|rename|remove|delete|add|set|swap)\b/i;

// User directive detection patterns
const DIRECTIVE_PATTERNS = [
  /\balways\s+(?:use|prefer|run|include|add|keep|check)\s+(.+?)(?:\.|$)/i,
  /\bnever\s+(?:modify|change|delete|remove|touch|edit|use)\s+(.+?)(?:\.|$)/i,
  /\bprefer\s+(.+?)\s+over\s+(.+?)(?:\.|$)/i,
  /\bdon'?t\s+(?:ever\s+)?(?:modify|change|delete|remove|touch|edit|use)\s+(.+?)(?:\.|$)/i,
  /\bmake\s+sure\s+(?:to\s+)?always\s+(.+?)(?:\.|$)/i,
];

const DIRECTIVE_QUICK_CHECK = /\b(?:always|never|prefer|don'?t|make\s+sure)\b/i;

export function extractDirectives(rawPrompt: string): string[] {
  if (!DIRECTIVE_QUICK_CHECK.test(rawPrompt)) return [];
  const directives: string[] = [];
  for (const pattern of DIRECTIVE_PATTERNS) {
    const match = rawPrompt.match(pattern);
    if (match) {
      const directive = match[0].replace(/\.\s*$/, '').trim();
      if (directive.length >= 5 && directive.length <= 200) {
        directives.push(directive);
      }
    }
  }
  return directives;
}

function detectAndSaveDirectives(rawPrompt: string, cwd: string): void {
  try {
    const directives = extractDirectives(rawPrompt);
    if (directives.length === 0) return;
    const memory = loadMemory(cwd);
    for (const directive of directives) {
      const existing = (memory.user_directives || []).find(d => d.directive === directive);
      if (!existing) {
        addDirective(memory, directive, 'normal');
      }
    }
    saveMemory(cwd, memory);
  } catch { /* best effort */ }
}

function sanitize(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')           // strip XML/HTML tags
    .replace(/`[^`]+`/g, '')           // strip inline code
    .replace(/```[\s\S]*?```/g, '')    // strip fenced code blocks
    .replace(/https?:\/\/\S+/g, '')    // strip URLs
    .replace(/[\/\\][\w.\-\/\\]+/g, ''); // strip file paths
}

function buildModelConfigSection(): string {
  try {
    const config = loadConfig();
    const overrides: string[] = [];
    for (const [role, model] of Object.entries(config.models)) {
      if (model !== DEFAULT_MODELS[role as AgentRole]) {
        overrides.push(`  - ${role}: ${model}`);
      }
    }
    if (overrides.length === 0) return '';
    return `\n\n## Model Configuration\nCustom model overrides active:\n${overrides.join('\n')}\nAll other roles use defaults.`;
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const prompt = (input.prompt || '').trim();

  if (!prompt) {
    hookOutput('UserPromptSubmit');
    return;
  }

  // Block ALL subagents from triggering keywords (prevents infinite re-trigger loops)
  if (process.env.OML_AGENT_ROLE || process.env.OML_TEAM_WORKER) {
    hookOutput('UserPromptSubmit');
    return;
  }

  const cwd = getCwd(input as Record<string, unknown>);
  const promptLower = prompt.toLowerCase();
  // Sanitize prompt to avoid false-trigger from code/URLs/paths
  const cleanPrompt = sanitize(prompt).toLowerCase();

  // Detect and save user directives ("always use X", "never modify Y")
  detectAndSaveDirectives(prompt, cwd);

  // Find matching keyword
  const match = findKeywordMatch(cleanPrompt);
  if (!match) {
    hookOutput('UserPromptSubmit');
    return;
  }

  // Check if the matched keyword is being used informationally
  if (match) {
    const matchedPattern = match.patterns.find(p => cleanPrompt.includes(p));
    if (matchedPattern && isInformational(cleanPrompt, matchedPattern)) {
      hookOutput('UserPromptSubmit');
      return;
    }
  }

  // Handle cancel action directly — write cancel signal + deactivate session
  if (match.action === 'cancel') {
    const stateRoot = getProjectStateRoot(cwd);
    ensureDir(stateRoot);
    // Write cancel signal with 30s TTL
    try {
      const signal = {
        cancelled_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      };
      writeJsonAtomic(normalizePath(path.join(stateRoot, 'cancel-signal.json')), signal);
    } catch { /* best effort */ }
    // Deactivate session directly
    const session = readJson<SessionState>(getSessionPath(cwd));
    if (session?.active) {
      session.active = false;
      session.current_phase = 'cancelled' as any;
      session.cancelled_at = new Date().toISOString();
      try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* best effort */ }
    }
    hookOutput('UserPromptSubmit',
      '[MAGIC KEYWORD: cancel-oml]\n\nYou MUST cancel the active oh-my-link session. Clear state and report.');
    return;
  }

  // Check for mode conflicts
  const session = readJson<SessionState>(getSessionPath(cwd));
  if (session?.active && match.action === 'invoke' && session.mode === 'mylight') {
    hookOutput('UserPromptSubmit',
      '[oh-my-link] A Start Fast session is active. Say "cancel fast" first to start Start Link.');
    return;
  }
  if (session?.active && match.action === 'invoke-light' && session.mode === 'mylink') {
    hookOutput('UserPromptSubmit',
      '[oh-my-link] A Start Link session is active. Say "cancel link" first to start Start Fast.');
    return;
  }

  // Write/update session state for mode invocations
  if (match.action === 'invoke' || match.action === 'invoke-light') {
    const mode = match.action === 'invoke' ? 'mylink' : 'mylight' as const;

    if (!session?.active) {
      // For mylight, classify intent first
      if (mode === 'mylight') {
        const intent = classifyMylightIntent(prompt);

        // Complex intent → suggest Start Link instead, don't create session
        if (intent === 'complex') {
          hookOutput('UserPromptSubmit',
            '[oh-my-link] This task looks complex (multi-file refactor, new system, etc.).\n' +
            'Consider using Start Link ("start link") for the full 7-phase workflow.\n' +
            'If you still want Start Fast, simplify the scope and try again.');
          return;
        }

        const newSession: SessionState = {
          active: true,
          mode,
          current_phase: intent === 'turbo' ? 'light_turbo' : 'light_scout',
          started_at: new Date().toISOString(),
          reinforcement_count: 0,
          failure_count: 0,
          revision_count: 0,
          intent,
          awaiting_confirmation: true,
        };
        ensureDir(getProjectStateRoot(cwd));
        writeJsonAtomic(getSessionPath(cwd), newSession);
      } else {
        const newSession: SessionState = {
          active: true,
          mode,
          current_phase: 'bootstrap',
          started_at: new Date().toISOString(),
          reinforcement_count: 0,
          failure_count: 0,
          revision_count: 0,
          awaiting_confirmation: true,
        };
        ensureDir(getProjectStateRoot(cwd));
        writeJsonAtomic(getSessionPath(cwd), newSession);
      }
    }
  }

  // Build magic keyword output
  const quiet = getQuietLevel();

  // Augment prompt with framework guardrails
  const mode = match.action === 'invoke' ? 'mylink' : match.action === 'invoke-light' ? 'mylight' : undefined;
  let augmentedPrompt = prompt;
  if (mode) {
    const framework = generateFramework(prompt, mode);
    const frameworkText = formatFramework(framework);
    augmentedPrompt = `${prompt}\n\n${frameworkText}`;
  }

  // Override skill for turbo intent — route directly to executor
  let effectiveSkill = match.skill;
  if (match.action === 'invoke-light') {
    const currentSession = readJson<SessionState>(getSessionPath(cwd));
    if (currentSession?.intent === 'turbo') {
      effectiveSkill = 'oh-my-link:executor';
    }
  }

  let context = `[MAGIC KEYWORD: ${match.action}]\n\n`;
  context += `User request:\n${augmentedPrompt}\n\n`;

  // Inject model configuration if overrides exist
  const modelConfig = buildModelConfigSection();
  if (modelConfig) {
    context += modelConfig + '\n\n';
  }

  // Inject skill instructions directly (no dependency on Skill tool registration)
  const skillContent = effectiveSkill ? loadSkillContent(effectiveSkill) : null;
  if (skillContent) {
    context += `--- SKILL INSTRUCTIONS ---\n${skillContent}\n--- END SKILL INSTRUCTIONS ---\n`;
    if (quiet < 2) {
      context += `\nIMPORTANT: Follow the skill instructions above IMMEDIATELY.`;
    }
  } else {
    // Fallback: tell Claude to use the Skill tool
    context += `You MUST invoke the skill using the Skill tool:\n\nSkill: ${effectiveSkill || match.action}\n`;
    if (quiet < 2) {
      context += `\nIMPORTANT: Invoke the skill IMMEDIATELY. Do not proceed without loading the skill instructions.`;
    }
  }

  hookOutput('UserPromptSubmit', context);
}

function findKeywordMatch(promptLower: string): KeywordRule | null {
  for (const rule of KEYWORDS) {
    for (const pattern of rule.patterns) {
      // Word boundary match — pattern must appear as a word/phrase
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:^|\\s|[^a-zA-Z])${escaped}(?:\\s|[^a-zA-Z]|$)`, 'i');
      if (regex.test(promptLower) || promptLower.startsWith(pattern)) {
        return rule;
      }
    }
  }
  return null;
}

function isInformational(text: string, keyword?: string): boolean {
  // If a specific keyword is provided, check context window around it
  if (keyword) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kwRegex = new RegExp(escaped, 'gi');
    let match: RegExpExecArray | null;
    while ((match = kwRegex.exec(text)) !== null) {
      const start = Math.max(0, match.index - 80);
      const end = Math.min(text.length, match.index + match[0].length + 80);
      const window = text.slice(start, end).toLowerCase();
      if (/(?:what|how|why|explain|describe|tell\s+me\s+about|does|can|is\s+there|when\s+to\s+use|where|who)\s+(?:is|does|are|do|should|would|could|can)?/.test(window)) return true;
      if (/\?\s*$/.test(window.trim())) return true;
    }
    return false;
  }
  // Global check: test against all OML keywords
  const omlKeywords = ['oml', 'oh-my-link', 'start link', 'start fast', 'startlink', 'startfast'];
  return omlKeywords.some(kw => isInformational(text, kw));
}

function classifyMylightIntent(prompt: string): 'turbo' | 'standard' | 'complex' {
  const lower = prompt.toLowerCase();

  // Check for complex signals first — these are too large for Start Fast
  if (COMPLEX_SIGNALS.some(s => lower.includes(s))) {
    return 'complex';
  }

  // Turbo detection: explicit file:line + explicit approach
  if (FILE_LINE_PATTERN.test(prompt) && APPROACH_PATTERN.test(lower)) {
    return 'turbo';
  }

  // Keyword-based turbo signals
  if (TURBO_SIGNALS.some(s => lower.includes(s))) {
    return 'turbo';
  }

  // Default to standard (the safer path)
  return 'standard';
}

function loadSkillContent(skillRef: string): string | null {
  // skillRef format: "oh-my-link:<name>" → resolve to skills/<name>/SKILL.md
  const parts = skillRef.split(':');
  const skillName = parts.length > 1 ? parts[1] : parts[0];

  // __dirname at runtime is dist/hooks/, so skills/ is at ../../skills/
  const skillPath = path.join(__dirname, '..', '..', 'skills', skillName, 'SKILL.md');
  try {
    if (fs.existsSync(skillPath)) {
      return fs.readFileSync(skillPath, 'utf-8').trim();
    }
  } catch { /* ignore */ }
  return null;
}

// Run
main().catch(() => {
  // Fail silently — hook errors should not block user input
  hookOutput('UserPromptSubmit');
});
