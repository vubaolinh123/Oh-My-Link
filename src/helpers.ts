import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { getErrorLogPath, getDebugLogPath, getSystemRoot, ensureDir, normalizePath } from './state';

// ============================================================
// Oh-My-Link — Helper Utilities
// ============================================================

/**
 * Read and parse a JSON file. Returns null if file doesn't exist or is invalid.
 */
export function readJson<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Write JSON to a file atomically (tmp + rename).
 * Creates parent directories if needed.
 * LOGS errors to ~/.oh-my-link/error.log instead of silently swallowing.
 *
 * Special handling for session.json:
 *   1. AUDIT — every write is appended to session-write-audit.log with caller info.
 *   2. HARDENING — locked_mode and locked_phase are preserved from existing file;
 *      if the caller's data tries to overwrite them, the old values are restored
 *      and an audit warning is logged.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const normalized = normalizePath(filePath);
  const dir = path.dirname(normalized);

  const isSessionFile = normalized.endsWith('/session.json') || normalized.endsWith('\\session.json');

  // --- Session hardening: preserve locked_* fields ---
  if (isSessionFile && data && typeof data === 'object' && !Array.isArray(data)) {
    try {
      if (fs.existsSync(normalized)) {
        const existingRaw = fs.readFileSync(normalized, 'utf-8');
        const existing = JSON.parse(existingRaw) as Record<string, unknown>;
        const incoming = data as Record<string, unknown>;
        const LOCKED_KEYS = ['locked_mode', 'locked_phase'] as const;
        const corrected: string[] = [];

        for (const key of LOCKED_KEYS) {
          if (existing[key] !== undefined) {
            // If incoming tries to change a locked field, restore the old value
            if (incoming[key] !== undefined && incoming[key] !== existing[key]) {
              corrected.push(`${key}: ${JSON.stringify(incoming[key])} → ${JSON.stringify(existing[key])}`);
              incoming[key] = existing[key];
            }
            // If incoming omits a locked field, carry it forward
            if (incoming[key] === undefined) {
              incoming[key] = existing[key];
            }
          }
        }

        if (corrected.length > 0) {
          sessionWriteAudit(normalized, `LOCKED_FIELD_CORRECTED: ${corrected.join('; ')}`);
        }
      }
    } catch {
      // Best-effort hardening — don't block the write
    }
  }

  try {
    ensureDir(dir);

    const tmpPath = normalized + '.tmp.' + process.pid;
    const content = JSON.stringify(data, null, 2) + '\n';

    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, normalized);

    // --- Session audit: log every write ---
    if (isSessionFile) {
      try {
        const dataObj = data as Record<string, unknown>;
        const phase = dataObj.current_phase ?? '?';
        const active = dataObj.active ?? '?';
        const mode = dataObj.mode ?? '?';
        sessionWriteAudit(
          normalized,
          `WRITE phase=${phase} active=${active} mode=${mode}`
        );
      } catch { /* audit must never block */ }
    }
  } catch (err) {
    // Log error instead of silently swallowing
    logError('writeJsonAtomic', `Failed to write ${normalized}: ${err}`);

    // Clean up tmp file if it exists
    const tmpPath = normalized + '.tmp.' + process.pid;
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Best effort cleanup
    }

    // Re-throw so callers know the write failed
    throw err;
  }
}

/**
 * Write an audit entry for session.json writes.
 * Appended to ~/.oh-my-link/session-write-audit.log.
 * Contains timestamp, PID, argv, short stack trace, and the caller's message.
 * NEVER throws — audit failures are silently ignored.
 */
export function sessionWriteAudit(sessionPath: string, message: string): void {
  try {
    const auditDir = getSystemRoot();
    ensureDir(auditDir);
    const auditPath = normalizePath(path.join(auditDir, 'session-write-audit.log'));

    const ts = new Date().toISOString();
    const pid = process.pid;
    const argv = JSON.stringify(process.argv.slice(0, 4)); // first 4 args to keep it concise
    // Grab a short stack trace (3 call frames after this function)
    const stack = new Error().stack || '';
    const stackLines = stack.split('\n').slice(2, 5).map(l => l.trim()).join(' | ');

    const entry = `[${ts}] pid=${pid} argv=${argv} session=${sessionPath} ${message} stack=[${stackLines}]\n`;
    fs.appendFileSync(auditPath, entry, 'utf-8');

    // Rotate: cap at 200KB
    try {
      const stats = fs.statSync(auditPath);
      if (stats.size > 200_000) {
        const content = fs.readFileSync(auditPath, 'utf-8');
        const truncated = content.slice(content.length - 100_000);
        const firstNl = truncated.indexOf('\n');
        fs.writeFileSync(auditPath, firstNl >= 0 ? truncated.slice(firstNl + 1) : truncated, 'utf-8');
      }
    } catch { /* rotation is best effort */ }
  } catch {
    // Audit logging must never throw
  }
}

/**
 * Read all of stdin as a string (async).
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);

    // Handle case where stdin is already ended
    if (process.stdin.readableEnded) {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    }
  });
}

/**
 * Parse hook input from stdin JSON.
 * Returns empty object if parsing fails.
 *
 * When debug_mode is enabled, writes the raw stdin payload to a rotating
 * debug file: ~/.oh-my-link/debug/payloads/{timestamp}-{hookname}-{pid}.json
 * Capped at 200KB per payload; directory auto-cleaned to max 50 files.
 */
export async function parseHookInput(): Promise<Record<string, unknown>> {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return {};

    // Debug: capture raw payload if debug_mode is on
    captureRawPayload(raw);

    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Capture raw hook payload for debugging.
 * Writes to ~/.oh-my-link/debug/payloads/ when debug_mode is enabled.
 * NEVER throws.
 */
function captureRawPayload(raw: string): void {
  try {
    if (!isDebugMode()) return;

    const debugDir = normalizePath(path.join(getSystemRoot(), 'debug', 'payloads'));
    ensureDir(debugDir);

    // Derive hook name from process.argv (hooks are invoked as: node dist/hooks/<name>.js)
    let hookName = 'unknown';
    const scriptArg = process.argv[1] || '';
    const match = scriptArg.match(/[\\/]([^\\/]+?)(?:\.js)?$/);
    if (match) hookName = match[1];

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${ts}-${hookName}-${process.pid}.json`;
    const payloadPath = normalizePath(path.join(debugDir, fileName));

    // Cap payload at 200KB
    const capped = raw.length > 200_000 ? raw.slice(0, 200_000) + '\n[... truncated]' : raw;
    fs.writeFileSync(payloadPath, capped, 'utf-8');

    // Cleanup: keep max 50 files (delete oldest)
    try {
      const files = fs.readdirSync(debugDir)
        .filter(f => f.endsWith('.json'))
        .sort();
      if (files.length > 50) {
        const toDelete = files.slice(0, files.length - 50);
        for (const f of toDelete) {
          try { fs.unlinkSync(path.join(debugDir, f)); } catch { /* best effort */ }
        }
      }
    } catch { /* cleanup is best effort */ }
  } catch {
    // Payload capture must never throw
  }
}

/**
 * Output standard hook response with hookSpecificOutput format.
 * Used by hooks that need the hookEventName field.
 * NOTE: additionalContext is injected "discretely" — Claude may ignore it.
 * For UserPromptSubmit where you need Claude to ACT on the context,
 * use promptContextOutput() instead which uses plain text stdout.
 */
export function hookOutput(
  eventName: string,
  additionalContext?: string,
  systemMessage?: string
): void {
  const output: Record<string, unknown> = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: eventName,
      ...(additionalContext ? { additionalContext } : {}),
    },
  };
  if (systemMessage) {
    output.systemMessage = systemMessage;
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}

/**
 * Output plain text for UserPromptSubmit hooks.
 * Per Claude Code docs: "Plain stdout is shown as hook output in the transcript.
 * The additionalContext field is added more discretely."
 * 
 * This is the STRONGEST injection mechanism — plain text stdout is added as
 * visible context that Claude can see and act on, not hidden supplementary info.
 * Use this for imperative orchestration prompts that Claude MUST follow.
 */
export function promptContextOutput(context: string): void {
  // Plain text stdout — no JSON wrapper — gets added as visible context
  process.stdout.write(context);
}

/**
 * Output simple hook response without hookSpecificOutput.
 * Used by hooks whose event name is not in Claude Code's allowed union
 * (SessionEnd, SubagentStop, Stop).
 */
export function simpleOutput(
  additionalContext?: string,
  systemMessage?: string
): void {
  const output: Record<string, unknown> = { continue: true };
  if (additionalContext) {
    output.additionalContext = additionalContext;
  }
  if (systemMessage) {
    output.systemMessage = systemMessage;
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}

/**
 * Output a Stop hook decision (block or allow).
 * For 'allow': output empty JSON (exit 0 permits stop).
 * For 'block': output decision: "block" with stopReason.
 */
export function stopOutput(
  decision: 'block' | 'allow',
  reason?: string
): void {
  if (decision === 'allow') {
    // Allow stop — include continue: true and suppressOutput
    const output: Record<string, unknown> = { continue: true, suppressOutput: true };
    if (reason) {
      output.reason = reason;
    }
    process.stdout.write(JSON.stringify(output) + '\n');
  } else {
    // Block stop
    const output: Record<string, unknown> = {
      continue: true,
      decision: 'block',
    };
    if (reason) {
      output.reason = reason;
    }
    process.stdout.write(JSON.stringify(output) + '\n');
  }
}

/**
 * Output a PreToolUse deny decision (schema-compliant).
 */
export function toolDenyOutput(reason: string): void {
  const output = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny' as const,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

/**
 * Get the quiet level from OML_QUIET env var.
 * 0 = normal, 1 = reduced, 2 = errors only
 */
export function getQuietLevel(): 0 | 1 | 2 {
  const level = parseInt(process.env.OML_QUIET || '0', 10);
  if (level === 1) return 1;
  if (level >= 2) return 2;
  return 0;
}

/**
 * Log an error to the error log file.
 * Non-throwing — errors during logging are silently ignored.
 */
export function logError(source: string, message: string): void {
  try {
    const logPath = getErrorLogPath();
    const dir = path.dirname(logPath);
    ensureDir(dir);

    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${source}] ${message}\n`;

    fs.appendFileSync(logPath, entry, 'utf-8');
  } catch {
    // Cannot log the logging error — silent fail is acceptable here
  }
}

/**
 * Write a debug trace entry if debug_mode is enabled.
 * Format: [timestamp] [role] [source] message
 * Checks debug_mode by reading config directly (avoids circular dependency with config.ts).
 */
export function debugLog(cwd: string, source: string, message: string): void {
  try {
    if (!isDebugMode(cwd)) return;

    const logPath = getDebugLogPath(cwd);
    ensureDir(path.dirname(logPath));

    const timestamp = new Date().toISOString().substring(11, 23); // HH:mm:ss.sss
    const role = process.env.OML_AGENT_ROLE || 'host';
    const entry = `[${timestamp}] [${role}] [${source}] ${message}\n`;

    fs.appendFileSync(logPath, entry, 'utf-8');

    // Rotate: if file exceeds 500KB, truncate to last 250KB
    try {
      const stats = fs.statSync(logPath);
      if (stats.size > 512_000) {
        const content = fs.readFileSync(logPath, 'utf-8');
        const truncated = content.slice(content.length - 256_000);
        // Start from first newline to avoid partial line
        const firstNewline = truncated.indexOf('\n');
        fs.writeFileSync(logPath, firstNewline >= 0 ? truncated.slice(firstNewline + 1) : truncated, 'utf-8');
      }
    } catch { /* best effort rotation */ }
  } catch {
    // Debug logging must never throw
  }
}

/**
 * Check if debug mode is enabled (global or project-level).
 * Extracted to avoid duplicating the config-read logic.
 */
export function isDebugMode(cwd?: string): boolean {
  try {
    const configPath = normalizePath(path.join(
      process.env.OML_HOME || path.join(os.homedir(), '.oh-my-link'),
      'config.json'
    ));
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      if (JSON.parse(raw).debug_mode === true) return true;
    } catch { /* config unreadable */ }

    if (cwd) {
      try {
        const projectConfigPath = normalizePath(path.join(cwd, '.oh-my-link', 'config.json'));
        const raw = fs.readFileSync(projectConfigPath, 'utf-8');
        if (JSON.parse(raw).debug_mode === true) return true;
      } catch { /* no project config */ }
    }
  } catch { /* safety net */ }
  return false;
}

/**
 * Get the current working directory from hook input or process.cwd().
 */
export function getCwd(input: Record<string, unknown>): string {
  const raw = typeof input.cwd === 'string' ? input.cwd
            : typeof input.directory === 'string' ? input.directory
            : process.cwd();
  return normalizePath(raw);
}

/**
 * Clip long text to a maximum length with annotation.
 */
export function clipText(text: string, maxLength: number = 12000): string {
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength);
  return clipped + `\n\n[... clipped ${text.length - maxLength} chars]`;
}

/**
 * Check if a session is in a terminal phase (safe to stop).
 */
export function isTerminalPhase(phase: string): boolean {
  return ['complete', 'completed', 'cancelled', 'canceled', 'failed', 'light_complete', 'fast_complete'].includes(phase);
}

/**
 * Check if a session is in a critical phase (unsafe to stop).
 */
export function isCriticalPhase(phase: string): boolean {
  return [
    'phase_5_execution',
    'phase_6_review',
    'phase_6_5_full_review',
    'light_execution',
  ].includes(phase);
}

/**
 * Get elapsed time since a timestamp, formatted as human-readable string.
 */
export function getElapsed(since: string): string {
  const ts = new Date(since).getTime();
  if (isNaN(ts)) return '?';
  const ms = Date.now() - ts;
  if (ms < 0) return '0s';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(ms / 1000)}s`;
}
