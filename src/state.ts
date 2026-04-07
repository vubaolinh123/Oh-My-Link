import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';

// ============================================================
// Oh-My-Link — State Management
// ============================================================

/**
 * Get the system-level root directory for Oh-My-Link state.
 * Uses OML_HOME env var if set, otherwise ~/.oh-my-link/
 */
export function getSystemRoot(): string {
  const envHome = process.env.OML_HOME;
  if (envHome) return normalizePath(envHome);
  return normalizePath(path.join(os.homedir(), '.oh-my-link'));
}

/**
 * Generate an 8-char hash of a project path for isolation.
 * Same path always produces the same hash.
 */
export function projectHash(cwd: string): string {
  let normalized = normalizePath(path.resolve(cwd));
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

/**
 * Get the project-specific runtime state directory.
 * ~/.oh-my-link/projects/{hash}/
 */
export function getProjectStateRoot(cwd: string): string {
  return normalizePath(path.join(getSystemRoot(), 'projects', projectHash(cwd)));
}

/**
 * Get the project-level artifacts directory.
 * {cwd}/.oh-my-link/
 */
export function getArtifactsDir(cwd: string): string {
  return normalizePath(path.join(cwd, '.oh-my-link'));
}

/**
 * Get the plans directory.
 * {cwd}/.oh-my-link/plans/
 */
export function getPlansDir(cwd: string): string {
  return normalizePath(path.join(getArtifactsDir(cwd), 'plans'));
}

/**
 * Get the history directory.
 * {cwd}/.oh-my-link/history/
 */
export function getHistoryDir(cwd: string): string {
  return normalizePath(path.join(getArtifactsDir(cwd), 'history'));
}

/**
 * Get the tasks directory.
 * {cwd}/.oh-my-link/tasks/
 */
export function getTasksDir(cwd: string): string {
  return normalizePath(path.join(getArtifactsDir(cwd), 'tasks'));
}

/**
 * Get the locks directory.
 * {cwd}/.oh-my-link/locks/
 */
export function getLocksDir(cwd: string): string {
  return normalizePath(path.join(getArtifactsDir(cwd), 'locks'));
}

/**
 * Get the skills directory (learned skills).
 * {cwd}/.oh-my-link/skills/
 */
export function getSkillsDir(cwd: string): string {
  return normalizePath(path.join(getArtifactsDir(cwd), 'skills'));
}

/**
 * Get the context directory (external context docs).
 * {cwd}/.oh-my-link/context/
 */
export function getContextDir(cwd: string): string {
  return normalizePath(path.join(getArtifactsDir(cwd), 'context'));
}

/**
 * Get the handoffs directory.
 * ~/.oh-my-link/projects/{hash}/handoffs/
 */
export function getHandoffsDir(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'handoffs'));
}

/**
 * Resolve the state directory, with optional data path override.
 */
export interface StateResolution {
  stateDir: string;
  artifactsDir: string;
  cwd: string;
  hash: string;
}

export function resolveStateDir(cwd: string): StateResolution {
  return {
    stateDir: getProjectStateRoot(cwd),
    artifactsDir: getArtifactsDir(cwd),
    cwd: normalizePath(cwd),
    hash: projectHash(cwd),
  };
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dir: string): void {
  const normalized = normalizePath(dir);
  if (!fs.existsSync(normalized)) {
    fs.mkdirSync(normalized, { recursive: true });
  }
}

/**
 * Ensure all runtime state directories exist.
 * Called by session-start hook.
 */
export function ensureRuntimeDirs(cwd: string, sessionId?: string): void {
  const stateRoot = getProjectStateRoot(cwd);
  ensureDir(stateRoot);
  ensureDir(getHandoffsDir(cwd));

  if (sessionId) {
    ensureDir(normalizePath(path.join(stateRoot, 'sessions', sessionId)));
  }
}

/**
 * Ensure all project-level artifact directories exist.
 * Called by session-start hook.
 */
export function ensureArtifactDirs(cwd: string): void {
  ensureDir(getPlansDir(cwd));
  ensureDir(getHistoryDir(cwd));
  ensureDir(getTasksDir(cwd));
  ensureDir(getLocksDir(cwd));
  ensureDir(getSkillsDir(cwd));
  ensureDir(getContextDir(cwd));
}

/**
 * Normalize a path to forward slashes (Windows compatibility).
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Get session state file path.
 * ~/.oh-my-link/projects/{hash}/session.json
 */
export function getSessionPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'session.json'));
}

/**
 * Get project memory file path.
 * ~/.oh-my-link/projects/{hash}/project-memory.json
 */
export function getProjectMemoryPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'project-memory.json'));
}

/**
 * Get subagent tracking file path.
 * ~/.oh-my-link/projects/{hash}/subagent-tracking.json
 */
export function getSubagentTrackingPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'subagent-tracking.json'));
}

/**
 * Get tool tracking file path.
 * ~/.oh-my-link/projects/{hash}/tool-tracking.json
 */
export function getToolTrackingPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'tool-tracking.json'));
}

/**
 * Get checkpoint file path.
 * ~/.oh-my-link/projects/{hash}/checkpoint.json
 */
export function getCheckpointPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'checkpoint.json'));
}

/**
 * Get cancel signal file path.
 * ~/.oh-my-link/projects/{hash}/cancel-signal.json
 */
export function getCancelSignalPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'cancel-signal.json'));
}

/**
 * Get error log file path.
 * ~/.oh-my-link/error.log
 */
export function getErrorLogPath(): string {
  return normalizePath(path.join(getSystemRoot(), 'error.log'));
}

/**
 * Get config file path.
 * ~/.oh-my-link/config.json
 */
export function getConfigPath(): string {
  return normalizePath(path.join(getSystemRoot(), 'config.json'));
}

/**
 * Get working memory file path.
 * ~/.oh-my-link/projects/{hash}/working-memory.md
 */
export function getWorkingMemoryPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'working-memory.md'));
}

/**
 * Get priority context file path.
 * {cwd}/.oh-my-link/priority-context.md
 */
export function getPriorityContextPath(cwd: string): string {
  return normalizePath(path.join(getArtifactsDir(cwd), 'priority-context.md'));
}
