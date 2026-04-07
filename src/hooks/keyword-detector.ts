import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, hookOutput, readJson, writeJsonAtomic, getCwd, getQuietLevel, debugLog } from '../helpers';
import { loadMemory, saveMemory, addDirective } from '../project-memory';
import { loadConfig, DEFAULT_MODELS, saveConfigField, isAlwaysOn } from '../config';
import { generateFramework, formatFramework } from '../prompt-leverage';
import { getSessionPath, ensureDir, getProjectStateRoot, normalizePath, resolvePluginRoot, getDebugLogPath, projectHash } from '../state';
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
  { patterns: ['oml list', 'list oml', 'oml projects', 'list projects oml'], action: 'list-projects', skill: 'oh-my-link:list-projects' },
  { patterns: ['oml debug on', 'debug on oml', 'oml debug'], action: 'debug-on', skill: undefined },
  { patterns: ['oml debug off', 'debug off oml'], action: 'debug-off', skill: undefined },
  { patterns: ['oml on', 'always on oml', 'bat oml', 'bật oml'], action: 'always-on', skill: undefined },
  { patterns: ['oml off', 'always off oml', 'tat oml', 'tắt oml'], action: 'always-off', skill: undefined },
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

  debugLog(cwd, 'keyword', `prompt="${cleanPrompt.slice(0, 80)}"`);

  // Detect and save user directives ("always use X", "never modify Y")
  detectAndSaveDirectives(prompt, cwd);

  // Find matching keyword
  let match = findKeywordMatch(cleanPrompt);

  debugLog(cwd, 'keyword', `match=${match ? match.action : 'none'}`);
  
  // Always-On: if no keyword matched but always_on is enabled,
  // auto-classify task complexity and trigger the appropriate mode
  if (!match && isAlwaysOn(cwd)) {
    // Check if there's already an active session — if so, let it continue naturally
    const existingSession = readJson<SessionState>(getSessionPath(cwd));
    if (existingSession?.active) {
      // Session already running — don't re-trigger, just pass through
      hookOutput('UserPromptSubmit');
      return;
    }
    // Auto-classify: use the same intent classifier that Start Fast uses
    const autoIntent = classifyMylightIntent(prompt);
    if (autoIntent === 'complex') {
      // Complex task → Start Link (full 7-phase pipeline)
      match = { patterns: ['always-on'], action: 'invoke', skill: 'oh-my-link:master' };
      debugLog(cwd, 'keyword', 'always-on auto-trigger → invoke');
    } else {
      // Turbo or Standard → Start Fast (lightweight workflow)
      match = { patterns: ['always-on'], action: 'invoke-light', skill: 'oh-my-link:mr-light' };
      debugLog(cwd, 'keyword', `always-on auto-trigger → invoke-light (intent=${autoIntent})`);
    }
  }
  
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

  // Handle always-on toggle
  if (match.action === 'always-on') {
    saveConfigField('always_on', true);
    hookOutput('UserPromptSubmit',
      '[oh-my-link] Always-On mode ENABLED.\n' +
      'From now on, every prompt will automatically use the OML workflow.\n' +
      'Say "oml off" to disable.');
    return;
  }

  if (match.action === 'always-off') {
    saveConfigField('always_on', false);
    hookOutput('UserPromptSubmit',
      '[oh-my-link] Always-On mode DISABLED.\n' +
      'OML will only activate when you say "start link" or "start fast".\n' +
      'Say "oml on" to re-enable.');
    return;
  }

  // Handle debug mode toggle
  if (match.action === 'debug-on') {
    saveConfigField('debug_mode', true);
    const debugPath = getDebugLogPath(cwd);
    const hash = projectHash(cwd);
    hookOutput('UserPromptSubmit',
      '[oh-my-link] Debug mode ENABLED.\n\n' +
      `Project: ${cwd}\n` +
      `Hash: ${hash}\n` +
      `Debug log: ${debugPath}\n\n` +
      'All hook traces will be appended to the log file above.\n' +
      'Say "oml debug off" to disable.');
    return;
  }

  if (match.action === 'debug-off') {
    saveConfigField('debug_mode', false);
    const debugPath = getDebugLogPath(cwd);
    hookOutput('UserPromptSubmit',
      '[oh-my-link] Debug mode DISABLED.\n' +
      `Last debug log: ${debugPath}`);
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

  // Inject model configuration if overrides exist
  const modelConfig = buildModelConfigSection();

  debugLog(cwd, 'keyword', `action=${match.action} skill=${effectiveSkill || match.skill || 'none'}`);

  // ─── IMPERATIVE PROMPT REWRITE ───
  // Instead of injecting skill content as additionalContext (which Claude treats as
  // soft guidance and often ignores), we rewrite the user prompt into explicit
  // step-by-step orchestration instructions that Claude treats as its PRIMARY task.
  const imperativePrompt = buildImperativePrompt(match.action, augmentedPrompt, effectiveSkill, modelConfig, cwd);

  hookOutput('UserPromptSubmit', imperativePrompt);
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

  // Resolve plugin root via centralized logic (env → setup.json → __dirname)
  const pluginRoot = resolvePluginRoot();
  const skillPath = pluginRoot
    ? path.join(pluginRoot, 'skills', skillName, 'SKILL.md')
    : path.join(__dirname, '..', '..', 'skills', skillName, 'SKILL.md');

  try {
    if (fs.existsSync(skillPath)) {
      return fs.readFileSync(skillPath, 'utf-8').trim();
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Build an imperative orchestration prompt that forces Claude to use the Agent tool
 * to spawn subagents instead of doing work itself.
 *
 * Key insight: additionalContext is treated as "soft guidance" by Claude and often ignored.
 * By rewriting the user prompt into explicit step-by-step instructions with Agent tool calls,
 * Claude treats this as its PRIMARY task — "spawn agent X with prompt Y" — not optional context.
 */
function buildImperativePrompt(
  action: string,
  userRequest: string,
  effectiveSkill: string | undefined,
  modelConfig: string | null,
  cwd: string,
): string {
  const session = readJson<SessionState>(getSessionPath(cwd));
  const intent = session?.intent || 'standard';

  // Load skill content for reference (included as context, not as the primary instruction)
  const skillContent = effectiveSkill ? loadSkillContent(effectiveSkill) : null;

  let prompt = '';

  if (action === 'invoke-light') {
    // ─── START FAST ───
    if (intent === 'turbo') {
      prompt = buildTurboPrompt(userRequest, skillContent, modelConfig);
    } else {
      prompt = buildStandardFastPrompt(userRequest, skillContent, modelConfig);
    }
  } else if (action === 'invoke') {
    // ─── START LINK (full 7-phase) ───
    prompt = buildStartLinkPrompt(userRequest, skillContent, modelConfig);
  } else {
    // Other actions (doctor, setup, etc.) — use original skill injection
    prompt = `[MAGIC KEYWORD: ${action}]\n\nUser request:\n${userRequest}\n\n`;
    if (modelConfig) prompt += modelConfig + '\n\n';
    if (skillContent) {
      prompt += `--- SKILL INSTRUCTIONS ---\n${skillContent}\n--- END SKILL INSTRUCTIONS ---\n`;
      prompt += `\nIMPORTANT: Follow the skill instructions above IMMEDIATELY.`;
    }
  }

  return prompt;
}

function buildTurboPrompt(userRequest: string, skillContent: string | null, modelConfig: string | null): string {
  let p = `[OML START FAST — TURBO MODE]\n\n`;
  p += `You are the Oh-My-Link orchestrator. Your ONLY job is to spawn an Executor agent to handle this request.\n\n`;
  p += `## YOUR TASK (mandatory steps)\n\n`;
  p += `1. Use the **Agent tool** (also called Task tool) to spawn an Executor subagent with this prompt:\n\n`;
  p += `\`\`\`\n`;
  p += `You are the OML Executor. Implement this request directly:\n\n`;
  p += `${userRequest}\n\n`;
  p += `Steps:\n`;
  p += `1. Read the affected file(s)\n`;
  p += `2. Implement the fix using Edit\n`;
  p += `3. Self-verify (run build/test if available)\n`;
  p += `4. Report what you changed\n`;
  p += `\`\`\`\n\n`;
  p += `2. Wait for the Executor to finish\n`;
  p += `3. Report the Executor's result to the user\n\n`;
  p += `## RULES\n`;
  p += `- Do NOT implement anything yourself — you are the orchestrator, not the implementer\n`;
  p += `- Do NOT read source code yourself — the Executor will do that\n`;
  p += `- Do NOT skip spawning the agent — this is mandatory\n`;
  p += `- The Agent/Task tool is your primary tool for this task\n\n`;
  if (modelConfig) p += modelConfig + '\n\n';
  return p;
}

function buildStandardFastPrompt(userRequest: string, skillContent: string | null, modelConfig: string | null): string {
  let p = `[OML START FAST — STANDARD MODE]\n\n`;
  p += `You are the Oh-My-Link orchestrator. You coordinate agents — you do NOT implement code yourself.\n\n`;
  p += `## YOUR TASK (mandatory steps — execute in order)\n\n`;
  p += `### Step 1: Spawn Fast Scout\n`;
  p += `Use the **Agent tool** (also called Task tool) to spawn a Fast Scout subagent with this prompt:\n\n`;
  p += `\`\`\`\n`;
  p += `You are the OML Fast Scout. Analyze this request and produce a BRIEF.md:\n\n`;
  p += `${userRequest}\n\n`;
  p += `Steps:\n`;
  p += `1. Use Glob/Grep to locate the relevant files (be quick, under 3 minutes)\n`;
  p += `2. Read the key sections of those files\n`;
  p += `3. Write .oh-my-link/plans/BRIEF.md with:\n`;
  p += `   - Summary (1 paragraph: root cause or scope)\n`;
  p += `   - Affected Files (path + reason)\n`;
  p += `   - Suggested Approach (1-2 sentences)\n`;
  p += `   - Acceptance Criteria (checklist)\n`;
  p += `4. If the task is too complex (>3 files, unclear scope), say so and recommend "start link"\n`;
  p += `\`\`\`\n\n`;
  p += `### Step 2: Read BRIEF.md\n`;
  p += `After Fast Scout finishes, read \`.oh-my-link/plans/BRIEF.md\` to understand the analysis.\n\n`;
  p += `### Step 3: Spawn Executor\n`;
  p += `Use the **Agent tool** to spawn an Executor subagent with this prompt:\n\n`;
  p += `\`\`\`\n`;
  p += `You are the OML Executor. Read .oh-my-link/plans/BRIEF.md for your task analysis, then:\n\n`;
  p += `1. Read all affected files listed in BRIEF.md\n`;
  p += `2. Implement the fix using Edit (preferred) or Write (new files only)\n`;
  p += `3. Self-verify: run build/test commands if available\n`;
  p += `4. Report what you changed and verification results\n`;
  p += `\`\`\`\n\n`;
  p += `### Step 4: Report\n`;
  p += `After Executor finishes, summarize to the user: what was changed, files affected, verification result.\n\n`;
  p += `## RULES\n`;
  p += `- Do NOT read source code yourself — Fast Scout and Executor do that\n`;
  p += `- Do NOT write/edit any code yourself — Executor does that\n`;
  p += `- Do NOT skip agent spawning — you MUST use the Agent/Task tool for Steps 1 and 3\n`;
  p += `- You are the orchestrator: your tools are Agent/Task (to spawn), Read (to check artifacts), and reporting\n\n`;
  if (modelConfig) p += modelConfig + '\n\n';
  return p;
}

function buildStartLinkPrompt(userRequest: string, skillContent: string | null, modelConfig: string | null): string {
  let p = `[OML START LINK — FULL 7-PHASE PIPELINE]\n\n`;
  p += `You are the Oh-My-Link Master Orchestrator. You drive a 7-phase pipeline by spawning specialized agents.\n`;
  p += `You NEVER implement code yourself — all work is delegated to subagents via the Agent/Task tool.\n\n`;
  p += `## USER REQUEST\n${userRequest}\n\n`;
  p += `## YOUR TASK (execute phases in order)\n\n`;
  p += `### Phase 1: Spawn Scout\n`;
  p += `Use the **Agent tool** to spawn a Scout subagent:\n`;
  p += `- Scout explores the codebase and asks clarifying questions\n`;
  p += `- Scout writes CONTEXT.md to .oh-my-link/plans/CONTEXT.md\n`;
  p += `- Wait for Scout to finish, then present questions to user\n\n`;
  p += `### Gate 1: User Approval\n`;
  p += `Present Scout's questions/options to the user. BLOCK until user answers.\n`;
  p += `Lock decisions as D1, D2, ... Dn.\n\n`;
  p += `### Phase 2: Spawn Architect\n`;
  p += `Use the **Agent tool** to spawn an Architect subagent:\n`;
  p += `- Pass CONTEXT.md + locked decisions\n`;
  p += `- Architect writes plan.md to .oh-my-link/plans/plan.md\n\n`;
  p += `### Gate 2: User Approval\n`;
  p += `Present plan summary to user. BLOCK until approved. Loop if feedback given.\n\n`;
  p += `### Phase 3-4: Decomposition & Validation\n`;
  p += `Spawn Architect again to decompose plan into task JSONs in .oh-my-link/tasks/.\n\n`;
  p += `### Gate 3: Execution Approval\n`;
  p += `Show task list and dependencies. Ask user: Sequential or Parallel? BLOCK until approved.\n\n`;
  p += `### Phase 5: Spawn Worker(s)\n`;
  p += `For each task (respecting depends_on order):\n`;
  p += `1. Write worker-{link-id}.md with task details\n`;
  p += `2. Use the **Agent tool** to spawn a Worker subagent with the task\n`;
  p += `3. Worker implements within file_scope, self-verifies, updates task status\n\n`;
  p += `### Phase 6: Spawn Reviewer\n`;
  p += `After each Worker completes, spawn a Reviewer to verify the implementation.\n`;
  p += `On FAIL: re-spawn Worker with feedback. On PASS: continue.\n\n`;
  p += `### Phase 7: Summary\n`;
  p += `Write WRAP-UP.md. Set session to complete.\n\n`;
  p += `## CRITICAL RULES\n`;
  p += `- You are the ORCHESTRATOR — never read source code, never write/edit code files\n`;
  p += `- Use the **Agent tool** (also called Task tool) to spawn each specialist\n`;
  p += `- Each agent does ONE job: Scout explores, Architect plans, Worker implements, Reviewer reviews\n`;
  p += `- Update session.json phase at every transition\n`;
  p += `- Respect all 3 HITL gates — never proceed without user approval\n\n`;
  if (modelConfig) p += modelConfig + '\n\n';
  if (skillContent) {
    p += `## REFERENCE (detailed skill instructions)\n${skillContent}\n`;
  }
  return p;
}

// Run
main().catch(() => {
  // Fail silently — hook errors should not block user input
  hookOutput('UserPromptSubmit');
});
