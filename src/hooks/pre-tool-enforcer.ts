import { parseHookInput, hookOutput, toolDenyOutput, getCwd, debugLog } from '../helpers';
import { getSessionPath } from '../state';
import { readJson } from '../helpers';
import { SessionState, HookInput } from '../types';
import { acquireLock, releaseLock } from '../task-engine';
import { detectMcpTool } from '../mcp-config';

// ============================================================
// Oh-My-Link — Pre-Tool Enforcer (PreToolUse)
// ============================================================

// Truly destructive Bash commands — hard block
const BASH_HARD_BLOCK = [
  /rm\s+(-rf?|--recursive)\s+[\/\\]/i,
  /--no-preserve-root/i,
  /DROP\s+(DATABASE|TABLE)/i,
  /pkill\s+-9/i,
  /kill\s+-9\s+1\b/,
  /mkfs\./i,
  /dd\s+if=/i,
  />\s*\/dev\/sd/i,
  /format\s+[cC]:/i,
  /find\s+\/\s+.*-delete/i,
  /:()\{\s*:\|:&\s*\};:/,
  /shutdown/i,
  /reboot/i,
];

// Risky but not always destructive — warn only
const BASH_WARN = [
  /git\s+push\s+.*--force/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-f/i,
  /npm\s+publish/i,
];

function summarizeToolInput(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const cmd = (toolInput.command as string) || '';
    return `cmd="${cmd.slice(0, 100)}"`;
  }
  if (['Edit', 'Write'].includes(toolName)) {
    const fp = (toolInput.file_path as string) ?? (toolInput.filePath as string) ?? '';
    return `file="${fp}"`;
  }
  if (toolName === 'MultiEdit') {
    const edits = toolInput.edits as Array<Record<string, unknown>> | undefined;
    return `files=${edits?.length || 0}`;
  }
  if (toolName === 'Read') {
    const fp = (toolInput.file_path as string) ?? (toolInput.filePath as string) ?? '';
    return `file="${fp}"`;
  }
  if (toolName === 'Glob') {
    return `pattern="${(toolInput.pattern as string) || ''}"`;
  }
  if (toolName === 'Grep') {
    return `pattern="${(toolInput.pattern as string) || ''}"`;
  }
  return `keys=[${Object.keys(toolInput).join(',')}]`;
}

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const toolName = input.tool_name || '';
  const toolInput = (input.tool_input || {}) as Record<string, unknown>;
  const cwd = getCwd(input as Record<string, unknown>);

  // Read session for file locking checks
  const session = readJson<SessionState>(getSessionPath(cwd));

  debugLog(cwd, 'pre-tool', `tool=${toolName} input=${summarizeToolInput(toolName, toolInput)}`);

  // Raw key diagnostic — log ALL keys Claude Code sends
  const rawKeys = Object.keys(input).sort().join(',');
  debugLog(cwd, 'pre-tool-raw', `keys=[${rawKeys}]`);

  // MCP detection
  const mcpInfo = detectMcpTool(toolName, cwd);
  if (mcpInfo) {
    debugLog(cwd, 'mcp-use', `provider=${mcpInfo.providerId} tool=${toolName} method=${mcpInfo.method}`);
  }

  // SAFETY: Check Bash commands regardless of session state.
  // Prevents destructive commands from being run by ANY user.
  if (toolName === 'Bash') {
    const command = (toolInput.command as string) || '';
    const blocked = BASH_HARD_BLOCK.find(pattern => pattern.test(command));
    if (blocked) {
      debugLog(cwd, 'pre-tool', `BASH BLOCKED: dangerous command`);
      toolDenyOutput(`[oh-my-link] Dangerous Bash command blocked for safety.`);
      return;
    }
    const warned = BASH_WARN.find(pattern => pattern.test(command));
    if (warned) {
      hookOutput('PreToolUse', `[oh-my-link] WARNING: Risky command detected. Proceed with caution.`);
      return;
    }
  }

  // AUTO FILE LOCKING
  // When an agent edits a file during an active session, auto-acquire a lock.
  // Use agent_id from hook input (not env var — env vars don't persist in CC's hook model).
  if (session?.active && isWriteOperation(toolName)) {
    const agentId = (input as any).agent_id || (input as any).agentId || `hook-${process.pid}`;
    const targetPaths = extractTargetPaths(toolName, toolInput);
    const acquired: string[] = [];

    for (const targetPath of targetPaths) {
      try {
        const result = acquireLock(cwd, targetPath, agentId);
        if (!result.success) {
          // Rollback already acquired locks
          for (const acq of acquired) {
            releaseLock(cwd, acq, agentId);
          }
          debugLog(cwd, 'pre-tool', `lock-blocked: ${targetPath} held by ${result.holder}`);
          toolDenyOutput(`[oh-my-link] File "${targetPath}" is locked by ${result.holder}. Wait for release.`);
          return;
        }
        debugLog(cwd, 'pre-tool', `lock-acquired: ${targetPath} by ${agentId}`);
        acquired.push(targetPath);
      } catch {
        // Lock acquisition error — fail closed
        for (const acq of acquired) {
          releaseLock(cwd, acq, agentId);
        }
        toolDenyOutput(`[oh-my-link] Failed to acquire lock for "${targetPath}". Try again.`);
        return;
      }
    }
  }

  hookOutput('PreToolUse');
}

function isWriteOperation(toolName: string): boolean {
  return ['Edit', 'MultiEdit', 'Write'].includes(toolName);
}

function extractTargetPaths(toolName: string, toolInput: Record<string, unknown>): string[] {
  if (toolName === 'Write' || toolName === 'Edit') {
    // Check both snake_case and camelCase (Claude Code may use either)
    const fp = (toolInput.file_path as string)
      ?? (toolInput.filePath as string)
      ?? null;
    return fp ? [fp] : [];
  }
  if (toolName === 'MultiEdit') {
    // MultiEdit: edits array may use file_path or filePath
    const edits = (toolInput.edits as Array<Record<string, unknown>>)
      ?? (toolInput.file_edits as Array<Record<string, unknown>>);
    if (Array.isArray(edits)) {
      return edits
        .map(e => (e.file_path as string) ?? (e.filePath as string) ?? null)
        .filter((p): p is string => !!p);
    }
    // Alternative MultiEdit shape: filePath at top level with edits array
    const topLevelPath = (toolInput.file_path as string) ?? (toolInput.filePath as string);
    if (topLevelPath) return [topLevelPath];
  }
  return [];
}

// Run
main().catch(() => {
  hookOutput('PreToolUse');
});
