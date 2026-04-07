import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, hookOutput, readJson, getCwd, getQuietLevel, getElapsed, debugLog } from '../helpers';
import {
  ensureRuntimeDirs, ensureArtifactDirs, getSessionPath,
  getProjectMemoryPath, getPriorityContextPath, getWorkingMemoryPath,
  getCheckpointPath, getProjectStateRoot, getHandoffsDir, normalizePath,
  registerProject
} from '../state';
import { SessionState, ProjectMemory, HookInput, Checkpoint } from '../types';
import { loadMemory, needsRescan, detectProjectEnv, saveMemory, formatSummary } from '../project-memory';
import { loadConfig, DEFAULT_MODELS } from '../config';
import { AgentRole } from '../types';

// ============================================================
// Oh-My-Link — Session Start (SessionStart)
// ============================================================

const VERSION = '0.1.0';

function getLatestHandoff(handoffsDir: string): string | null {
  try {
    if (!fs.existsSync(handoffsDir)) return null;
    const files = fs.readdirSync(handoffsDir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();
    if (files.length === 0) return null;
    return fs.readFileSync(path.join(handoffsDir, files[0]), 'utf-8');
  } catch { return null; }
}

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const cwd = getCwd(input as Record<string, unknown>);
  const sessionId = input.session_id || '';
  const quiet = getQuietLevel();
  const source = (input as Record<string, unknown>).source as string || 'startup';

  // 1. Ensure all directories exist
  ensureRuntimeDirs(cwd, sessionId);
  ensureArtifactDirs(cwd);

  debugLog(cwd, 'session-start', `source=${source} session_id=${sessionId || 'none'}`);

  // 1b. Register this workspace in the global project registry
  try { registerProject(cwd); } catch { /* best effort */ }

  // Session-scoped dedup: only clear injected-skills.json if session has changed
  const injectedSkillsPath = normalizePath(path.join(getProjectStateRoot(cwd), 'injected-skills.json'));
  try {
    const session = readJson<SessionState>(getSessionPath(cwd));
    const injectedData = readJson<{ session_started_at?: string }>(injectedSkillsPath);
    // Clear only if the session is different (new session started)
    if (session?.started_at && injectedData?.session_started_at
        && session.started_at !== injectedData.session_started_at) {
      fs.unlinkSync(injectedSkillsPath);
    } else if (!session?.active && fs.existsSync(injectedSkillsPath)) {
      // No active session → clear stale dedup data
      fs.unlinkSync(injectedSkillsPath);
    }
  } catch { /* ignore */ }

  // Check prerequisites early (skip on compact to save context)
  let nodeWarning: string | null = null;
  if (source !== 'compact') {
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    if (major < 18) {
      // Warn but don't return early — continue to inject memory, priority context, resume state
      nodeWarning = `[WARNING] Node.js ${nodeVersion} detected. Oh-My-Link requires >= 18.`;
    }
  }

  const parts: string[] = [];
  if (nodeWarning) parts.push(nodeWarning);
  let projectMemoryPart: string | null = null;
  let priorityContextPart: string | null = null;
  let workingMemoryPart: string | null = null;

  // 2-4. Memory injection: try layered stack first, fall back to flat injection
  let memoryInjected = false;
  try {
    const { wakeUp } = require('../memory/memory-stack') as { wakeUp: (cwd: string, taskHint?: string) => string | null };
    const session = readJson<SessionState>(getSessionPath(cwd));
    const taskHint = session?.feature_slug || '';
    debugLog(cwd, 'mem:wakeup', `calling wakeUp(taskHint="${taskHint}")`);
    const memoryBlock = wakeUp(cwd, taskHint);
    if (memoryBlock) {
      parts.push(`[Memory]\n${memoryBlock}`);
      debugLog(cwd, 'mem:wakeup', `injected layered memory stack: ${memoryBlock.length} chars`);
      memoryInjected = true;
    } else {
      debugLog(cwd, 'mem:wakeup', 'wakeUp returned null — falling back to flat injection');
    }
  } catch (err) {
    debugLog(cwd, 'mem:wakeup', `FAILED, falling back to flat injection: ${(err as Error)?.message || err}`);
  }

  // Fallback: original flat injection if memory stack returned null or threw
  if (!memoryInjected) {
    // 2. Load and auto-rescan project memory
    try {
      let memory = loadMemory(cwd);
      if (needsRescan(memory)) {
        const freshStack = detectProjectEnv(cwd);
        memory.tech_stack = freshStack;
        memory.last_scanned_at = new Date().toISOString();
        saveMemory(cwd, memory);
      }
      const memorySummary = formatSummary(memory, 650);
      if (memorySummary) {
        projectMemoryPart = `[Project Memory]\n${memorySummary}`;
        debugLog(cwd, 'mem:flat', `injected project-memory: ${memorySummary.length} chars`);
      }
    } catch { /* best effort */ }

    // 3. Inject priority context content
    const priorityPath = getPriorityContextPath(cwd);
    if (fs.existsSync(priorityPath)) {
      try {
        const content = fs.readFileSync(priorityPath, 'utf-8').trim();
        if (content) {
          priorityContextPart = `[Priority Context]\n${content}`;
          debugLog(cwd, 'mem:flat', 'injected priority-context');
        }
      } catch { /* ignore */ }
    }

    // 4. Inject working memory (all entries)
    const workingPath = getWorkingMemoryPath(cwd);
    if (fs.existsSync(workingPath)) {
      try {
        const content = fs.readFileSync(workingPath, 'utf-8').trim();
        if (content) {
          workingMemoryPart = `[Working Memory]\n${content}`;
          const entryCount = content.split(/\n---\n/).filter(e => e.trim()).length;
          debugLog(cwd, 'mem:flat', `injected working-memory: ${entryCount} entries`);
        }
      } catch { /* ignore */ }
    }

    // Insert in correct order
    if (priorityContextPart) parts.push(priorityContextPart);
    if (workingMemoryPart) parts.push(workingMemoryPart);
    if (projectMemoryPart) parts.push(projectMemoryPart);
  }

  // 5. Check for active session (resume detection)
  const session = readJson<SessionState>(getSessionPath(cwd));
  if (session?.active) {
    const mode = session.mode === 'mylink' ? 'Start Link' : 'Start Fast';
    const phase = session.current_phase;
    const elapsed = getElapsed(session.started_at);

    debugLog(cwd, 'session-start', `active-session: mode=${session.mode} phase=${phase} elapsed=${elapsed}`);

    parts.push(`oh-my-link v${VERSION} loaded. Active: ${mode} [${phase}] (${elapsed} elapsed)`);
    parts.push(`Modes: Start Link ('start link') | Start Fast ('start fast') | Cancel: 'cancel oml'`);

    // Mode-specific resume handling
    if (session.mode === 'mylight') {
      // Start Fast resume: offer options
      let resumeInfo = `\nACTIVE Start Fast SESSION — Phase: ${phase} (${elapsed} ago)`;
      if (session.failure_count > 0) {
        resumeInfo += ` | Retries: ${session.failure_count}`;
      }
      if (session.feature_slug) {
        resumeInfo += ` | Task: ${session.feature_slug}`;
      }
      resumeInfo += `\nOptions:`;
      resumeInfo += `\n  1. Resume — say "start fast" to continue from ${phase}`;
      resumeInfo += `\n  2. Restart — say "start fast" with new instructions to start fresh`;
      resumeInfo += `\n  3. Cancel — say "cancel oml" to deactivate session`;
      parts.push(resumeInfo);
    } else {
      // Start Link resume
      parts.push(
        `\nACTIVE SESSION DETECTED — Mode: ${mode}, Phase: ${phase}, started: ${session.started_at}.` +
        `\nResume by saying "start link" or start fresh with "cancel oml" first.`
      );
    }
  } else {
    // First start banner
    if (quiet === 0) {
      parts.push(`oh-my-link v${VERSION} loaded.`);
      parts.push(`Modes: Start Link ('start link') | Start Fast ('start fast') | Cancel: 'cancel oml'`);
    }
  }

  // 6. Inject model config overrides
  try {
    const config = loadConfig();
    const overrides: string[] = [];
    for (const [role, model] of Object.entries(config.models)) {
      if (model !== DEFAULT_MODELS[role as AgentRole]) {
        overrides.push(`${role}=${model}`);
      }
    }
    if (overrides.length > 0) {
      parts.push(`[Model Config] Custom overrides: ${overrides.join(', ')}`);
    }
  } catch { /* best effort */ }

  // 7. Post-compaction auto-resume
  if (source === 'compact') {
    const checkpoint = readJson<Checkpoint>(getCheckpointPath(cwd));
    const handoffsDir = getHandoffsDir(cwd);
    const handoff = getLatestHandoff(handoffsDir);

    if (checkpoint) {
      const cpPhase = checkpoint.session?.current_phase || 'unknown';
      const cpFeature = checkpoint.session?.feature_slug || 'unknown';
      parts.push(
        `\n[oh-my-link] POST-COMPACTION RESUME` +
        `\nPhase: ${cpPhase} | Feature: ${cpFeature}` +
        `\nCheckpointed at: ${checkpoint.created_at || 'unknown'}` +
        `\nReinforcements: ${checkpoint.session?.reinforcement_count || 0}`
      );

      if (checkpoint.active_agents?.length > 0) {
        parts.push(`Active agents that may need re-spawning: ${checkpoint.active_agents.map(a => `${a.role}(${a.agent_id})`).join(', ')}`);
      }

      // Worker prompt recovery during execution phase
      if (cpPhase === 'phase_5_execution') {
        try {
          const plansDir = normalizePath(path.join(cwd, '.oh-my-link', 'plans'));
          if (fs.existsSync(plansDir)) {
            const workerFiles = fs.readdirSync(plansDir)
              .filter(f => f.startsWith('worker-') && f.endsWith('.md'))
              .sort()
              .reverse();
            if (workerFiles.length > 0) {
              parts.push(
                `\n[WORKER PROMPT RECOVERY] Worker prompt files found:` +
                `\n${workerFiles.map(f => `  - .oh-my-link/plans/${f}`).join('\n')}` +
                `\nIf you are a Worker and lost context, read the relevant file.`
              );
            }
          }
        } catch { /* best effort */ }
      }
    }

    if (handoff) {
      const truncated = handoff.length > 1500 ? handoff.substring(0, 1500) + '\n...(truncated)' : handoff;
      parts.push(`\n### Last Handoff\n${truncated}`);
    }

    if (checkpoint || handoff) {
      parts.push(
        `\nRESUME STEPS:` +
        `\n1. Read session state for current phase` +
        `\n2. Read AGENTS.md for workflow rules` +
        `\n3. Check task engine for next ready work` +
        `\n4. Continue from the phase indicated above`
      );
    }
  }

  // Output
  const context = parts.join('\n');
  hookOutput('SessionStart', context || undefined);
}

// Run
main().catch(() => {
  hookOutput('SessionStart');
});
