import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, hookOutput, readJson, writeJsonAtomic, getCwd, debugLog } from '../helpers';
import { getSessionPath, getCheckpointPath, getHandoffsDir,
         getProjectMemoryPath, getSubagentTrackingPath, getToolTrackingPath,
         ensureDir, normalizePath } from '../state';
import { SessionState, ProjectMemory, HookInput, SubagentRecord } from '../types';
import { listTasks } from '../task-engine';
import { formatSummary, loadMemory } from '../project-memory';

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const cwd = getCwd(input as Record<string, unknown>);
  const session = readJson<SessionState>(getSessionPath(cwd));

  if (!session?.active) { hookOutput('PreCompact'); return; }

  const phase = session.current_phase || 'unknown';
  const feature = session.feature_slug || 'unknown';
  const now = new Date().toISOString();

  // Read tool tracking and subagent tracking for enriched checkpoint
  const tracking = readJson<Record<string, unknown>>(getToolTrackingPath(cwd)) || {};
  const subagentList = readJson<SubagentRecord[]>(getSubagentTrackingPath(cwd)) || [];

  const activeSubagents = subagentList
    .filter(a => a.status === 'running')
    .map(a => ({ agent_id: a.agent_id, role: a.role, started_at: a.started_at }));

  // 1. Write enriched checkpoint
  const checkpoint: Record<string, unknown> = {
    checkpointed_at: now,
    session: { ...session },
    active_tasks: listTasks(cwd, 'in_progress'),
    tool_tracking: {
      files_modified: (tracking as any).files_modified || [],
      tool_count: (tracking as any).tool_count || 0,
      failure_count: Array.isArray((tracking as any).failures) ? (tracking as any).failures.length : 0,
    },
    active_agents: activeSubagents,
    reason: 'pre_compaction',
    trigger: 'pre_compact',
    created_at: now,
  };

  // Include worker prompt file path during execution phase
  if (phase === 'phase_5_execution') {
    const activeWorker = activeSubagents.find(a => a.role === 'worker');
    if (activeWorker) {
      checkpoint.worker_prompt_file = `.oh-my-link/plans/worker-${activeWorker.agent_id}.md`;
    }
    // Also scan plans directory for the most recent worker prompt file
    try {
      const plansDir = normalizePath(path.join(cwd, '.oh-my-link', 'plans'));
      if (fs.existsSync(plansDir)) {
        const workerFiles = fs.readdirSync(plansDir)
          .filter(f => f.startsWith('worker-') && f.endsWith('.md'))
          .sort()
          .reverse();
        if (workerFiles.length > 0 && !checkpoint.worker_prompt_file) {
          checkpoint.worker_prompt_file = `.oh-my-link/plans/${workerFiles[0]}`;
        }
      }
    } catch { /* best effort */ }
  }

  try { writeJsonAtomic(getCheckpointPath(cwd), checkpoint); } catch { /* ignore */ }

  // 2. Create enriched handoff document
  const handoffDir = getHandoffsDir(cwd);
  ensureDir(handoffDir);
  const handoffPath = normalizePath(
    path.join(handoffDir, `pre-compact-${Date.now()}.md`)
  );
  const filesModified = (tracking as any).files_modified || [];

  debugLog(cwd, 'pre-compact', `phase=${phase} files_modified=${filesModified.length}`);
  const handoff = [
    `## Handoff: Pre-Compaction Checkpoint`,
    ``,
    `**Phase:** ${phase}`,
    `**Feature:** ${feature}`,
    `**Checkpointed at:** ${now}`,
    `**Reinforcements:** ${session.reinforcement_count || 0}`,
    `**Failures:** ${session.failure_count || 0}`,
    ``,
    `### Files Modified`,
    filesModified.length > 0
      ? filesModified.map((f: string) => `- ${f}`).join('\n')
      : '- (none yet)',
    ``,
    `### Active Subagents`,
    activeSubagents.length > 0
      ? activeSubagents.map(a => `- ${a.role} (${a.agent_id}), started ${a.started_at}`).join('\n')
      : '- (none)',
    ``,
    `### Resume Instructions`,
    `1. Read this handoff to understand where work left off`,
    `2. Check session.json for current phase`,
    `3. Check task engine for next ready work`,
    `4. If subagents were active, they may need to be re-spawned`,
    ``,
  ].join('\n');
  try { fs.writeFileSync(handoffPath, handoff, 'utf-8'); } catch { /* ignore */ }

  // Cleanup old handoffs — keep only the last 10
  try {
    const allHandoffs = fs.readdirSync(handoffDir)
      .filter(f => f.endsWith('.md'))
      .sort();
    if (allHandoffs.length > 10) {
      for (const old of allHandoffs.slice(0, allHandoffs.length - 10)) {
        try { fs.unlinkSync(path.join(handoffDir, old)); } catch { /* best effort */ }
      }
    }
  } catch { /* best effort */ }

  // 3. Update session state
  session.last_checked_at = now;
  try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* ignore */ }

  // 4. Build systemMessage for re-injection after compaction
  const mode = session.mode || 'mylink';
  const modeLabel = mode === 'mylight' ? 'Start Fast' : 'Start Link';
  const systemParts: string[] = [
    `[oh-my-link POST-COMPACTION CONTEXT]`,
    `Mode: ${modeLabel} | Phase: ${phase} | Feature: ${feature}`,
    `Reinforcements: ${session.reinforcement_count || 0} | Failures: ${session.failure_count || 0}`,
  ];
  if (filesModified.length > 0) {
    systemParts.push(`Files modified: ${filesModified.join(', ')}`);
  }
  if (activeSubagents.length > 0) {
    systemParts.push(`Active subagents: ${activeSubagents.map(a => a.role).join(', ')}`);
  }
  systemParts.push('');
  systemParts.push(`Resume: Read session state and handoffs for full context.`);
  if (mode === 'mylink') {
    systemParts.push(`Check task engine for next ready work.`);
  } else {
    systemParts.push(`Continue the Start Fast workflow.`);
  }
  if (checkpoint.worker_prompt_file) {
    systemParts.push(`Worker prompt file: ${checkpoint.worker_prompt_file} — re-read to recover assignment.`);
  }

  // Append project memory summary so it survives compaction
  try {
    const memory = loadMemory(cwd);
    const memorySummary = formatSummary(memory);
    if (memorySummary) {
      systemParts.push('');
      systemParts.push(`# Project Memory (Post-Compaction Recovery)`);
      systemParts.push(memorySummary);
    }
  } catch { /* best effort */ }

  const systemMessage = systemParts.filter(Boolean).join('\n');

  // 5. Emit context
  const additionalContext = [
    `[oh-my-link] Pre-compaction checkpoint saved.`,
    `Phase: ${phase} | Feature: ${feature}`,
    `Files modified: ${filesModified.length} | Active subagents: ${activeSubagents.length}`,
    `Handoff written. After compaction, read the handoff to resume.`,
  ].join('\n');

  hookOutput('PreCompact', additionalContext, systemMessage);
}

main().catch(() => hookOutput('PreCompact'));
