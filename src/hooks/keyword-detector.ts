import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, hookOutput, promptContextOutput, readJson, writeJsonAtomic, getCwd, getQuietLevel, debugLog } from '../helpers';
import { loadMemory, saveMemory, addDirective } from '../project-memory';
import { loadConfig, DEFAULT_MODELS, saveConfigField, isAlwaysOn, getModelForRole } from '../config';
import { generateFramework, formatFramework } from '../prompt-leverage';
import { getSessionPath, ensureDir, getProjectStateRoot, normalizePath, resolvePluginRoot, getDebugLogPath, projectHash } from '../state';
import { SessionState, HookInput, AgentRole } from '../types';
import { listTasks, updateTaskStatus, cleanExpiredLocks } from '../task-engine';

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

/**
 * Build model instruction line for a specific role.
 * Returns empty string if using defaults; otherwise returns an instruction like:
 * "Use model: claude-sonnet-4-6 (configured for this role)"
 */
function getModelInstruction(role: string, cwd?: string): string {
  try {
    const model = getModelForRole(role as AgentRole, cwd);
    return `\nIMPORTANT: When spawning this agent, set model to: ${model}\n`;
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

  // Block subagents from triggering keywords (prevents infinite re-trigger loops)
  // Note: OML_AGENT_ROLE is never set in CC's hook model (separate processes),
  // so we check OML_TEAM_WORKER only as a safety net for future use
  if (process.env.OML_TEAM_WORKER) {
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
    // Check if there's already an active session — if so, check for gate continuation
    const existingSession = readJson<SessionState>(getSessionPath(cwd));
    if (existingSession?.active) {
      // Check if we're at a HITL gate — inject continuation context
      if (existingSession.awaiting_confirmation && isGatePhase(existingSession.current_phase)) {
        const gateContext = buildGateContinuationContext(existingSession, prompt);
        debugLog(cwd, 'keyword', `gate-continuation: phase=${existingSession.current_phase}`);
        // Clear awaiting_confirmation so the orchestrator proceeds
        existingSession.awaiting_confirmation = false;
        try { writeJsonAtomic(getSessionPath(cwd), existingSession); } catch { /* best effort */ }
        promptContextOutput(gateContext);
        return;
      }
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
    // Check if there's an active session at a HITL gate — user input is the gate answer
    const activeSession = readJson<SessionState>(getSessionPath(cwd));
    if (activeSession?.active && activeSession.awaiting_confirmation && isGatePhase(activeSession.current_phase)) {
      const gateContext = buildGateContinuationContext(activeSession, prompt);
      debugLog(cwd, 'keyword', `gate-continuation (no-match): phase=${activeSession.current_phase}`);
      activeSession.awaiting_confirmation = false;
      try { writeJsonAtomic(getSessionPath(cwd), activeSession); } catch { /* best effort */ }
      promptContextOutput(gateContext);
      return;
    }
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

  // Handle cancel action directly — write cancel signal + deactivate session + cleanup
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
      session.deactivated_reason = 'user_cancelled';
      try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* best effort */ }
    }

    // Fail in-progress tasks
    try {
      const tasks = listTasks(cwd);
      for (const task of tasks) {
        if (task.status === 'in_progress' || task.status === 'pending') {
          updateTaskStatus(cwd, task.link_id, 'failed');
        }
      }
    } catch { /* best effort */ }

    // Clean up expired locks
    try { cleanExpiredLocks(cwd); } catch { /* best effort */ }

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
          locked_mode: mode,
          locked_phase: intent === 'turbo' ? 'light_turbo' : 'light_scout',
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
          locked_mode: mode,
          locked_phase: 'bootstrap' as any,
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

  promptContextOutput(imperativePrompt);
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

/** Check if the current phase is a HITL gate that requires user input */
function isGatePhase(phase: string): boolean {
  return ['gate_1_pending', 'gate_2_pending', 'gate_3_pending'].includes(phase);
}

/**
 * Build continuation context when user answers a HITL gate question.
 * This is injected as plain stdout so Claude knows to continue the pipeline.
 */
function buildGateContinuationContext(session: SessionState, userAnswer: string): string {
  const phase = session.current_phase;
  const mode = session.mode === 'mylink' ? 'Start Link' : 'Start Fast';

  let ctx = `[OML ${mode.toUpperCase()} — GATE RESPONSE]\n\n`;
  ctx += `The user has answered the gate questions. Here is their response:\n\n`;
  ctx += `---\n${userAnswer}\n---\n\n`;

  if (phase === 'gate_1_pending') {
    ctx += `## NEXT STEPS\n`;
    ctx += `1. Lock the user's answers as D1, D2, D3, etc.\n`;
    ctx += `2. Update session.json: set current_phase to "phase_2_planning" and awaiting_confirmation to false\n`;
    ctx += `3. Spawn the Architect agent to design the implementation plan:\n`;
    ctx += `   - Use the Task tool with description: "[OML:architect] Design plan based on Scout findings + user decisions"\n`;
    ctx += `   - Pass the CONTEXT.md content and the locked decisions in the prompt\n`;
    ctx += `4. After Architect finishes, present the plan summary and ask for approval (Gate 2)\n\n`;
  } else if (phase === 'gate_2_pending') {
    ctx += `## NEXT STEPS\n`;
    const isApproved = /\b(?:yes|approve|ok|lgtm|đồng ý|duyệt|được|oke)\b/i.test(userAnswer);
    if (isApproved) {
      ctx += `User APPROVED the plan. Proceed to Phase 3-4:\n`;
      ctx += `1. Update session.json: set current_phase to "phase_3_decomposition"\n`;
      ctx += `2. Spawn Architect again to decompose the plan into task JSONs\n`;
      ctx += `3. After decomposition, present task list to user (Gate 3)\n\n`;
    } else {
      ctx += `User provided FEEDBACK on the plan. Incorporate their feedback:\n`;
      ctx += `1. Spawn Architect again with the feedback to revise the plan\n`;
      ctx += `2. Present the revised plan to user for approval\n\n`;
    }
  } else if (phase === 'gate_3_pending') {
    ctx += `## NEXT STEPS\n`;
    const isParallel = /\b(?:parallel|song song)\b/i.test(userAnswer);
    ctx += `User chose: ${isParallel ? 'PARALLEL' : 'SEQUENTIAL'} execution.\n`;
    ctx += `1. Update session.json: set current_phase to "phase_5_execution"\n`;
    ctx += `2. Start spawning Worker agents for tasks (${isParallel ? 'respecting depends_on but running independent tasks in parallel' : 'one task at a time, in order'})\n\n`;
  }

  ctx += `## REMINDER: You are the ORCHESTRATOR\n`;
  ctx += `- Do NOT implement code yourself\n`;
  ctx += `- Use the Task tool to spawn agents for each phase\n`;
  ctx += `- Include [OML:role-name] in agent descriptions\n`;

  return ctx;
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
      prompt = buildTurboPrompt(userRequest, skillContent, modelConfig, cwd);
    } else {
      prompt = buildStandardFastPrompt(userRequest, skillContent, modelConfig, cwd);
    }
  } else if (action === 'invoke') {
    // ─── START LINK (full 7-phase) ───
    prompt = buildStartLinkPrompt(userRequest, skillContent, modelConfig, cwd);
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

function buildTurboPrompt(userRequest: string, skillContent: string | null, modelConfig: string | null, cwd?: string): string {
  const executorModel = getModelInstruction('executor', cwd);
  let p = `[OML START FAST — TURBO MODE]\n\n`;
  p += `You are the Oh-My-Link orchestrator. Your ONLY job is to spawn an Executor agent to handle this request.\n\n`;
  p += `## HOW TO SPAWN AN AGENT\n`;
  p += `Use the Task tool with these exact parameters:\n`;
  p += `- subagent_type: "general" (for scout/architect/reviewer) or "fixer" (for executor/worker)\n`;
  p += `- description: "[OML:role-name] Brief description of the task"\n`;
  p += `- prompt: "Full instructions for the agent"\n\n`;
  p += `## YOUR TASK (mandatory steps)\n\n`;
  p += `1. Use the **Agent tool** (also called Task tool) to spawn an Executor subagent.\n`;
  p += `   - Set the description to: "[OML:executor] Execute: ${userRequest.slice(0, 80)}"\n`;
  if (executorModel) p += `   ${executorModel}`;
  p += `   - Set the prompt to:\n\n`;
  p += `\`\`\`\n`;
  p += `You are the OML Executor [OML:executor]. Implement this request directly:\n\n`;
  p += `${userRequest}\n\n`;
  p += `Steps:\n`;
  p += `1. Read the affected file(s)\n`;
  p += `2. Implement the fix using Edit\n`;
  p += `3. Self-verify (run build/test if available)\n`;
  p += `4. Report what you changed\n`;
  p += `\`\`\`\n\n`;
  p += `2. Wait for the Executor to finish\n`;
  p += `3. Report the Executor's result to the user\n\n`;
  p += `## IF EXECUTOR FAILS\n`;
  p += `- Do NOT implement the fix yourself — you are the orchestrator\n`;
  p += `- Re-spawn a NEW Executor with additional context about what failed\n`;
  p += `- Include the error details in the new prompt so Executor can try a different approach\n`;
  p += `- If Executor fails 3 times, report failure to the user and suggest "start link" for complex tasks\n\n`;
  p += `## RULES\n`;
  p += `- Do NOT implement anything yourself — you are the orchestrator, not the implementer\n`;
  p += `- Do NOT read source code yourself — the Executor will do that\n`;
  p += `- Do NOT skip spawning the agent — this is mandatory\n`;
  p += `- The Agent/Task tool is your primary tool for this task\n`;
  p += `- ALWAYS include [OML:role-name] in the agent description so the hook system can detect the role\n\n`;
  if (modelConfig) p += modelConfig + '\n\n';
  return p;
}

function buildStandardFastPrompt(userRequest: string, skillContent: string | null, modelConfig: string | null, cwd?: string): string {
  const scoutModel = getModelInstruction('fast-scout', cwd);
  const executorModel = getModelInstruction('executor', cwd);
  let p = `[OML START FAST — STANDARD MODE]\n\n`;
  p += `You are the Oh-My-Link orchestrator. You coordinate agents — you do NOT implement code yourself.\n\n`;
  p += `## HOW TO SPAWN AN AGENT\n`;
  p += `Use the Task tool with these exact parameters:\n`;
  p += `- subagent_type: "general" (for scout/architect/reviewer) or "fixer" (for executor/worker)\n`;
  p += `- description: "[OML:role-name] Brief description of the task"\n`;
  p += `- prompt: "Full instructions for the agent"\n\n`;
  p += `## YOUR TASK (mandatory steps — execute in order)\n\n`;
  p += `### Step 1: Spawn Fast Scout\n`;
  p += `Use the **Agent tool** (also called Task tool) to spawn a Fast Scout subagent.\n`;
  p += `- Set the description to: "[OML:fast-scout] Analyze: ${userRequest.slice(0, 60)}"\n`;
  if (scoutModel) p += `${scoutModel}`;
  p += `- Set the prompt to:\n\n`;
  p += `\`\`\`\n`;
  p += `You are the OML Fast Scout [OML:fast-scout]. Analyze this request and produce a BRIEF.md:\n\n`;
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
  p += `Use the **Agent tool** to spawn an Executor subagent.\n`;
  p += `- Set the description to: "[OML:executor] Implement fix from BRIEF.md"\n`;
  if (executorModel) p += `${executorModel}`;
  p += `- Set the prompt to:\n\n`;
  p += `\`\`\`\n`;
  p += `You are the OML Executor [OML:executor]. Read .oh-my-link/plans/BRIEF.md for your task analysis, then:\n\n`;
  p += `1. Read all affected files listed in BRIEF.md\n`;
  p += `2. Implement the fix using Edit (preferred) or Write (new files only)\n`;
  p += `3. Self-verify: run build/test commands if available\n`;
  p += `4. Report what you changed and verification results\n`;
  p += `\`\`\`\n\n`;
  p += `### Step 4: Report\n`;
  p += `After Executor finishes, summarize to the user: what was changed, files affected, verification result.\n\n`;
  p += `## IF AN AGENT FAILS\n`;
  p += `- Do NOT implement the fix yourself — you are the orchestrator\n`;
  p += `- Re-spawn a NEW agent (Fast Scout or Executor) with additional context about what failed\n`;
  p += `- Include the error details in the new prompt so the agent can try a different approach\n`;
  p += `- If an agent fails 3 times, report failure to the user and suggest "start link" for complex tasks\n\n`;
  p += `## RULES\n`;
  p += `- Do NOT read source code yourself — Fast Scout and Executor do that\n`;
  p += `- Do NOT write/edit any code yourself — Executor does that\n`;
  p += `- Do NOT skip agent spawning — you MUST use the Agent/Task tool for Steps 1 and 3\n`;
  p += `- You are the orchestrator: your tools are Agent/Task (to spawn), Read (to check artifacts), and reporting\n\n`;
  if (modelConfig) p += modelConfig + '\n\n';
  return p;
}

function buildStartLinkPrompt(userRequest: string, skillContent: string | null, modelConfig: string | null, cwd?: string): string {
  const scoutModel = getModelInstruction('scout', cwd);
  const architectModel = getModelInstruction('architect', cwd);
  const workerModel = getModelInstruction('worker', cwd);
  const reviewerModel = getModelInstruction('reviewer', cwd);
  let p = `[OML START LINK — FULL 7-PHASE PIPELINE]\n\n`;
  p += `You are the Oh-My-Link Master Orchestrator. You drive a 7-phase pipeline by spawning specialized agents.\n`;
  p += `You NEVER implement code yourself — all work is delegated to subagents via the Agent/Task tool.\n\n`;
  p += `## USER REQUEST\n${userRequest}\n\n`;
  p += `## AGENT NAMING & MODEL CONVENTION\n`;
  p += `When spawning any agent, ALWAYS:\n`;
  p += `1. Include the [OML:role-name] tag in the agent description (for hook system role detection)\n`;
  p += `2. Set the model parameter as specified below for each role\n`;
  p += `Examples: "[OML:scout] Explore codebase", "[OML:architect] Design plan", "[OML:worker] Implement task-1"\n\n`;
  p += `## HOW TO SPAWN AN AGENT\n`;
  p += `Use the Task tool with these exact parameters:\n`;
  p += `- subagent_type: "general" (for scout/architect/reviewer) or "fixer" (for executor/worker)\n`;
  p += `- description: "[OML:role-name] Brief description of the task"\n`;
  p += `- prompt: "Full instructions for the agent"\n\n`;
  p += `## YOUR TASK (execute phases in order)\n\n`;
  p += `### Phase 1: Spawn Scout\n`;
  p += `Use the **Agent tool** to spawn a Scout subagent:\n`;
  p += `- Description: "[OML:scout] Explore codebase for: ${userRequest.slice(0, 60)}"\n`;
  if (scoutModel) p += `${scoutModel}`;
  p += `- Scout explores the codebase and asks clarifying questions\n`;
  p += `- Scout writes CONTEXT.md to .oh-my-link/plans/CONTEXT.md\n`;
  p += `- Wait for Scout to finish, then present questions to user\n\n`;
  p += `### Gate 1: User Approval\n`;
  p += `After Scout finishes, present Scout's questions/options to the user as numbered choices (Q1, Q2, etc.).\n`;
  p += `**IMPORTANT: After presenting the questions, END YOUR RESPONSE IMMEDIATELY.**\n`;
  p += `Do NOT cogitate or think further — just stop your turn.\n`;
  p += `The user will type their answers (e.g., "Q1: B, Q2: A, Q3: C").\n`;
  p += `On your next turn, read their answers, lock as D1, D2, ... Dn, then proceed to Phase 2.\n`;
  p += `End your Gate 1 message with: "⏳ Vui lòng trả lời các câu hỏi trên để tiếp tục. (Type your choices, e.g., Q1: B, Q2: A...)"\n\n`;
  p += `### Phase 2: Spawn Architect\n`;
  p += `Use the **Agent tool** to spawn an Architect subagent:\n`;
  p += `- Description: "[OML:architect] Design plan"\n`;
  if (architectModel) p += `${architectModel}`;
  p += `- Pass CONTEXT.md + locked decisions\n`;
  p += `- Architect writes plan.md to .oh-my-link/plans/plan.md\n\n`;
  p += `### Gate 2: User Approval\n`;
  p += `Present plan summary to user. **END YOUR RESPONSE IMMEDIATELY after presenting.**\n`;
  p += `The user will type approval or feedback. On next turn, if approved proceed to Phase 3; if feedback, loop.\n`;
  p += `End your Gate 2 message with: "⏳ Approve this plan? (yes/approve, or provide feedback)"\n\n`;
  p += `### Phase 3-4: Decomposition & Validation\n`;
  p += `Spawn Architect again (description: "[OML:architect] Decompose plan into tasks") to decompose plan into task JSONs in .oh-my-link/tasks/.\n\n`;
  p += `### Gate 3: Execution Approval\n`;
  p += `Show task list and dependencies. **END YOUR RESPONSE IMMEDIATELY after presenting.**\n`;
  p += `The user will choose Sequential or Parallel and approve. On next turn, proceed with their choice.\n`;
  p += `End your Gate 3 message with: "⏳ Choose execution mode: Sequential or Parallel? (Type your choice)"\n\n`;
  p += `### Phase 5: Spawn Worker(s)\n`;
  p += `For each task (respecting depends_on order):\n`;
  p += `1. Write worker-{link-id}.md with task details\n`;
  p += `2. Use the **Agent tool** to spawn a Worker subagent (description: "[OML:worker] Implement task-{id}") with the task\n`;
  if (workerModel) p += `   ${workerModel}`;
  p += `3. Worker implements within file_scope, self-verifies, updates task status\n\n`;
  p += `### Phase 6: Spawn Reviewer\n`;
  p += `After each Worker completes, spawn a Reviewer (description: "[OML:reviewer] Review task-{id}") to verify the implementation.\n`;
  if (reviewerModel) p += `${reviewerModel}`;
  p += `On FAIL: re-spawn Worker with feedback. On PASS: continue.\n\n`;
  p += `### Phase 7: Summary\n`;
  p += `Write WRAP-UP.md. Set session to complete.\n\n`;
  p += `## IF AN AGENT FAILS\n`;
  p += `- Do NOT implement the fix yourself — you are the orchestrator\n`;
  p += `- Re-spawn a NEW agent with additional context about what failed\n`;
  p += `- Include the error details in the new prompt so the agent can try a different approach\n`;
  p += `- If an agent fails 3 times, report failure to the user and ask how to proceed\n\n`;
  p += `## CRITICAL RULES\n`;
  p += `- You are the ORCHESTRATOR — never read source code, never write/edit code files\n`;
  p += `- Use the **Agent tool** (also called Task tool) to spawn each specialist\n`;
  p += `- ALWAYS include [OML:role-name] in agent descriptions (e.g. [OML:scout], [OML:worker], [OML:executor])\n`;
  p += `- Each agent does ONE job: Scout explores, Architect plans, Worker implements, Reviewer reviews\n`;
  p += `- DO NOT write to session.json — the OML hook system manages phase transitions automatically\n`;
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
