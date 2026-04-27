import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { ProjectEntry, ProjectRegistry, SessionState } from './types';

// ============================================================
// Oh-My-Link — State Management
// ============================================================

/**
 * Resolve the Oh-My-Link plugin root directory.
 * Tries (in order):
 *   1. CLAUDE_PLUGIN_ROOT env var (if set and directory exists)
 *   2. ~/.oh-my-link/setup.json → pluginRoot (if file exists and path is valid)
 *   3. Infer from module location: __dirname/.. (for compiled dist/) or __dirname/../.. (if in dist/hooks/)
 * Returns the resolved path (forward slashes) or null if nothing found.
 */
export function resolvePluginRoot(): string | null {
  // Strategy 1: Environment variable
  const envRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (envRoot && fs.existsSync(envRoot)) {
    return normalizePath(envRoot);
  }

  // Strategy 2: setup.json
  try {
    const setupPath = path.join(os.homedir(), '.oh-my-link', 'setup.json');
    if (fs.existsSync(setupPath)) {
      const setup = JSON.parse(fs.readFileSync(setupPath, 'utf-8'));
      if (setup?.pluginRoot && typeof setup.pluginRoot === 'string' && fs.existsSync(setup.pluginRoot)) {
        return normalizePath(setup.pluginRoot);
      }
    }
  } catch { /* ignore */ }

  // Strategy 3: Infer from __dirname
  // At runtime __dirname is dist/ or dist/hooks/ — walk up to find package.json
  let candidate = path.resolve(__dirname, '..');
  for (let i = 0; i < 3; i++) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return normalizePath(candidate);
    }
    candidate = path.resolve(candidate, '..');
  }

  return null;
}

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
 *
 * Only directories with active runtime consumers are created eagerly.
 * `history/` and `context/` are referenced by some skills/agents but written
 * lazily via Write/mkdir-p when actually used — no need to pre-create empties.
 */
export function ensureArtifactDirs(cwd: string): void {
  ensureDir(getPlansDir(cwd));
  ensureDir(getTasksDir(cwd));
  ensureDir(getLocksDir(cwd));
  ensureDir(getSkillsDir(cwd));
}

/**
 * Plan cleanup: archive and clear session artifacts so the next Plan starts
 * with a clean slate. Moves the contents of `plans/`, `tasks/`, and
 * `reviews/` into `.oh-my-link/history/{YYYYMMDD-HHMMSS}-{slug}/` so the
 * record is preserved (review skills + audit) but the live dirs are empty.
 *
 * Preserves: `priority-context.md`, `skills/`, `history/`, `locks/`,
 * `context/`. Returns null when there is nothing to archive (no files in any
 * of the three source dirs).
 */
export function archivePlanArtifacts(
  cwd: string,
  slug?: string,
): { archivePath: string; filesArchived: number } | null {
  const artifactsDir = getArtifactsDir(cwd);
  const sourceDirs = ['plans', 'tasks', 'reviews'];

  // Count meaningful files first — skip archive if there's nothing to move.
  let total = 0;
  for (const d of sourceDirs) {
    const p = path.join(artifactsDir, d);
    if (!fs.existsSync(p)) continue;
    try {
      total += fs.readdirSync(p).filter(f => !f.startsWith('.')).length;
    } catch { /* ignore */ }
  }
  if (total === 0) return null;

  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 17);
  const safeSlug = (slug || 'untitled').toString().replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 40) || 'untitled';
  const archivePath = path.join(artifactsDir, 'history', `${ts}-${safeSlug}`);
  fs.mkdirSync(archivePath, { recursive: true });

  let filesArchived = 0;
  for (const d of sourceDirs) {
    const src = path.join(artifactsDir, d);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(archivePath, d);
    fs.mkdirSync(dst, { recursive: true });
    let entries: string[] = [];
    try { entries = fs.readdirSync(src); } catch { continue; }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      try {
        fs.renameSync(path.join(src, entry), path.join(dst, entry));
        filesArchived++;
      } catch {
        // Locked or in-use — skip; will be cleaned up next archive cycle.
      }
    }
  }

  return { archivePath: normalizePath(archivePath), filesArchived };
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
 * Get debug log file path.
 * ~/.oh-my-link/projects/{hash}/debug.log
 */
export function getDebugLogPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'debug.log'));
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

// --- Memory System Paths (Phase 1) ---

/**
 * Get vector index file path.
 * ~/.oh-my-link/projects/{hash}/vector-index.json
 */
export function getVectorIndexPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'vector-index.json'));
}

/**
 * Get identity file path (project-level, user-authored).
 * {cwd}/.oh-my-link/identity.md
 */
export function getIdentityPath(cwd: string): string {
  return normalizePath(path.join(getArtifactsDir(cwd), 'identity.md'));
}

/**
 * Get knowledge graph database path (Phase 2).
 * ~/.oh-my-link/projects/{hash}/knowledge-graph.sqlite3
 */
export function getKnowledgeGraphPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'knowledge-graph.sqlite3'));
}

/**
 * Get entity registry file path (Phase 2).
 * ~/.oh-my-link/projects/{hash}/entity-registry.json
 */
export function getEntityRegistryPath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'entity-registry.json'));
}

/**
 * Get palace directory path (reserved for future use).
 * ~/.oh-my-link/projects/{hash}/palace/
 */
export function getPalacePath(cwd: string): string {
  return normalizePath(path.join(getProjectStateRoot(cwd), 'palace'));
}

// --- Project Registry ---

/**
 * Get the registry file path.
 * ~/.oh-my-link/projects/registry.json
 */
export function getRegistryPath(): string {
  return normalizePath(path.join(getSystemRoot(), 'projects', 'registry.json'));
}

/**
 * Register a project in the global registry.
 * Called by session-start to track all workspaces.
 */
export function registerProject(cwd: string): void {
  const registryPath = getRegistryPath();
  ensureDir(path.dirname(registryPath));

  let registry: ProjectRegistry = { version: 1, projects: {} };
  try {
    if (fs.existsSync(registryPath)) {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    }
  } catch { /* start fresh if corrupted */ }

  const hash = projectHash(cwd);
  const normalized = normalizePath(path.resolve(cwd));

  // Check if there's an active session
  let hasActiveSession = false;
  try {
    const sessionPath = getSessionPath(cwd);
    if (fs.existsSync(sessionPath)) {
      const session: SessionState = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
      hasActiveSession = session.active === true;
    }
  } catch { /* ignore */ }

  registry.projects[hash] = {
    hash,
    path: normalized,
    name: path.basename(normalized),
    last_used: new Date().toISOString(),
    has_active_session: hasActiveSession,
  };

  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * List all registered projects.
 */
export function listProjects(): ProjectEntry[] {
  const registryPath = getRegistryPath();
  try {
    if (!fs.existsSync(registryPath)) return [];
    const registry: ProjectRegistry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));

    // Refresh active session status
    return Object.values(registry.projects).map(entry => {
      try {
        const sessionPath = normalizePath(
          path.join(getSystemRoot(), 'projects', entry.hash, 'session.json')
        );
        if (fs.existsSync(sessionPath)) {
          const session: SessionState = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
          entry.has_active_session = session.active === true;
        } else {
          entry.has_active_session = false;
        }
      } catch {
        entry.has_active_session = false;
      }
      return entry;
    }).sort((a, b) => b.last_used.localeCompare(a.last_used));
  } catch { return []; }
}
