import * as fs from 'fs';
import * as path from 'path';
import {
  parseHookInput,
  readJson,
  writeJsonAtomic,
  getCwd,
  getQuietLevel,
  stopOutput,
  isTerminalPhase,
  getElapsed,
  logError,
  debugLog,
} from '../helpers';
import {
  getSessionPath,
  getCancelSignalPath,
  getCheckpointPath,
  getSubagentTrackingPath,
  getToolTrackingPath,
  getProjectStateRoot,
  normalizePath,
} from '../state';
import { SessionState, HookInput, SubagentRecord } from '../types';
import { listTasks } from '../task-engine';

// ============================================================
// Oh-My-Link — Unified Stop Handler (Stop)
// ============================================================

const MAX_REINFORCEMENTS = 50;   // Circuit breaker
const STALENESS_MS = 2 * 60 * 60 * 1000; // 2 hours
const CANCEL_TTL_MS = 30 * 1000; // 30 second cancel signal window
const CONTEXT_PRESSURE_THRESHOLD = 0.85;

/** Detailed phase continuation guidance — maps phase to specific next-step instruction */
const PHASE_CONTINUATIONS: Record<string, string> = {
  // Start Link phases (7-step workflow)
  bootstrap:               'Continue to Phase 1: Spawn Scout for requirements exploration.',
  phase_0_memory:          'Continue Phase 0: Load institutional memory and project context.',
  phase_1_scout:           'Continue Phase 1: Scout is clarifying requirements. Wait for CONTEXT.md.',
  gate_1_pending:          'HITL Gate 1: Present locked decisions to user for approval.',
  phase_2_planning:        'Continue Phase 2: Architect is drafting the implementation plan. Persist plan after Gate 2 approval.',
  gate_2_pending:          'HITL Gate 2: Present plan to user for approval or feedback.',
  phase_3_decomposition:   'Continue Phase 3: Architect is decomposing plan into tasks for current phase.',
  phase_4_validation:      'Continue Phase 4: Validating task descriptions and dependencies.',
  gate_3_pending:          'HITL Gate 3: Ask user to choose Sequential or Parallel execution.',
  phase_5_execution:       'Continue Phase 5: Workers are implementing tasks. Check for next ready task.',
  phase_6_review:          'Continue Phase 6: Reviewer is verifying task implementation.',
  phase_6_5_full_review:   'Continue Phase 6.5: Full review with specialist agents. Check for P1 findings.',
  phase_7_summary:         'Continue Phase 7: Generate final summary, write WRAP-UP.md, update learnings.',
  // Start Fast phases (lightweight workflow)
  light_scout:             'Continue Start Fast: Scout is analyzing the issue. Wait for analysis summary.',
  light_turbo:             'Continue Start Fast Turbo: Executor is implementing the fix directly. Wait for completion.',
  light_execution:         'Continue Start Fast: Executor is implementing the fix. Wait for completion.',
  // Legacy Mr.Fast phase names (for compatibility)
  fast_bootstrap:          'Continue Start Fast: Spawn Fast Scout for rapid analysis.',
  fast_scout:              'Continue Start Fast: Scout is analyzing the issue. Wait for analysis summary.',
  fast_turbo:              'Continue Start Fast Turbo: Executor is implementing the fix directly. Wait for completion.',
  fast_execution:          'Continue Start Fast: Executor is implementing the fix. Wait for completion.',
};

/**
 * Detect context pressure by reading the tail of the transcript file.
 * Looks for context_window and input_tokens fields to estimate usage ratio.
 * Returns null if transcript is unavailable or fields not found.
 */
function detectContextPressure(transcriptPath: string | null): number | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const stats = fs.fstatSync(fd);
    const readSize = Math.min(stats.size, 8192);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
    fs.closeSync(fd);

    const tail = buffer.toString('utf8');
    const contextMatch = tail.match(/"context_window"\s*:\s*(\d+)/);
    const inputMatch = tail.match(/"input_tokens"\s*:\s*(\d+)/);

    if (contextMatch && inputMatch) {
      const contextWindow = parseInt(contextMatch[1], 10);
      const inputTokens = parseInt(inputMatch[1], 10);
      if (contextWindow > 0) {
        return inputTokens / contextWindow;
      }
    }
  } catch { /* best effort */ }

  return null;
}

/**
 * Write a handoff markdown file for session resumption.
 */
function writeHandoff(cwd: string, session: SessionState, trigger: string): void {
  try {
    const handoffsDir = path.join(getProjectStateRoot(cwd), 'handoffs');
    if (!fs.existsSync(handoffsDir)) fs.mkdirSync(handoffsDir, { recursive: true });
    const handoffPath = normalizePath(path.join(handoffsDir, `${trigger}-${Date.now()}.md`));
    const content = [
      `## Handoff: ${trigger}`,
      ``,
      `**Phase:** ${session.current_phase}`,
      `**Feature:** ${session.feature_slug || 'unknown'}`,
      `**Time:** ${new Date().toISOString()}`,
      `**Reinforcements:** ${session.reinforcement_count || 0}`,
      ``,
      `### Resume Instructions`,
      `1. Read session state for current phase`,
      `2. Check task engine for next ready work`,
      `3. Continue from the phase indicated above`,
    ].join('\n');
    fs.writeFileSync(handoffPath, content, 'utf-8');
  } catch { /* best effort */ }
}

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const cwd = getCwd(input as Record<string, unknown>);

  // Read session state
  const session = readJson<SessionState>(getSessionPath(cwd));

  debugLog(cwd, 'stop', `phase=${session?.current_phase || 'none'} active=${session?.active}`);

  // 1. No active session → allow stop
  if (!session?.active) {
    debugLog(cwd, 'stop', 'ALLOW: no-session');
    stopOutput('allow');
    return;
  }

  // 2. Terminal phase → allow stop
  if (isTerminalPhase(session.current_phase)) {
    stopOutput('allow');
    return;
  }

  // 2b. Idle phases → allow stop (no work in progress yet)
  // Note: 'bootstrap' is NOT idle — it's the first phase of the pipeline
  // BUT: phase_7_summary should allow stop (final summary phase, no critical data loss)
  const idlePhases = ['idle'];
  const nearTerminalPhases = ['phase_7_summary'];
  if (idlePhases.includes(session.current_phase)) {
    stopOutput('allow');
    return;
  }
  if (nearTerminalPhases.includes(session.current_phase)) {
    // P7 is summary-only — safe to stop; mark complete
    session.current_phase = 'complete' as any;
    session.active = false;
    session.session_ended_at = new Date().toISOString();
    session.deactivated_reason = 'completed_at_summary';
    try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* best effort */ }
    stopOutput('allow', 'Phase 7 summary — session complete.');
    return;
  }

  // 3. Context pressure → write checkpoint & allow stop
  const transcriptPath = (input as Record<string, unknown>).transcript_path as string
    ?? (input as Record<string, unknown>).transcriptPath as string
    ?? null;
  const contextUsage = detectContextPressure(transcriptPath);

  if (contextUsage !== null && contextUsage >= CONTEXT_PRESSURE_THRESHOLD) {
    // Write enriched checkpoint before allowing context-pressure stop
    try {
      const tracking = readJson<Record<string, unknown>>(getToolTrackingPath(cwd)) || {};
      const subagents = readJson<SubagentRecord[]>(getSubagentTrackingPath(cwd)) || [];

      const checkpoint = {
        session: { ...session },
        active_tasks: listTasks(cwd, 'in_progress'),
        tool_tracking: {
          files_modified: (tracking as any).files_modified || [],
          tool_count: (tracking as any).tool_count || 0,
        },
        active_agents: subagents
          .filter(a => a.status === 'running')
          .map(a => ({ agent_id: a.agent_id, role: a.role, started_at: a.started_at })),
        created_at: new Date().toISOString(),
        trigger: 'context_pressure' as const,
      };
      writeJsonAtomic(getCheckpointPath(cwd), checkpoint);
    } catch { /* best effort — don't block stop */ }

    writeHandoff(cwd, session, 'context_pressure');

    // Update session state
    session.last_checked_at = new Date().toISOString();
    session.context_limit_stop = true;
    try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* best effort */ }

    stopOutput('allow', 'Context pressure detected — checkpoint saved.');
    return;
  }

  // 4. Cancel signal or session cancel_requested → allow stop
  if (session.cancel_requested) {
    session.active = false;
    session.cancelled_at = new Date().toISOString();
    session.current_phase = 'cancelled';
    try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* best effort */ }
    stopOutput('allow', 'Session cancelled by user (cancel_requested flag).');
    return;
  }

  const cancelPath = getCancelSignalPath(cwd);
  if (fs.existsSync(cancelPath)) {
    try {
      const signal = readJson<{ cancelled_at?: string; expires_at?: string; timestamp?: string }>(cancelPath);
      if (signal) {
        // Check expires_at field (written by keyword-detector cancel action)
        if (signal.expires_at) {
          const expiresAt = new Date(signal.expires_at).getTime();
          if (!isNaN(expiresAt) && Date.now() < expiresAt) {
            // Valid cancel signal — not expired
            session.active = false;
            session.cancelled_at = new Date().toISOString();
            session.current_phase = 'cancelled';
            try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* best effort */ }
            try { fs.unlinkSync(cancelPath); } catch { /* best effort */ }
            stopOutput('allow', 'Session cancelled by user.');
            return;
          }
        }
        // Legacy fallback: check timestamp field
        if (signal.timestamp || signal.cancelled_at) {
          const ts = signal.timestamp || signal.cancelled_at;
          const age = Date.now() - new Date(ts!).getTime();
          if (isNaN(age) || age < CANCEL_TTL_MS) {
            session.active = false;
            session.cancelled_at = new Date().toISOString();
            session.current_phase = 'cancelled';
            try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* best effort */ }
            try { fs.unlinkSync(cancelPath); } catch { /* best effort */ }
            stopOutput('allow', 'Session cancelled by user.');
            return;
          }
        }
        // Stale cancel signal — clean up
        try { fs.unlinkSync(cancelPath); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  // 5. Awaiting confirmation → allow stop (at HITL gate)
  // At gates, Claude should stop its turn so the user can type their answer.
  // Provide a clear message so the user knows the system is waiting.
  if (session.awaiting_confirmation) {
    const gateMessages: Record<string, string> = {
      gate_1_pending: 'Waiting for your answers to the Scout questions above.',
      gate_2_pending: 'Waiting for your approval of the implementation plan.',
      gate_3_pending: 'Waiting for your choice: Sequential or Parallel execution.',
    };
    const gateMsg = gateMessages[session.current_phase] || 'Waiting for your input.';
    debugLog(cwd, 'stop', `ALLOW: awaiting_confirmation at ${session.current_phase}`);
    stopOutput('allow', gateMsg);
    return;
  }

  // 6. Staleness check (>2h since last activity)
  const lastActivity = session.last_checked_at || session.started_at;
  const elapsed = Date.now() - new Date(lastActivity).getTime();
  if (elapsed > STALENESS_MS) {
    session.active = false;
    session.current_phase = 'cancelled';
    try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* best effort */ }
    stopOutput('allow', `Session stale (${getElapsed(lastActivity)} since last activity).`);
    return;
  }

  // 7. Circuit breaker (>50 reinforcements)
  if (session.reinforcement_count >= MAX_REINFORCEMENTS) {
    // Write checkpoint before circuit breaker stop
    try {
      const tracking = readJson<Record<string, unknown>>(getToolTrackingPath(cwd)) || {};
      const subagents = readJson<SubagentRecord[]>(getSubagentTrackingPath(cwd)) || [];
      const checkpoint = {
        session: { ...session },
        active_tasks: listTasks(cwd, 'in_progress'),
        tool_tracking: {
          files_modified: (tracking as any).files_modified || [],
          tool_count: (tracking as any).tool_count || 0,
        },
        active_agents: subagents
          .filter(a => a.status === 'running')
          .map(a => ({ agent_id: a.agent_id, role: a.role, started_at: a.started_at })),
        created_at: new Date().toISOString(),
        trigger: 'circuit_breaker',
      };
      writeJsonAtomic(getCheckpointPath(cwd), checkpoint);
    } catch { /* best effort */ }

    writeHandoff(cwd, session, 'circuit_breaker');

    session.active = false;
    session.current_phase = 'cancelled';
    writeJsonAtomic(getSessionPath(cwd), session);
    stopOutput('allow', `Circuit breaker: ${MAX_REINFORCEMENTS} reinforcements exceeded.`);
    return;
  }

  // --- BLOCK STOP ---
  // Increment reinforcement counter
  session.reinforcement_count = (session.reinforcement_count || 0) + 1;
  session.last_checked_at = new Date().toISOString();
  try {
    writeJsonAtomic(getSessionPath(cwd), session);
  } catch { /* ignore write failure — still block */ }

  // Build continuation guidance using PHASE_CONTINUATIONS map
  const phase = session.current_phase;
  const mode = session.mode === 'mylink' ? 'Start Link' : 'Start Fast';
  const modeLabel = session.mode === 'mylink' ? 'START LINK' : 'START FAST';
  const workflowDesc = session.mode === 'mylink'
    ? 'The 7-step workflow is active.'
    : 'The Start Fast workflow is active.';

  const continuation = PHASE_CONTINUATIONS[phase] || `Continue working on phase: ${phase}.`;
  const feature = session.feature_slug ? ` Feature: ${session.feature_slug}.` : '';

  debugLog(cwd, 'stop', `BLOCK: phase=${phase} reinforcement=${session.reinforcement_count}`);

  const quiet = getQuietLevel();
  let guidance = `[${modeLabel} — Phase: ${phase} | Reinforcement ${session.reinforcement_count}/${MAX_REINFORCEMENTS}] `;
  guidance += `${workflowDesc}${feature} ${continuation} `;
  guidance += `Do NOT stop until all phases complete. `;
  guidance += `When finished, set session active=false or say "cancel oml".`;

  stopOutput('block', guidance);
}

// Run
main().catch((err) => {
  logError('stop-handler', `Error: ${err}`);
  stopOutput('allow', 'Stop handler error — allowing stop.');
});
