import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, simpleOutput, readJson, writeJsonAtomic, getCwd, isCriticalPhase, debugLog, logMemoryUsage } from '../helpers';
import { getSessionPath, getProjectStateRoot, getCheckpointPath, getSubagentTrackingPath, getToolTrackingPath, normalizePath } from '../state';
import { SessionState, HookInput, SubagentRecord } from '../types';
import { cleanExpiredLocks, listTasks, failAllInProgressTasks, releaseAllLocks, listAllLocks } from '../task-engine';

// Critical phases where we must NOT deactivate (to allow resume)
const CRITICAL_PHASES = [
  'phase_5_execution',
  'phase_6_review',
  'phase_6_5_full_review',
  'light_execution',
  'light_turbo',
];

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const cwd = getCwd(input as Record<string, unknown>);
  logMemoryUsage(cwd, 'session-end:start');

  // Read session early for debug logging
  const session = readJson<SessionState>(getSessionPath(cwd));
  debugLog(cwd, 'session-end', `phase=${session?.current_phase || 'none'} active=${session?.active} critical=${session?.active ? CRITICAL_PHASES.includes(session.current_phase) : false}`);

  // Clean expired locks
  try { cleanExpiredLocks(cwd); } catch { /* ignore */ }

  // Deactivate session — but NOT if in a critical phase (allow resume)
  if (session?.active) {
    const now = new Date().toISOString();
    if (!CRITICAL_PHASES.includes(session.current_phase)) {
      session.active = false;
      session.session_ended_at = now;
      session.deactivated_reason = 'session_ended';
    } else {
      // Critical phase: Claude session ended mid-execution.
      // Keep active flag for potential resume, but snapshot state + fail orphan tasks.
      session.session_ended_at = now;

      // 1. Fail all in-progress tasks (they can't continue without Claude)
      const failedCount = failAllInProgressTasks(cwd, 'session_end: Claude session terminated mid-execution');
      debugLog(cwd, 'session-end', `failed ${failedCount} in-progress tasks`);

      // 2. Release all file locks (no agent can hold them after session dies)
      try {
        const allLocks = listAllLocks(cwd);
        for (const lock of allLocks) {
          releaseAllLocks(cwd, lock.holder);
        }
        debugLog(cwd, 'session-end', `released locks for ${allLocks.length} holders`);
      } catch { /* best effort */ }

      // 3. Write checkpoint for session resumption
      try {
        const tracking = readJson<Record<string, unknown>>(getToolTrackingPath(cwd)) || {};
        const subagents = readJson<SubagentRecord[]>(getSubagentTrackingPath(cwd)) || [];
        const checkpoint = {
          session: { ...session },
          active_tasks: listTasks(cwd, 'in_progress'), // should be 0 after failAll, but snapshot anyway
          failed_tasks_count: failedCount,
          tool_tracking: {
            files_modified: (tracking as any).files_modified || [],
            tool_count: (tracking as any).tool_count || 0,
          },
          active_agents: subagents
            .filter((a: SubagentRecord) => a.status === 'running')
            .map((a: SubagentRecord) => ({ agent_id: a.agent_id, role: a.role, started_at: a.started_at })),
          created_at: now,
          trigger: 'session_end_interrupted' as const,
        };
        writeJsonAtomic(getCheckpointPath(cwd), checkpoint);
        debugLog(cwd, 'session-end', 'checkpoint written for interrupted session');
      } catch (err) { debugLog(cwd, 'session-end', `checkpoint write failed: ${(err as Error)?.message}`); }

      // 4. Write handoff for next session
      try {
        const handoffsDir = path.join(getProjectStateRoot(cwd), 'handoffs');
        if (!fs.existsSync(handoffsDir)) fs.mkdirSync(handoffsDir, { recursive: true });
        const handoffPath = normalizePath(path.join(handoffsDir, `session_end_interrupted-${Date.now()}.md`));
        const content = [
          `## Handoff: session_end_interrupted`,
          ``,
          `**Phase:** ${session.current_phase}`,
          `**Time:** ${now}`,
          `**Failed tasks:** ${failedCount}`,
          ``,
          `### Resume Instructions`,
          `1. Read checkpoint.json for full state snapshot`,
          `2. Failed tasks need to be re-created or retried`,
          `3. Continue from phase: ${session.current_phase}`,
        ].join('\n');
        fs.writeFileSync(handoffPath, content, 'utf-8');
        // Cleanup old handoffs — keep only the last 10
        try {
          const allHandoffs = fs.readdirSync(handoffsDir).filter((f: string) => f.endsWith('.md')).sort();
          if (allHandoffs.length > 10) {
            for (const old of allHandoffs.slice(0, allHandoffs.length - 10)) {
              try { fs.unlinkSync(path.join(handoffsDir, old)); } catch { /* best effort */ }
            }
          }
        } catch { /* best effort */ }
      } catch { /* best effort */ }
    }
    try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* ignore */ }
  }

  // Entity learning from working-memory at session end (must run BEFORE consolidateSession clears it)
  try {
    const wmPath = require('../state').getWorkingMemoryPath(cwd);
    const wmContent = require('fs').existsSync(wmPath)
      ? require('fs').readFileSync(wmPath, 'utf-8').trim()
      : '';
    if (wmContent && wmContent.length > 100) {
      const { EntityRegistry: ER } = require('../memory/entity-registry') as {
        EntityRegistry: {
          load: (path: string) => {
            learnFromText: (text: string, minConf?: number) => Array<{ name: string; type: string }>;
            save: () => void;
          }
        }
      };
      const { getEntityRegistryPath: getERPath } = require('../state') as {
        getEntityRegistryPath: (cwd: string) => string;
      };
      const registry = ER.load(getERPath(cwd));
      const newEntities = registry.learnFromText(wmContent, 0.7);
      if (newEntities.length > 0) {
        debugLog(cwd, 'mem:entity-consolidate', `learned ${newEntities.length} entities at session end`);
      }
    }
  } catch (err) {
    debugLog(cwd, 'mem:entity-consolidate', `FAILED: ${(err as Error)?.message || err}`);
  }

  // KG fact consolidation — sync registry entities to KG nodes
  try {
    const { KnowledgeGraph: KG } = require('../memory/knowledge-graph') as {
      KnowledgeGraph: new (dbPath: string) => {
        addEntity: (name: string, type: string, props?: Record<string, string>) => string;
        close: () => void;
      }
    };
    const { EntityRegistry: ER } = require('../memory/entity-registry') as {
      EntityRegistry: {
        load: (path: string) => {
          people: Record<string, { relationship?: string }>;
          projects: string[];
        }
      }
    };
    const { getEntityRegistryPath: getERPath, getKnowledgeGraphPath: getKGPath } = require('../state') as {
      getEntityRegistryPath: (cwd: string) => string;
      getKnowledgeGraphPath: (cwd: string) => string;
    };
    const registry = ER.load(getERPath(cwd));
    const kg = new KG(getKGPath(cwd));

    // Ensure all known entities exist as KG nodes
    for (const [name, info] of Object.entries(registry.people)) {
      kg.addEntity(name, 'person', { relationship: info.relationship || '' });
    }
    for (const proj of registry.projects) {
      kg.addEntity(proj, 'project');
    }

    kg.close();
    debugLog(cwd, 'mem:kg-consolidate', 'KG entities synced from registry');
  } catch (err) {
    debugLog(cwd, 'mem:kg-consolidate', `FAILED: ${(err as Error)?.message || err}`);
  }

  // Consolidate working-memory into vector index before session ends
  try {
    const { consolidateSession } = require('../memory/memory-stack') as { consolidateSession: (cwd: string) => void };
    debugLog(cwd, 'mem:consolidate', 'starting session-end memory consolidation');
    consolidateSession(cwd);
    debugLog(cwd, 'mem:consolidate', 'memory consolidated to vector index');
  } catch (err) { debugLog(cwd, 'mem:consolidate', `FAILED: ${(err as Error)?.message || err}`); }

  // Clear transient state files (write markers instead of deleting for audit trail)
  const stateRoot = getProjectStateRoot(cwd);
  const transientFiles = ['tool-tracking.json', 'last-tool-error.json', 'injected-skills.json'];
  const clearMarker = JSON.stringify({ cleared_at: new Date().toISOString(), reason: 'session_end' }, null, 2);
  for (const file of transientFiles) {
    const filePath = normalizePath(path.join(stateRoot, file));
    try {
      if (fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, clearMarker, 'utf-8');
      }
    } catch { /* ignore */ }
  }

  logMemoryUsage(cwd, 'session-end:end');
  simpleOutput();
}

main().catch(() => simpleOutput());
