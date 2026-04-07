import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { getErrorLogPath, getDebugLogPath, ensureDir, normalizePath } from './state';

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
 * (Fix: writeJsonAtomic now logs errors instead of silently swallowing them)
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const normalized = normalizePath(filePath);
  const dir = path.dirname(normalized);

  try {
    ensureDir(dir);

    const tmpPath = normalized + '.tmp.' + process.pid;
    const content = JSON.stringify(data, null, 2) + '\n';

    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, normalized);
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
 */
export async function parseHookInput(): Promise<Record<string, unknown>> {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
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
    // Check debug_mode without importing config.ts (circular dep prevention)
    const configPath = normalizePath(path.join(
      process.env.OML_HOME || path.join(os.homedir(), '.oh-my-link'),
      'config.json'
    ));
    let debugEnabled = false;
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const config = JSON.parse(raw);
      debugEnabled = config.debug_mode === true;
    } catch { /* config unreadable = debug off */ }

    // Also check project-level config
    if (!debugEnabled) {
      try {
        const projectConfigPath = normalizePath(path.join(cwd, '.oh-my-link', 'config.json'));
        const raw = fs.readFileSync(projectConfigPath, 'utf-8');
        const config = JSON.parse(raw);
        debugEnabled = config.debug_mode === true;
      } catch { /* no project config */ }
    }

    if (!debugEnabled) return;

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
