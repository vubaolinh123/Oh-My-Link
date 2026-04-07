import * as fs from 'fs';
import * as path from 'path';
import { parseHookInput, simpleOutput, readJson, writeJsonAtomic, getCwd, isCriticalPhase, debugLog } from '../helpers';
import { getSessionPath, getProjectStateRoot, normalizePath } from '../state';
import { SessionState, HookInput } from '../types';
import { cleanExpiredLocks } from '../task-engine';

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
      // Critical phase: keep active but still record that the Claude session ended
      session.session_ended_at = now;
    }
    try { writeJsonAtomic(getSessionPath(cwd), session); } catch { /* ignore */ }
  }

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

  simpleOutput();
}

main().catch(() => simpleOutput());
