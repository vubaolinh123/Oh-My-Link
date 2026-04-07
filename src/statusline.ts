/**
 * Oh-My-Link HUD — "Magical Girl" statusline for Claude Code.
 *
 * Reads stdin JSON from Claude Code (context_window, model, cwd, etc.)
 * plus session state files to render a kawaii multi-line status line.
 *
 * Output examples:
 *   ╭─🌸 OML v0.1.0 ✧ 🪄 Start.Link ✧ ✨ Bootstrapping...
 *   ╰─🧠 Ctx: [♥♥♥♥♡♡♡♡♡♡] 42% ┊ ☕ Session: 9m ┊ 👯 Agents: MW ┊ 🎯 R:0 💦 F:0
 *
 *   ╭─🌸 OML v0.1.0 ✧ idle
 *   ╰─🧠 Ctx: [♥♥♥♡♡♡♡♡♡♡] 31%
 *
 * Zero dependencies beyond project modules. Never writes to stderr. Always exits 0.
 */

import * as path from 'path';
import { readJson } from './helpers';
import { getSessionPath, getProjectStateRoot, normalizePath, resolvePluginRoot } from './state';
import { SessionState, SubagentRecord } from './types';
import { getTaskSummary } from './task-engine';

// ── ANSI Colors ──────────────────────────────────────────────
const RESET   = '\x1b[0m';
const DIM     = '\x1b[2m';
const RED     = '\x1b[31m';
const GREEN   = '\x1b[32m';
const YELLOW  = '\x1b[33m';
const CYAN    = '\x1b[36m';
const MAGENTA = '\x1b[35m';

// ── Version ──────────────────────────────────────────────────
const VERSION = (() => {
  try {
    // Use centralized plugin root resolution (env → setup.json → __dirname)
    const pluginRoot = resolvePluginRoot();
    const pkgPath = pluginRoot
      ? path.join(pluginRoot, 'package.json')
      : path.resolve(__dirname, '..', 'package.json');
    const pkg = readJson<{ version: string }>(pkgPath);
    return pkg?.version || '0.1.0';
  } catch {
    return '0.1.0';
  }
})();

// ── Phase display mapping ────────────────────────────────────
const PHASE_DISPLAY: Record<string, string> = {
  bootstrap:              'Bootstrapping...',
  phase_0_memory:         'Phase 0: Memory',
  phase_1_scout:          'Phase 1: Exploration',
  gate_1_pending:         'Gate 1: Awaiting User',
  phase_2_planning:       'Phase 2: Planning',
  gate_2_pending:         'Gate 2: Awaiting User',
  phase_3_decomposition:  'Phase 3: Decomposition',
  phase_4_validation:     'Phase 4: Validation',
  gate_3_pending:         'Gate 3: Awaiting User',
  phase_5_execution:      'Phase 5: Execution',
  phase_6_review:         'Phase 6: Review',
  phase_6_5_full_review:  'Phase 6.5: Full Review',
  phase_7_summary:        'Phase 7: Summary',
  light_scout:            'Analyzing...',
  light_turbo:            'Turbo \u26A1',
  light_execution:        'Implementing...',
  light_complete:         'Complete \u2728',
  cancelled:              'Cancelled',
  complete:               'Complete \u2728',
};

// ── Context thresholds ───────────────────────────────────────
const CTX_WARNING  = 70;
const CTX_COMPRESS = 80;
const CTX_CRITICAL = 85;

// ── Agent role → short code ──────────────────────────────────
const AGENT_CODES: Record<string, string> = {
  master:              'M',
  scout:               'S',
  'fast-scout':        'F',
  architect:           'A',
  worker:              'W',
  reviewer:            'R',
  explorer:            'e',
  executor:            'x',
  verifier:            'V',
  'code-reviewer':     'CR',
  'security-reviewer': 'K',
  'test-engineer':     'T',
};

// ── Stdin JSON types (from Claude Code) ──────────────────────
interface StdinData {
  cwd?: string;
  context_window?: {
    used_percentage?: number;
  };
  model?: {
    id?: string;
    display_name?: string;
  };
}

// ── Helpers ──────────────────────────────────────────────────

function getPhaseColor(phase: string): string {
  if (!phase) return DIM;
  if (phase.startsWith('gate_')) return YELLOW;
  if (phase === 'complete' || phase === 'light_complete') return GREEN;
  if (phase === 'cancelled') return RED;
  if (phase === 'phase_5_execution' || phase === 'light_execution' || phase === 'light_turbo') return CYAN;
  if (phase === 'phase_6_review' || phase === 'phase_6_5_full_review' || phase === 'phase_4_validation') return MAGENTA;
  return '';
}

/**
 * Heart-based context bar: ♥ for filled, ♡ for empty
 */
function renderHeartBar(pct: number | undefined | null): string | null {
  if (pct == null || pct < 0) return null;
  const safe = Math.min(100, Math.max(0, Math.round(pct)));
  const barWidth = 10;
  const filled = Math.round((safe / 100) * barWidth);
  const empty = barWidth - filled;

  let color: string;
  let suffix = '';
  if (safe >= CTX_CRITICAL)       { color = RED;    suffix = ' CRITICAL'; }
  else if (safe >= CTX_COMPRESS)  { color = YELLOW; suffix = ' COMPRESS?'; }
  else if (safe >= CTX_WARNING)   { color = YELLOW; }
  else                            { color = GREEN; }

  const hearts = `${color}${'\u2665'.repeat(filled)}${DIM}${'\u2661'.repeat(empty)}${RESET}`;
  return `\uD83E\uDDE0 Ctx: [${hearts}] ${color}${safe}%${suffix}${RESET}`;
}

/**
 * Compact context (no bar) for idle state
 */
function renderContextCompact(pct: number | undefined | null): string | null {
  if (pct == null || pct < 0) return null;
  const safe = Math.min(100, Math.max(0, Math.round(pct)));

  let color: string;
  let suffix = '';
  if (safe >= CTX_CRITICAL)       { color = RED;    suffix = ' CRITICAL'; }
  else if (safe >= CTX_COMPRESS)  { color = YELLOW; suffix = ' COMPRESS?'; }
  else if (safe >= CTX_WARNING)   { color = YELLOW; }
  else                            { color = GREEN; }

  return `\uD83E\uDDE0 Ctx: ${color}${safe}%${suffix}${RESET}`;
}

function renderSessionDuration(startedAt: string): string | null {
  if (!startedAt) return null;
  try {
    const ms = Date.now() - new Date(startedAt).getTime();
    const minutes = Math.floor(ms / 60_000);

    let color: string;
    if (minutes > 120) color = RED;
    else if (minutes > 60) color = YELLOW;
    else color = GREEN;

    if (minutes < 1)  return `\u2615 Session: ${color}<1m${RESET}`;
    if (minutes < 60) return `\u2615 Session: ${color}${minutes}m${RESET}`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `\u2615 Session: ${color}${h}h${m}m${RESET}`;
  } catch {
    return null;
  }
}

function getAgentCode(role: string): string {
  return AGENT_CODES[role] || role.charAt(0).toUpperCase();
}

function getModelColor(model?: string): string {
  if (!model) return CYAN;
  const m = model.toLowerCase();
  if (m.includes('opus'))   return MAGENTA;
  if (m.includes('sonnet')) return YELLOW;
  if (m.includes('haiku'))  return GREEN;
  return CYAN;
}

function renderAgents(cwd: string): string | null {
  try {
    const trackPath = normalizePath(
      path.join(getProjectStateRoot(cwd), 'subagent-tracking.json')
    );
    const records = readJson<SubagentRecord[]>(trackPath);
    if (!records || !Array.isArray(records)) return null;

    // Show running agents first; if none running, show agents from current session
    const running = records.filter(a => a.status === 'running');
    const displayAgents = running.length > 0 ? running : getRecentAgents(records);
    if (displayAgents.length === 0) return null;

    // Deduplicate by role (show unique roles only)
    const seen = new Set<string>();
    const codes: string[] = [];
    for (const a of displayAgents) {
      const role = a.role || 'unknown';
      if (seen.has(role)) continue;
      seen.add(role);
      const code = getAgentCode(role);
      const color = a.status === 'running' ? getModelColor((a as any).model) : DIM;
      codes.push(`${color}${code}${RESET}`);
    }

    const prefix = running.length > 0 ? '\uD83D\uDC6F' : '\uD83D\uDC6F';
    return `${prefix} Agents: ${codes.join('')}`;
  } catch {
    return null;
  }
}

/**
 * Get agents from the current session (stopped within the last 30 minutes).
 * This ensures agent codes are visible even between spawns.
 */
function getRecentAgents(records: SubagentRecord[]): SubagentRecord[] {
  const cutoff = Date.now() - 30 * 60 * 1000; // 30 minutes
  return records.filter(a => {
    if (a.status === 'running') return true;
    if (a.stopped_at) {
      const stoppedMs = new Date(a.stopped_at).getTime();
      return !isNaN(stoppedMs) && stoppedMs > cutoff;
    }
    return false;
  });
}

function renderLinks(cwd: string): string | null {
  try {
    const summary = getTaskSummary(cwd);
    if (summary.total === 0) return null;

    let color: string;
    const pct = Math.round((summary.done / summary.total) * 100);
    if (pct >= 100)    color = GREEN;
    else if (pct > 50) color = YELLOW;
    else               color = DIM;

    return `\uD83D\uDD17 Links: ${color}${summary.done}/${summary.total}${RESET}`;
  } catch {
    return null;
  }
}

function renderCounters(session: SessionState): string {
  const parts: string[] = [];

  if (session.mode !== 'mylight') {
    const r = session.reinforcement_count || 0;
    const rColor = r > 10 ? RED : r > 5 ? YELLOW : GREEN;
    parts.push(`\uD83C\uDFAF R:${rColor}${r}${RESET}`);
  }

  const f = session.failure_count || 0;
  const fColor = f > 3 ? RED : f > 0 ? YELLOW : GREEN;
  parts.push(`\uD83D\uDCA6 F:${fColor}${f}${RESET}`);

  return parts.join(' ');
}

// ── Main statusline builder ──────────────────────────────────

function buildStatus(session: SessionState | null, stdin: StdinData | null, cwd: string): string {
  const sep = ` ${DIM}\u250A${RESET} `;   // ┊

  // ── LINE 1: top border + identity + mode + phase ──
  const line1Parts: string[] = [];

  // Version
  line1Parts.push(`\uD83C\uDF38 OML v${VERSION}`);

  if (!session || !session.active) {
    // Idle state
    const line1 = `\u256D\u2500${line1Parts.join('')} \u2727 ${DIM}idle${RESET}`;

    // Line 2: context only (if available)
    const ctx = renderContextCompact(stdin?.context_window?.used_percentage);
    const line2 = `\u2570\u2500${ctx || ''}`;

    return `${line1}\n${line2}`;
  }

  // Mode
  if (session.mode === 'mylink') {
    line1Parts.push(`\uD83E\uDE84 ${MAGENTA}Start.Link${RESET}`);
  } else {
    line1Parts.push(`\uD83E\uDE84 ${CYAN}Start.Fast${RESET}`);
  }

  // Phase
  const phaseName = PHASE_DISPLAY[session.current_phase] || session.current_phase;
  const phaseColor = getPhaseColor(session.current_phase);
  line1Parts.push(`\u2728 ${phaseColor}${phaseName}${RESET}`);

  const line1 = `\u256D\u2500${line1Parts.join(` ${DIM}\u2727${RESET} `)}`;

  // ── LINE 2: bottom border + metrics ──
  const line2Parts: string[] = [];

  // Context bar (hearts)
  const ctxBar = renderHeartBar(stdin?.context_window?.used_percentage);
  if (ctxBar) line2Parts.push(ctxBar);

  // Session duration
  const dur = renderSessionDuration(session.started_at);
  if (dur) line2Parts.push(dur);

  // Active agents
  const agents = renderAgents(cwd);
  if (agents) line2Parts.push(agents);

  // Link progress (Start.Link only)
  if (session.mode !== 'mylight') {
    const links = renderLinks(cwd);
    if (links) line2Parts.push(links);
  }

  // R/F counters
  line2Parts.push(renderCounters(session));

  const line2 = `\u2570\u2500${line2Parts.join(sep)}`;

  return `${line1}\n${line2}`;
}

// ── Stdin reading ────────────────────────────────────────────

function readStdin(): Promise<StdinData | null> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => {
      const trimmed = data.trim();
      if (!trimmed) { resolve(null); return; }
      try { resolve(JSON.parse(trimmed)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => resolve(null));
    setTimeout(() => resolve(null), 3000);
  });
}

// ── Entry point ──────────────────────────────────────────────

async function main(): Promise<void> {
  const stdin = await readStdin();

  let cwd = process.cwd();
  if (stdin?.cwd) {
    cwd = stdin.cwd;
  } else if (process.env.CLAUDE_PROJECT_DIR) {
    cwd = process.env.CLAUDE_PROJECT_DIR;
  }

  const session = readJson<SessionState>(getSessionPath(cwd));
  const output = buildStatus(session, stdin, cwd);

  process.stdout.write(output + '\n');
}

main().catch(() => {
  process.stdout.write(`\u256D\u2500\uD83C\uDF38 OML v${VERSION} \u2727 ${DIM}idle${RESET}\n\u2570\u2500\n`);
});
