import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseHookInput, hookOutput, readJson, writeJsonAtomic, getCwd, logError } from '../helpers';
import { getProjectStateRoot, getSessionPath, normalizePath } from '../state';
import { HookInput, SessionState } from '../types';

interface ToolFailureTracker {
  tool_name: string;
  count: number;
  first_failure: string;
  last_failure: string;
  error_snippet?: string;
  escalated?: boolean;
}

const RETRY_WINDOW_MS = 60 * 1000; // 60 seconds
const MAX_RETRIES = 5;
const TASK_ENGINE_MAX_RETRIES = 2; // Fast-escalation for task engine operations

// Task engine related tool names
const TASK_ENGINE_TOOLS = new Set([
  'task-engine', 'createTask', 'readTask', 'updateTaskStatus',
  'listTasks', 'acquireLock', 'releaseLock',
]);

function isTaskEngineTool(toolName: string): boolean {
  return TASK_ENGINE_TOOLS.has(toolName);
}

function getMaxRetries(toolName: string): number {
  return isTaskEngineTool(toolName) ? TASK_ENGINE_MAX_RETRIES : MAX_RETRIES;
}

async function main(): Promise<void> {
  const input = await parseHookInput() as HookInput;
  const cwd = getCwd(input as Record<string, unknown>);
  const toolName = input.tool_name || 'unknown';
  const toolError = (input.tool_error || input.tool_output || '') as string;

  // Path containment guard — verify stateDir is under known roots
  const stateDir = getProjectStateRoot(cwd);
  if (!stateDir || stateDir.length < 5) {
    hookOutput('PostToolUseFailure');
    return;
  }
  const resolvedState = path.resolve(stateDir);
  const resolvedCwd = path.resolve(cwd);
  const systemRoot = process.env.OML_HOME || path.join(os.homedir(), '.oh-my-link');
  const resolvedSystem = path.resolve(systemRoot);
  if (!resolvedState.startsWith(resolvedCwd) && !resolvedState.startsWith(resolvedSystem)) {
    hookOutput('PostToolUseFailure');
    return;
  }

  const trackPath = normalizePath(
    path.join(stateDir, 'last-tool-error.json')
  );
  const tracker = readJson<ToolFailureTracker>(trackPath);
  const now = new Date().toISOString();
  const maxRetries = getMaxRetries(toolName);

  // Capture error snippet (first 500 chars)
  const errorSnippet = toolError ? toolError.slice(0, 500) : undefined;

  if (tracker && tracker.tool_name === toolName) {
    const elapsed = Date.now() - new Date(tracker.last_failure).getTime();
    if (elapsed < RETRY_WINDOW_MS) {
      tracker.count++;
      tracker.last_failure = now;
      if (errorSnippet) tracker.error_snippet = errorSnippet;
      try { writeJsonAtomic(trackPath, tracker); } catch { /* ignore */ }

      if (tracker.count >= maxRetries) {
        tracker.escalated = true;
        try { writeJsonAtomic(trackPath, tracker); } catch { /* ignore */ }

        // Set session flag for task engine errors
        if (isTaskEngineTool(toolName)) {
          try {
            const session = readJson<SessionState>(getSessionPath(cwd));
            if (session) {
              (session as any).task_engine_error = true;
              writeJsonAtomic(getSessionPath(cwd), session);
            }
          } catch { /* best effort */ }
        }

        const snippetDisplay = errorSnippet ? `\nLast error: ${errorSnippet.slice(0, 200)}` : '';
        const suggestion = isTaskEngineTool(toolName)
          ? ' Suggest "doctor oml" to diagnose.'
          : ' Consider a different approach.';

        hookOutput('PostToolUseFailure',
          `[oh-my-link] Tool "${toolName}" failed ${tracker.count} times in ${RETRY_WINDOW_MS / 1000}s.${suggestion}${snippetDisplay}`
        );
        return;
      }

      const snippetHint = tracker.count >= 3 && errorSnippet
        ? `\nError: ${errorSnippet.slice(0, 200)}`
        : '';

      hookOutput('PostToolUseFailure',
        `[oh-my-link] Tool "${toolName}" failed (attempt ${tracker.count}/${maxRetries}).${snippetHint}`
      );
      return;
    }
  }

  // New tool or outside retry window — reset
  const newTracker: ToolFailureTracker = {
    tool_name: toolName,
    count: 1,
    first_failure: now,
    last_failure: now,
    error_snippet: errorSnippet,
  };
  try { writeJsonAtomic(trackPath, newTracker); } catch { /* ignore */ }

  hookOutput('PostToolUseFailure',
    `[oh-my-link] Tool "${toolName}" failed (attempt 1/${maxRetries}).`
  );
}

main().catch(() => hookOutput('PostToolUseFailure'));
