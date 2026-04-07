import { parseHookInput, hookOutput, toolDenyOutput, getCwd, debugLog } from '../helpers';
import { getSessionPath } from '../state';
import { readJson } from '../helpers';
import { SessionState, HookInput } from '../types';
import { acquireLock, releaseLock } from '../task-engine';

// ============================================================
// Oh-My-Link — Pre-Tool Enforcer (PreToolUse)
// ============================================================

// Role-based tool restrictions
// Key = role, Value = { deny: tools to block, fileRestrict?: path patterns allowed for Write }
const ROLE_RESTRICTIONS: Record<string, {
  deny: string[];
  fileRestrict?: RegExp[];
}> = {
  master: {
    deny: ['Edit', 'MultiEdit'],
    fileRestrict: [/(?:^|[/\\])\.oh-my-link[/\\]/],
  },
  scout: {
    deny: ['Edit', 'MultiEdit'],
    fileRestrict: [/CONTEXT\.md$/, /EXPLORATION\.md$/],
  },
  'fast-scout': {
    deny: ['Edit', 'MultiEdit', 'Agent'],
    fileRestrict: [/BRIEF\.md$/],
  },
  architect: {
    deny: ['Edit', 'MultiEdit'],
    fileRestrict: [/\.oh-my-link\/plans\//, /\.oh-my-link\/tasks\//],
  },
  worker: {
    deny: ['Agent', 'AskUserQuestion'],
  },
  reviewer: {
    deny: ['Edit', 'MultiEdit', 'Write', 'Agent'],
  },
  executor: {
    deny: ['Agent', 'AskUserQuestion'],
  },
  explorer: {
    deny: ['Write', 'Edit', 'MultiEdit', 'Agent'],
  },
  verifier: {
    deny: ['Edit', 'MultiEdit', 'Write', 'Agent'],
  },
  'code-reviewer': {
    deny: ['Edit', 'MultiEdit', 'Write', 'Agent'],
  },
  'security-reviewer': {
    deny: ['Edit', 'MultiEdit', 'Write', 'Agent'],
  },
  'test-engineer': {
    deny: ['Agent'],
    fileRestrict: [/\.(test|spec)\.[^/]+$/, /\/__tests__\//, /\/tests?\//, /(?:^|[/\\])tests?[/\\]/],
  },
};

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

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const toolName = input.tool_name || '';
  const toolInput = (input.tool_input || {}) as Record<string, unknown>;
  const cwd = getCwd(input as Record<string, unknown>);

  // Get agent role from env var (structured, not text-scanning)
  const rawRole = process.env.OML_AGENT_ROLE || '';
  // Normalize: lowercase, replace _ with - (e.g. FAST_SCOUT -> fast-scout)
  let role = rawRole.toLowerCase().replace(/_/g, '-');

  // Read session once for both role inference and later file locking
  const session = readJson<SessionState>(getSessionPath(cwd));

  // If no explicit role but OML session is active, the root session is the orchestrator (master).
  // This prevents the root session from bypassing role enforcement when always-on triggers.
  if (!role && session?.active) {
    role = 'master';
  }

  debugLog(cwd, 'pre-tool', `tool=${toolName} role=${role || 'none'}`);

  // SAFETY FIRST: Check Bash commands regardless of role/session.
  // This prevents destructive commands from being run by ANY user,
  // even outside an OML session.
  if (toolName === 'Bash') {
    const command = (toolInput.command as string) || '';
    const blocked = BASH_HARD_BLOCK.find(pattern => pattern.test(command));
    if (blocked) {
      debugLog(cwd, 'pre-tool', `BASH BLOCKED: dangerous command`);
      toolDenyOutput(`[oh-my-link] Dangerous Bash command blocked for safety.`);
      return;
    }
    // Role-specific warn happens later if role is set
  }

  // If no role set, allow tool (Bash safety already checked above)
  if (!role) {
    hookOutput('PreToolUse');
    return;
  }

  const restrictions = ROLE_RESTRICTIONS[role];
  if (!restrictions) {
    hookOutput('PreToolUse');
    return;
  }

  // Session check — reuse cached session from role inference above
  // (session was already read at the top of main())

  // Check tool denial
  if (restrictions.deny.includes(toolName)) {
    debugLog(cwd, 'pre-tool', `DENIED: ${toolName} for role ${role}`);
    toolDenyOutput(`[oh-my-link] Role "${role}" cannot use tool "${toolName}".`);
    return;
  }

  // Check file path restrictions for write operations
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName) && restrictions.fileRestrict) {
    const targetPaths = extractTargetPaths(toolName, toolInput);
    for (const targetPath of targetPaths) {
      const normalizedPath = targetPath.replace(/\\/g, '/');
      const allowed = restrictions.fileRestrict.some(r => r.test(normalizedPath));
      if (!allowed) {
        toolDenyOutput(`[oh-my-link] Role "${role}" can only write to restricted paths. Attempted: ${normalizedPath}`);
        return;
      }
    }
  }

  // Check Bash warnings (hard block already done above)
  if (toolName === 'Bash') {
    const command = (toolInput.command as string) || '';
    const warned = BASH_WARN.find(pattern => pattern.test(command));
    if (warned) {
      // Warn but allow — add context
      hookOutput('PreToolUse', `[oh-my-link] WARNING: Risky command detected. Proceed with caution.`);
      return;
    }
  }

  // AUTO FILE LOCKING
  // When a Worker/Executor edits a file, auto-acquire a lock
  if (session?.active && isWriteOperation(toolName) && isWorkerRole(role)) {
    const targetPaths = extractTargetPaths(toolName, toolInput);
    const agentId = process.env.OML_AGENT_ID || `agent-${process.pid}`;
    const acquired: string[] = [];

    for (const targetPath of targetPaths) {
      try {
        const result = acquireLock(cwd, targetPath, agentId);
        if (!result.success) {
          // Rollback already acquired locks
          for (const acq of acquired) {
            releaseLock(cwd, acq, agentId);
          }
          toolDenyOutput(`[oh-my-link] File "${targetPath}" is locked by ${result.holder}. Wait for release.`);
          return;
        }
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

function isWorkerRole(role: string): boolean {
  return ['worker', 'executor'].includes(role);
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
