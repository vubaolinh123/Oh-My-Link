import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, readJson, writeJsonAtomic, hookOutput, simpleOutput,
         getCwd, logError, getQuietLevel, debugLog } from '../helpers';
import { getProjectStateRoot, getSubagentTrackingPath, getSessionPath, normalizePath } from '../state';
import { HookInput, SubagentRecord, TaskAssignment, SessionState, Phase, AgentRole } from '../types';
import { readTask, updateTaskStatus, releaseAllLocks, listTasks } from '../task-engine';
import { getMcpGuidanceForRole } from '../mcp-config';

// ============================================================
// Oh-My-Link — Subagent Lifecycle (SubagentStart + SubagentStop)
// The heart of file-based agent coordination
// ============================================================

// (trimTracking removed — allow full tracking history for large projects)

// ── Auto Phase Tracking ─────────────────────────────────────
// Phase ordering for forward-only advancement
const MYLINK_PHASE_ORDER: string[] = [
  'bootstrap',
  'phase_0_memory',
  'phase_1_scout',
  'gate_1_pending',
  'phase_2_planning',
  'gate_2_pending',
  'phase_3_decomposition',
  'phase_4_validation',
  'gate_3_pending',
  'phase_5_execution',
  'phase_6_review',
  'phase_6_5_full_review',
  'phase_7_summary',
  'complete',
];

const MYLIGHT_PHASE_ORDER: string[] = [
  'light_scout',
  'light_turbo',
  'light_execution',
  'light_complete',
];

// ── Review→Fix loop ──
// When a reviewer returns FAIL, regress phase to phase_5_execution so Master
// can re-spawn Workers with the reviewer feedback. Circuit-break after
// MAX_REVISIONS to avoid infinite loops.
const MAX_REVISIONS = 3;
const REVIEW_ROLES = ['reviewer', 'code-reviewer', 'security-reviewer'];

/**
 * Read the most recently modified review artifact under .oh-my-link/reviews/
 * and parse its `VERDICT: ...` line. Returns null if no review file or no
 * recognizable verdict. Treats `PASS_WITH_NOTES` as PASS.
 */
function readLatestReviewVerdict(cwd: string): 'PASS' | 'MINOR' | 'FAIL' | null {
  const reviewsDir = path.join(cwd, '.oh-my-link', 'reviews');
  if (!fs.existsSync(reviewsDir)) return null;
  let entries: { path: string; mtime: number }[];
  try {
    entries = fs.readdirSync(reviewsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const p = path.join(reviewsDir, f);
        return { path: p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return null; }
  if (entries.length === 0) return null;
  let content: string;
  try { content = fs.readFileSync(entries[0].path, 'utf-8'); } catch { return null; }
  const m = content.match(/VERDICT:\s*(PASS_WITH_NOTES|PASS|MINOR|FAIL)/i);
  if (!m) return null;
  const v = m[1].toUpperCase();
  if (v === 'FAIL') return 'FAIL';
  if (v === 'MINOR') return 'MINOR';
  return 'PASS';
}

/**
 * Compute the target phase for an agent role based on mode + current session state.
 * Returns null if the role doesn't imply a phase transition.
 */
function getTargetPhaseForRole(role: string, session: SessionState): Phase | null {
  if (session.mode === 'mylink') {
    switch (role) {
      case 'scout':
        return 'phase_1_scout';
      case 'architect': {
        // Architect can be in P2 (planning) or P3 (decomposition).
        // If already at/past P2, next architect spawn is P3.
        const curIdx = MYLINK_PHASE_ORDER.indexOf(session.current_phase);
        const p2Idx = MYLINK_PHASE_ORDER.indexOf('phase_2_planning');
        return curIdx >= p2Idx ? 'phase_3_decomposition' : 'phase_2_planning';
      }
      case 'worker':
      case 'executor':
        return 'phase_5_execution';
      case 'reviewer':
      case 'code-reviewer':
      case 'security-reviewer':
        return 'phase_6_review';
      case 'verifier':
        return 'phase_4_validation';
      default:
        return null; // master, explorer, etc. don't trigger phase changes
    }
  }

  if (session.mode === 'mylight') {
    switch (role) {
      case 'fast-scout':
      case 'scout':
        return 'light_scout';
      case 'executor':
      case 'worker':
        return session.intent === 'turbo' ? 'light_turbo' : 'light_execution';
      default:
        return null;
    }
  }

  return null;
}

/**
 * Advance session phase forward only (never regress).
 * Returns true if phase was advanced.
 */
function maybeAdvancePhase(session: SessionState, targetPhase: Phase): boolean {
  const order = session.mode === 'mylight' ? MYLIGHT_PHASE_ORDER : MYLINK_PHASE_ORDER;
  const currentIdx = order.indexOf(session.current_phase);
  const targetIdx = order.indexOf(targetPhase);

  // Only advance forward
  if (targetIdx > currentIdx) {
    session.current_phase = targetPhase;
    session.last_checked_at = new Date().toISOString();
    // Clear awaiting_confirmation when moving past a gate
    if (session.awaiting_confirmation && !targetPhase.startsWith('gate_')) {
      session.awaiting_confirmation = false;
    }
    return true;
  }
  return false;
}

/**
 * Detect session completion: all tasks done, no running agents.
 */
function detectCompletion(cwd: string, session: SessionState, tracking: SubagentRecord[]): boolean {
  // Only relevant for execution/review phases
  const completionPhases = ['phase_5_execution', 'phase_6_review', 'phase_6_5_full_review',
    'phase_7_summary', 'light_execution', 'light_turbo'];
  if (!completionPhases.includes(session.current_phase)) return false;

  // Check if any agents are still running
  const running = tracking.filter(a => a.status === 'running');
  if (running.length > 0) return false;

  // Check if all tasks are done
  const tasks = listTasks(cwd);
  if (tasks.length === 0) return false; // No tasks at all → don't auto-complete
  const allDone = tasks.every(t => t.status === 'done' || t.status === 'failed');
  if (!allDone) return false;

  return true;
}

const ROLE_EXPECTATIONS: Record<string, {
  artifacts: string[];       // Expected file patterns (glob-like) under .oh-my-link/
  required: boolean;         // If true, warn when missing
  description: string;       // What this role should produce
}> = {
  scout: {
    artifacts: ['CONTEXT.md'],
    required: true,
    description: 'Scout must produce CONTEXT.md with codebase analysis',
  },
  'fast-scout': {
    artifacts: ['BRIEF.md'],
    required: true,
    description: 'Fast-Scout must produce BRIEF.md with targeted analysis',
  },
  architect: {
    artifacts: ['plan.md'],
    required: true,
    description: 'Architect must produce plan.md with implementation plan',
  },
  reviewer: {
    artifacts: ['review.md'],
    required: false,
    description: 'Reviewer should produce review.md with findings',
  },
  'code-reviewer': {
    artifacts: ['code-review.md'],
    required: false,
    description: 'Code-reviewer should produce code-review.md',
  },
  'security-reviewer': {
    artifacts: ['security-review.md'],
    required: false,
    description: 'Security-reviewer should produce security-review.md',
  },
  'test-engineer': {
    artifacts: [],
    required: false,
    description: 'Test-engineer should create or update test files',
  },
};

/**
 * Get MCP guidance for an agent by its detected role string.
 * Wraps getMcpGuidanceForRole with safe casting and error handling.
 */
function getMcpGuidanceForAgent(role: string, cwd: string): string {
  try {
    const knownRoles: string[] = [
      'master', 'scout', 'fast-scout', 'architect', 'worker', 'reviewer',
      'explorer', 'executor', 'verifier', 'code-reviewer', 'security-reviewer', 'test-engineer',
    ];
    if (!knownRoles.includes(role)) return '';
    const guidance = getMcpGuidanceForRole(role as AgentRole, cwd);
    if (guidance) {
      debugLog(cwd, 'mcp-inject', `role=${role} guidance_len=${guidance.length}`);
    }
    return guidance;
  } catch {
    // MCP config read failure should never block agent start
    return '';
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2]; // 'start' or 'stop'
  const input = await parseHookInput() as HookInput;
  const cwd = getCwd(input as Record<string, unknown>);

  if (mode === 'start') {
    await handleStart(input, cwd);
  } else if (mode === 'stop') {
    await handleStop(input, cwd);
  } else {
    simpleOutput();
  }
}

async function handleStart(input: HookInput, cwd: string): Promise<void> {
  const agentId = input.agent_id || (input as any).agentId || (input as any).id || `agent-${process.pid}`;
  const agentType = input.agent_type || (input as any).agentType || (input as any).type || '';
  // Claude Code may send description under various field names
  const description = input.agent_description || (input as any).agentDescription
    || (input as any).description || (input as any).task_description || (input as any).taskDescription || '';
  // Agent prompt: try all known field names
  const prompt = input.agent_prompt || (input as any).agentPrompt
    || (input as any).prompt || (input as any).task_prompt || (input as any).taskPrompt || '';
  const quiet = getQuietLevel();

  // Debug: log raw payload fields to help diagnose role detection issues
  const rawKeys = Object.keys(input).filter(k => (input as any)[k] !== undefined && (input as any)[k] !== '');
  debugLog(cwd, 'agent-start-raw', `keys=[${rawKeys.join(',')}] agent_type=${JSON.stringify(agentType)} desc=${JSON.stringify(description.slice(0, 120))} prompt_start=${JSON.stringify((prompt || '').slice(0, 120))}`);

  // Detect role from agent_type or description + prompt
  let role = detectRole(agentType, description + ' ' + prompt);

  // ── SESSION-AWARE ROLE INFERENCE ──
  // Claude Code's SubagentStart payload often lacks description/prompt fields entirely.
  // When agent_type is "general-purpose" and description is empty, detectRole() blindly
  // maps to "worker" which causes phase skip (e.g. light_scout → light_execution).
  // Fix: use session phase + mode to infer the EXPECTED role at this point in the pipeline.
  const descIsEmpty = !description.trim() && !prompt.trim();
  if (descIsEmpty && (role === 'worker' || role === 'unknown')) {
    const sessionPathForInference = getSessionPath(cwd);
    const sessionForInference = readJson<SessionState>(sessionPathForInference);
    if (sessionForInference?.active) {
      const inferred = inferRoleFromSession(sessionForInference);
      if (inferred) {
        debugLog(cwd, 'agent-start', `role-inference: ${role} → ${inferred} (phase=${sessionForInference.locked_phase || sessionForInference.current_phase}, mode=${sessionForInference.locked_mode || sessionForInference.mode})`);
        role = inferred;
        // Clear locked_phase after first successful inference so subsequent
        // agent spawns use the actual current_phase (which subagent-lifecycle
        // manages via maybeAdvancePhase, not the LLM)
        if (sessionForInference.locked_phase) {
          sessionForInference.locked_phase = undefined;
          try { writeJsonAtomic(sessionPathForInference, sessionForInference); } catch { /* best effort */ }
        }
      }
    }
  }

  debugLog(cwd, 'agent-start', `id=${agentId} role=${role} type=${agentType}`);

  // Record in subagent tracking
  const trackingPath = getSubagentTrackingPath(cwd);
  const tracking = readJson<SubagentRecord[]>(trackingPath) || [];

  const record: SubagentRecord = {
    agent_id: agentId,
    role: role,
    started_at: new Date().toISOString(),
    status: 'running',
  };

  // ── AUTO PHASE TRACKING ──
  // When a recognized agent role starts, advance session.current_phase forward.
  // This ensures the statusline and stop-handler always reflect actual progress.
  const sessionPath = getSessionPath(cwd);
  const session = readJson<SessionState>(sessionPath);
  let phaseAdvanced = false;

  if (session?.active) {
    const targetPhase = getTargetPhaseForRole(role, session);
    if (targetPhase) {
      phaseAdvanced = maybeAdvancePhase(session, targetPhase);
      if (phaseAdvanced) {
        debugLog(cwd, 'agent-start', `phase-advance → ${session!.current_phase}`);
        try { writeJsonAtomic(sessionPath, session); } catch { /* best effort */ }
      }
    }
  }

  // ── MEMORY INJECTION ──
  // Inject L0 identity + L1 vector memories so subagents start with historical context.
  // Uses the agent description/prompt as taskHint for task-relevant retrieval.
  let memoryBlock = '';
  try {
    const { wakeUp } = require('../memory/memory-stack');
    const taskHint = description || prompt?.slice(0, 200) || '';
    const result = wakeUp(cwd, taskHint);
    if (result) {
      memoryBlock = `\n\n[Memory]\n${result}`;
    }
  } catch { /* best effort — memory modules may not be compiled yet */ }

  // Auto-claim task for worker/executor roles
  if (isWorkerRole(role)) {
    const task = findAssignedTask(cwd, agentId, description);
    if (task) {
      record.link_id = task.link_id;
      // Auto-claim: set status to in_progress
      updateTaskStatus(cwd, task.link_id, 'in_progress');

      if (quiet < 2) {
        let context = `[oh-my-link] Auto-claimed task "${task.title}" (${task.link_id}).`;
        if (phaseAdvanced) context += ` Phase → ${session!.current_phase}`;
        // Append MCP guidance for this role
        const mcpGuidance = getMcpGuidanceForAgent(role, cwd);
        if (mcpGuidance) context += '\n' + mcpGuidance;
        // Append memory context
        if (memoryBlock) context += memoryBlock;
        // Dedup: remove existing entry with same ID (handles retries)
        const dedupedTracking = tracking.filter(a => a.agent_id !== agentId);
        dedupedTracking.push(record);
        writeJsonAtomic(trackingPath, dedupedTracking);
        hookOutput('SubagentStart', context);
        return;
      }
    }
  }

  // Dedup: remove existing entry with same ID (handles retries)
  const dedupedTracking = tracking.filter(a => a.agent_id !== agentId);
  dedupedTracking.push(record);
  writeJsonAtomic(trackingPath, dedupedTracking);

  if (quiet < 2) {
    let context = `[oh-my-link] ${role} agent started (${agentId}).`;
    if (phaseAdvanced) context += ` Phase → ${session!.current_phase}`;
    // Append MCP guidance for this role
    const mcpGuidance = getMcpGuidanceForAgent(role, cwd);
    if (mcpGuidance) context += '\n' + mcpGuidance;
    // Append memory context
    if (memoryBlock) context += memoryBlock;
    hookOutput('SubagentStart', context);
  } else {
    hookOutput('SubagentStart');
  }
}

async function handleStop(input: HookInput, cwd: string): Promise<void> {
  const agentId = input.agent_id || (input as any).agentId || (input as any).id || '';
  const exitCode = input.exit_code ?? (input as any).exitCode ?? 0;
  const quiet = getQuietLevel();

  debugLog(cwd, 'agent-stop', `id=${agentId} exit=${exitCode}`);

  // Update tracking record
  const trackingPath = getSubagentTrackingPath(cwd);
  const tracking = readJson<SubagentRecord[]>(trackingPath) || [];
  const record = tracking.find(r => r.agent_id === agentId && r.status === 'running');

  if (record) {
    record.stopped_at = new Date().toISOString();
    record.status = 'stopped';

    // Auto-release all file locks held by this agent
    const released = releaseAllLocks(cwd, agentId);

    // Worker task status: only mark failed on non-zero exit.
    // Tasks are NOT auto-completed (done) — the Reviewer/Master must approve.
    // This preserves the review gate architecture.
    if (record.link_id && isWorkerRole(record.role) && exitCode !== 0) {
      updateTaskStatus(cwd, record.link_id, 'failed',
        `Failed with exit code ${exitCode}.`
      );
    }

    writeJsonAtomic(trackingPath, tracking);

    // ── AUTO PHASE ADVANCEMENT ON STOP ──
    // When the master agent stops after P7, auto-mark session as complete.
    // When a reviewer stops, advance to next review phase if applicable.
    const sessionPath = getSessionPath(cwd);
    const session = readJson<SessionState>(sessionPath);

    if (session?.active) {
      let sessionDirty = false;

      // Master stop at phase_7_summary → complete
      if (record.role === 'master' && session.current_phase === 'phase_7_summary' && exitCode === 0) {
        session.current_phase = 'complete';
        session.active = false;
        session.session_ended_at = new Date().toISOString();
        session.deactivated_reason = 'completed';
        sessionDirty = true;
      }

      // Start Fast: fast-scout stops with exit=0 → advance to light_execution
      // Without this, phase stays at light_scout and all subsequent agents
      // are inferred as fast-scout instead of worker.
      if (session.mode === 'mylight' && record.role === 'fast-scout' && exitCode === 0
          && session.current_phase === 'light_scout') {
        session.current_phase = 'light_execution';
        session.last_checked_at = new Date().toISOString();
        sessionDirty = true;
        debugLog(cwd, 'agent-stop', 'fast-scout done → phase light_execution');
      }

      // ── Start Link: HITL Gate transitions ──
      // Without these, the orchestrator presents Gate questions to the user but
      // session.awaiting_confirmation stays false, so stop-handler spins
      // reinforcement messages instead of allowing stop. The user sees the bug as
      // "Stop hook error: Reinforcement N/50" looping while waiting to type.
      if (session.mode === 'mylink' && exitCode === 0) {
        const contextMd = path.join(cwd, '.oh-my-link', 'plans', 'CONTEXT.md');
        const planMd = path.join(cwd, '.oh-my-link', 'plans', 'plan.md');

        // Scout: Exploration mode (questions asked, no CONTEXT.md yet) → Gate 1
        if (record.role === 'scout' && session.current_phase === 'phase_1_scout'
            && !fs.existsSync(contextMd)) {
          session.current_phase = 'gate_1_pending';
          session.awaiting_confirmation = true;
          session.last_checked_at = new Date().toISOString();
          sessionDirty = true;
          debugLog(cwd, 'agent-stop', 'scout exploration → gate_1_pending awaiting user');
        }
        // Scout: Synthesis mode (CONTEXT.md produced after Gate 1) → advance to P2
        else if (record.role === 'scout' && session.current_phase === 'gate_1_pending'
            && fs.existsSync(contextMd)) {
          session.current_phase = 'phase_2_planning';
          session.awaiting_confirmation = false;
          session.last_checked_at = new Date().toISOString();
          sessionDirty = true;
          debugLog(cwd, 'agent-stop', 'scout synthesis → phase_2_planning');
        }

        // Architect: planning done (plan.md produced) → Gate 2
        if (record.role === 'architect' && session.current_phase === 'phase_2_planning'
            && fs.existsSync(planMd)) {
          session.current_phase = 'gate_2_pending';
          session.awaiting_confirmation = true;
          session.last_checked_at = new Date().toISOString();
          sessionDirty = true;
          debugLog(cwd, 'agent-stop', 'architect planning → gate_2_pending awaiting user');
        }

        // Verifier: validation done → Gate 3 (sequential vs parallel choice)
        if (record.role === 'verifier' && session.current_phase === 'phase_4_validation') {
          session.current_phase = 'gate_3_pending';
          session.awaiting_confirmation = true;
          session.last_checked_at = new Date().toISOString();
          sessionDirty = true;
          debugLog(cwd, 'agent-stop', 'verifier done → gate_3_pending awaiting user');
        }
      }

      // ── Review→Fix loop ──
      // Reviewer FAIL verdict at phase_6_review → regress to phase_5_execution
      // so Master can re-spawn Workers. Circuit-break at MAX_REVISIONS.
      // PASS / MINOR fall through to the advance-to-6.5 block below.
      let reviewFailedHandled = false;
      if (session.mode === 'mylink' && exitCode === 0
          && REVIEW_ROLES.includes(record.role)
          && session.current_phase === 'phase_6_review') {
        const verdict = readLatestReviewVerdict(cwd);
        if (verdict === 'FAIL') {
          session.revision_count = (session.revision_count || 0) + 1;
          session.last_checked_at = new Date().toISOString();
          if (session.revision_count >= MAX_REVISIONS) {
            // Circuit breaker: hand control back to user to decide retry vs abort.
            session.awaiting_confirmation = true;
            debugLog(cwd, 'agent-stop',
              `review FAIL — revisions exhausted (${session.revision_count}/${MAX_REVISIONS}) → awaiting user`);
          } else {
            // Regress phase so Master sees execution state and re-spawns Worker.
            session.current_phase = 'phase_5_execution';
            debugLog(cwd, 'agent-stop',
              `review FAIL — regress phase_6 → phase_5 (revision ${session.revision_count}/${MAX_REVISIONS})`);
          }
          sessionDirty = true;
          reviewFailedHandled = true;
        }
      }

      // Reviewer stop at phase_6_review → advance to phase_6_5_full_review if applicable
      if (!reviewFailedHandled
          && (record.role === 'reviewer' || record.role === 'code-reviewer' || record.role === 'security-reviewer')
          && session.current_phase === 'phase_6_review' && exitCode === 0) {
        // Only advance to 6.5 if all per-task reviews done (no running reviewers)
        const stillRunning = tracking.filter(a => a.status === 'running' && a.agent_id !== agentId
          && ['reviewer', 'code-reviewer', 'security-reviewer'].includes(a.role));
        if (stillRunning.length === 0) {
          session.current_phase = 'phase_6_5_full_review';
          session.last_checked_at = new Date().toISOString();
          sessionDirty = true;
        }
      }

      // Start Fast: executor/worker stops with exit=0 in execution phase → mark light_complete
      if (session.mode === 'mylight'
          && isWorkerRole(record.role) && exitCode === 0
          && ['light_execution', 'light_turbo'].includes(session.current_phase)) {
        session.current_phase = 'light_complete';
        session.active = false;
        session.session_ended_at = new Date().toISOString();
        session.deactivated_reason = 'completed';
        sessionDirty = true;
      }

      // General completion detection: all tasks done, no running agents
      if (!sessionDirty && detectCompletion(cwd, session, tracking)) {
        debugLog(cwd, 'agent-stop', 'completion detected → session ending');
        const completionPhase = session.mode === 'mylight' ? 'light_complete' as Phase : 'complete' as Phase;
        session.current_phase = completionPhase;
        session.active = false;
        session.session_ended_at = new Date().toISOString();
        session.deactivated_reason = 'all_tasks_completed';
        sessionDirty = true;
      }

      if (sessionDirty) {
        debugLog(cwd, 'agent-stop', `phase-change → ${session.current_phase} reason=${session.deactivated_reason || 'advance'}`);
        try { writeJsonAtomic(sessionPath, session); } catch { /* best effort */ }
      }
    }

    // --- Deliverable verification ---
    const role = record.role;
    const expectations = ROLE_EXPECTATIONS[role];
    if (expectations && expectations.artifacts.length > 0) {
      const artifactsDir = path.join(cwd, '.oh-my-link');
      const plansDir = path.join(artifactsDir, 'plans');
      const missing: string[] = [];

      for (const artifact of expectations.artifacts) {
        // Check in plans dir (primary), artifacts dir, and cwd root
        const inPlans = path.join(plansDir, artifact);
        const inArtifacts = path.join(artifactsDir, artifact);
        const inCwd = path.join(cwd, artifact);
        if (!fs.existsSync(inPlans) && !fs.existsSync(inArtifacts) && !fs.existsSync(inCwd)) {
          missing.push(artifact);
        }
      }

      if (missing.length > 0) {
        const level = expectations.required ? 'WARNING' : 'NOTE';
        const msg = `[${level}] ${role} agent stopped without producing: ${missing.join(', ')}. ${expectations.description}`;
        logError('subagent-lifecycle', msg);

        // Record in session for visibility
        const sessionPath = getSessionPath(cwd);
        const session = readJson<SessionState>(sessionPath);
        if (session) {
          const deliveryIssues = (session as any).delivery_issues || [];
          deliveryIssues.push({
            role,
            agent_id: agentId,
            missing,
            required: expectations.required,
            timestamp: new Date().toISOString(),
          });
          (session as any).delivery_issues = deliveryIssues;
          writeJsonAtomic(sessionPath, session);
        }
      }
    }

    if (quiet < 2) {
      const parts: string[] = [];
      parts.push(`[oh-my-link] ${record.role} agent stopped.`);
      if (released > 0) parts.push(`Released ${released} file lock(s).`);
      if (record.link_id) {
        if (exitCode !== 0) {
          parts.push(`Task ${record.link_id}: failed.`);
        } else {
          parts.push(`Task ${record.link_id}: awaiting review.`);
        }
      }
      simpleOutput(parts.join(' '));
    } else {
      simpleOutput();
    }
  } else {
    simpleOutput();
  }
}

function detectRole(agentType: string, description: string): string {
  // ── 1. Explicit env override (highest priority) ──
  const envRole = process.env.OML_AGENT_ROLE;
  if (envRole) return envRole.toLowerCase().replace(/_/g, '-');

  // ── 1b. OML:role tag in description (imperative prompt embeds this) ──
  // Matches "[OML:fast-scout]", "OML:executor", etc. anywhere in description
  const descLC = description.toLowerCase();
  const omlTagMatch = descLC.match(/\[?oml:([a-z][a-z0-9-]*)\]?/);
  if (omlTagMatch) {
    const tagRole = omlTagMatch[1];
    const knownRolesAll = [
      'fast-scout', 'code-reviewer', 'security-reviewer', 'test-engineer',
      'scout', 'architect', 'worker', 'reviewer', 'executor',
      'explorer', 'verifier', 'master',
    ];
    if (knownRolesAll.includes(tagRole)) return tagRole;
  }

  // ── 2. Structured agent_type (from Claude Code SubagentStart payload) ──
  const typeLC = agentType.toLowerCase().replace(/_/g, '-');

  // Exact match: "oh-my-link:scout", "oh-my-link:worker", etc.
  const roleMap: Record<string, string> = {
    'oh-my-link:master': 'master',
    'oh-my-link:scout': 'scout',
    'oh-my-link:fast-scout': 'fast-scout',
    'oh-my-link:architect': 'architect',
    'oh-my-link:worker': 'worker',
    'oh-my-link:reviewer': 'reviewer',
    'oh-my-link:explorer': 'explorer',
    'oh-my-link:executor': 'executor',
    'oh-my-link:verifier': 'verifier',
    'oh-my-link:code-reviewer': 'code-reviewer',
    'oh-my-link:security-reviewer': 'security-reviewer',
    'oh-my-link:test-engineer': 'test-engineer',
  };
  if (roleMap[typeLC]) return roleMap[typeLC];

  // Strip prefix if present (e.g. "oh-my-link:scout" → "scout")
  const stripped = typeLC.includes(':') ? typeLC.split(':').pop()! : typeLC;

  // Known role names (bare or after prefix stripping)
  const knownRoles = [
    'fast-scout', 'code-reviewer', 'security-reviewer', 'test-engineer',
    'scout', 'architect', 'worker', 'reviewer', 'executor',
    'explorer', 'verifier', 'master',
  ];
  for (const r of knownRoles) {
    if (stripped === r || stripped.includes(r)) return r;
  }

  // Claude Code built-in agent types (mapped to OML roles)
  // Handles both bare names and suffixed variants (e.g. "general-purpose")
  const builtinMap: Record<string, string> = {
    'explore': 'explorer',
    'explorer': 'explorer',
    'general': 'worker',           // Claude's "general" agent is typically doing work
    'general-purpose': 'worker',   // Claude may send "general-purpose" as agent_type
    'fixer': 'worker',             // Claude's fixer agent does implementation
    'oracle': 'reviewer',          // Oracle is advisory/review
    'designer': 'worker',
    'council': 'reviewer',
    'librarian': 'explorer',
  };
  if (builtinMap[stripped]) return builtinMap[stripped];

  // Prefix match for Claude agent types with suffixes (e.g. "general-purpose-v2")
  for (const [prefix, role] of Object.entries(builtinMap)) {
    if (stripped.startsWith(prefix)) return role;
  }

  // ── 3. Keyword scan in description text ──
  // Ordered: longer/more-specific names first to avoid partial matches
  const keywords: Array<[string, string]> = [
    ['fast-scout', 'fast-scout'],
    ['fast scout', 'fast-scout'],
    ['code-reviewer', 'code-reviewer'],
    ['code reviewer', 'code-reviewer'],
    ['security-reviewer', 'security-reviewer'],
    ['security reviewer', 'security-reviewer'],
    ['test-engineer', 'test-engineer'],
    ['test engineer', 'test-engineer'],
    ['worker', 'worker'],
    ['scout', 'scout'],
    ['architect', 'architect'],
    ['reviewer', 'reviewer'],
    ['executor', 'executor'],
    ['explorer', 'explorer'],
    ['verifier', 'verifier'],
    ['master', 'master'],
    // Action-based hints from Claude's Task tool descriptions
    ['implement', 'worker'],
    ['fix ', 'worker'],
    ['review', 'reviewer'],
    ['analyze', 'scout'],
    ['explore', 'explorer'],
    ['search', 'explorer'],
    ['plan', 'architect'],
    ['design', 'architect'],
    ['test', 'test-engineer'],
    ['verify', 'verifier'],
    ['audit', 'security-reviewer'],
  ];
  for (const [keyword, role] of keywords) {
    if (descLC.includes(keyword)) return role;
  }

  return 'unknown';
}

function isWorkerRole(role: string): boolean {
  return ['worker', 'executor'].includes(role);
}

/**
 * Infer the expected agent role from the current session phase.
 * Used when Claude Code's SubagentStart payload lacks description/prompt,
 * making tag-based or keyword-based detection impossible.
 *
 * Logic: at each phase in the pipeline, there's exactly ONE expected next agent role.
 * This mapping is deterministic and follows the OML workflow spec.
 */
function inferRoleFromSession(session: SessionState): string | null {
  // Use locked fields (set at session creation, immune to LLM overwriting)
  // Fall back to current fields for backwards compatibility
  const mode = session.locked_mode || session.mode;
  const phase = session.locked_phase || session.current_phase;

  if (mode === 'mylight') {
    switch (phase) {
      case 'light_scout':
        // First agent in standard Start Fast → fast-scout
        return session.intent === 'turbo' ? 'executor' : 'fast-scout';
      case 'light_turbo':
        // Turbo mode execution
        return 'executor';
      case 'light_execution':
        // Already in execution — could be executor or worker
        return 'executor';
      default:
        return null;
    }
  }

  if (mode === 'mylink') {
    switch (phase) {
      case 'bootstrap':
        return 'scout';
      case 'phase_1_scout':
        return 'scout'; // still scouting
      case 'gate_1_pending':
      case 'phase_2_planning':
        return 'architect';
      case 'gate_2_pending':
      case 'phase_3_decomposition':
        return 'architect';
      case 'phase_4_validation':
        return 'verifier';
      case 'gate_3_pending':
      case 'phase_5_execution':
        return 'worker';
      case 'phase_6_review':
      case 'phase_6_5_full_review':
        return 'reviewer';
      case 'phase_7_summary':
        return 'master';
      default:
        return null;
    }
  }

  return null;
}

function findAssignedTask(cwd: string, agentId: string, description: string): TaskAssignment | null {
  const allTasks = listTasks(cwd);

  // Strategy 1: Look for task assigned to this agent
  const assigned = allTasks.find(t => t.assigned_to === agentId && t.status === 'pending');
  if (assigned) return assigned;

  // Strategy 2: Extract link ID from agent description
  const linkMatch = description.match(/link[- ]?(\S+)/i);
  if (linkMatch) {
    const linkId = linkMatch[1];
    const task = readTask(cwd, linkId);
    if (task && task.status === 'pending') return task;
  }

  // No auto-claim — Master must pre-assign tasks
  return null;
}

// Run
main().catch((err) => {
  logError('subagent-lifecycle', `Error: ${err}`);
  simpleOutput();
});
