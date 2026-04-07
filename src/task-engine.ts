import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TaskAssignment, FileLock, LockResult, TaskSummary, TaskStatus } from './types';
import { getTasksDir, getLocksDir, ensureDir, normalizePath } from './state';
import { readJson, writeJsonAtomic, logError } from './helpers';

// ============================================================
// Oh-My-Link — Task Engine
// File-based task tracking and file locking.
// Tasks live in .oh-my-link/tasks/{link-id}.json
// Locks live in  .oh-my-link/locks/{pathHash}.json
// ============================================================

/**
 * Mutex based on atomic mkdir to serialize lock-file operations.
 * mkdir is atomic on all major OS — if it succeeds, we own the mutex.
 * Stale mutexes (from crashed processes) are broken after staleness threshold.
 */
function withLockMutex<T>(lockPath: string, fn: () => T, timeoutMs: number = 10000): T {
  const mutexDir = lockPath + '.mutex';
  const deadline = Date.now() + timeoutMs;
  const STALE_MS = 30_000; // 30s — if mutex is older than this, assume holder crashed

  while (true) {
    try {
      fs.mkdirSync(mutexDir);
      break; // acquired
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;

      // Check for stale mutex (crashed holder)
      try {
        const stat = fs.statSync(mutexDir);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          try { fs.rmdirSync(mutexDir); } catch { /* ignore */ }
          continue; // retry immediately after breaking stale mutex
        }
      } catch { /* stat failed — dir may have just been released, retry */ }

      if (Date.now() > deadline) {
        // Last resort: force-break and retry once
        try { fs.rmdirSync(mutexDir); } catch { /* ignore */ }
        try {
          fs.mkdirSync(mutexDir);
          break;
        } catch {
          throw new Error(`Lock mutex timeout on ${lockPath}`);
        }
      }

      // Spin-wait ~5ms
      const spinUntil = Date.now() + 5;
      while (Date.now() < spinUntil) { /* spin */ }
    }
  }

  try {
    return fn();
  } finally {
    try { fs.rmdirSync(mutexDir); } catch { /* ignore */ }
  }
}

// --- Path helpers ---

/** Get path to a task JSON file */
export function getTaskPath(cwd: string, linkId: string): string {
  return normalizePath(path.join(getTasksDir(cwd), `${linkId}.json`));
}

/** Get path to a lock JSON file. Hash the file path to avoid nested dir issues. */
export function getLockPath(cwd: string, filePath: string): string {
  // Resolve to absolute path first, then normalize for consistent hashing
  let resolved = path.isAbsolute(filePath)
    ? normalizePath(filePath)
    : normalizePath(path.resolve(cwd, filePath));
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 12);
  return normalizePath(path.join(getLocksDir(cwd), `${hash}.json`));
}

// --- Task CRUD ---

/** Create a new task assignment. Writes JSON file. */
export function createTask(cwd: string, task: TaskAssignment): void {
  ensureDir(getTasksDir(cwd));
  const taskPath = getTaskPath(cwd, task.link_id);
  writeJsonAtomic(taskPath, task);
}

/** Read a task by link ID. Returns null if not found. */
export function readTask(cwd: string, linkId: string): TaskAssignment | null {
  return readJson<TaskAssignment>(getTaskPath(cwd, linkId));
}

/** Update task status and optional completion report. */
export function updateTaskStatus(
  cwd: string,
  linkId: string,
  status: TaskStatus,
  report?: string
): void {
  const taskPath = getTaskPath(cwd, linkId);
  try {
    withLockMutex(taskPath, () => {
      const task = readTask(cwd, linkId);
      if (!task) {
        logError('task-engine', `Task ${linkId} not found for status update`);
        return;
      }
      task.status = status;
      if (status === 'in_progress' && !task.claimed_at) {
        task.claimed_at = new Date().toISOString();
      }
      if (status === 'done' || status === 'failed') {
        task.completed_at = new Date().toISOString();
      }
      if (report) {
        task.completion_report = report;
      }
      writeJsonAtomic(taskPath, task);
    });
  } catch (e: unknown) {
    logError('task-engine', `Failed to update task ${linkId}: ${(e as Error).message}`);
  }
}

/** List all tasks, optionally filtered by status. */
export function listTasks(cwd: string, filter?: TaskStatus): TaskAssignment[] {
  const tasksDir = getTasksDir(cwd);
  if (!fs.existsSync(tasksDir)) return [];

  const files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.json'));
  const tasks: TaskAssignment[] = [];

  for (const file of files) {
    const task = readJson<TaskAssignment>(normalizePath(path.join(tasksDir, file)));
    if (task) {
      if (!filter || task.status === filter) {
        tasks.push(task);
      }
    }
  }

  return tasks;
}

/** Get tasks that are ready to execute (pending + all dependencies done). */
export function getReadyTasks(cwd: string): TaskAssignment[] {
  const allTasks = listTasks(cwd);
  const doneIds = new Set(
    allTasks.filter(t => t.status === 'done').map(t => t.link_id)
  );

  return allTasks.filter(t => {
    if (t.status !== 'pending') return false;
    // All dependencies must be done
    return t.depends_on.every(depId => doneIds.has(depId));
  });
}

/** Get a summary of task counts by status. */
export function getTaskSummary(cwd: string): TaskSummary {
  const allTasks = listTasks(cwd);
  return {
    total: allTasks.length,
    pending: allTasks.filter(t => t.status === 'pending').length,
    in_progress: allTasks.filter(t => t.status === 'in_progress').length,
    done: allTasks.filter(t => t.status === 'done').length,
    failed: allTasks.filter(t => t.status === 'failed').length,
  };
}

// --- File Locking ---

/** Acquire a lock on a file path. Returns success/failure with holder info. */
export function acquireLock(
  cwd: string,
  filePath: string,
  holder: string,
  ttlSeconds: number = 600
): LockResult {
  ensureDir(getLocksDir(cwd));
  const lockPath = getLockPath(cwd, filePath);

  const now = new Date();
  const newLock: FileLock = {
    path: normalizePath(filePath),
    holder,
    acquired_at: now.toISOString(),
    ttl_seconds: ttlSeconds,
    expires_at: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };

  try {
    return withLockMutex(lockPath, () => {
      const existing = readJson<FileLock>(lockPath);

      if (!existing) {
        // No lock file or unreadable — safe to create
        writeJsonAtomic(lockPath, newLock);
        return { success: true, lock: newLock } as LockResult;
      }

      if (existing.holder === holder) {
        // Same holder — refresh TTL
        existing.expires_at = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        writeJsonAtomic(lockPath, existing);
        return { success: true, lock: existing } as LockResult;
      }

      if (isLockExpired(existing)) {
        // Expired — take over
        writeJsonAtomic(lockPath, newLock);
        return { success: true, lock: newLock } as LockResult;
      }

      // Active lock by another holder
      return { success: false, holder: existing.holder } as LockResult;
    });
  } catch (e: unknown) {
    logError('task-engine', `Lock acquisition error: ${(e as Error).message}`);
    return { success: false, holder: 'error' };
  }
}

/** Release a lock held by a specific holder. Returns true if released. */
export function releaseLock(cwd: string, filePath: string, holder: string): boolean {
  const lockPath = getLockPath(cwd, filePath);

  try {
    return withLockMutex(lockPath, () => {
      const existing = readJson<FileLock>(lockPath);
      if (!existing) return true; // No lock = already released
      if (existing.holder !== holder && !isLockExpired(existing)) {
        return false; // Can't release someone else's active lock
      }
      try {
        fs.unlinkSync(lockPath);
      } catch { /* ignore — already deleted */ }
      return true;
    });
  } catch {
    logError('task-engine', `Failed to release lock for ${filePath}`);
    return false;
  }
}

/** Release all locks held by a specific holder. Returns count released. */
export function releaseAllLocks(cwd: string, holder: string): number {
  const locksDir = getLocksDir(cwd);
  if (!fs.existsSync(locksDir)) return 0;

  let count = 0;
  const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const lockPath = normalizePath(path.join(locksDir, file));
    const lock = readJson<FileLock>(lockPath);
    if (lock && lock.holder === holder) {
      try {
        fs.unlinkSync(lockPath);
        count++;
      } catch {
        logError('task-engine', `Failed to release lock ${lockPath}`);
      }
    }
  }

  return count;
}

/** Check if a file is locked. Returns lock info or null. */
export function checkLock(cwd: string, filePath: string): FileLock | null {
  const lockPath = getLockPath(cwd, filePath);

  try {
    return withLockMutex(lockPath, () => {
      const lock = readJson<FileLock>(lockPath);
      if (!lock) return null;
      if (isLockExpired(lock)) {
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        return null;
      }
      return lock;
    });
  } catch {
    // Fallback: read without mutex (better than crashing)
    const lock = readJson<FileLock>(lockPath);
    if (!lock) return null;
    return isLockExpired(lock) ? null : lock;
  }
}

/** Check if a lock has expired based on its TTL. */
export function isLockExpired(lock: FileLock): boolean {
  return new Date(lock.expires_at).getTime() < Date.now();
}

/** Clean up all expired lock files. Returns count cleaned. */
export function cleanExpiredLocks(cwd: string): number {
  const locksDir = getLocksDir(cwd);
  if (!fs.existsSync(locksDir)) return 0;

  let count = 0;
  const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const lockPath = normalizePath(path.join(locksDir, file));
    const lock = readJson<FileLock>(lockPath);
    if (lock && isLockExpired(lock)) {
      try {
        fs.unlinkSync(lockPath);
        count++;
      } catch { /* ignore */ }
    }
  }

  return count;
}

// --- Messaging System ---
// Messages are stored as JSON files in .oh-my-link/messages/{thread}/

interface Message {
  id: string;
  thread: string;
  from: string;
  content: string;
  timestamp: string;
  acknowledged: boolean;
}

/** Get messages directory for a thread */
function getMessagesDir(cwd: string, thread?: string): string {
  const base = normalizePath(path.join(cwd, '.oh-my-link', 'messages'));
  return thread ? normalizePath(path.join(base, thread)) : base;
}

/** Send a message to a thread */
export function sendMessage(cwd: string, thread: string, from: string, content: string): Message {
  const msgDir = getMessagesDir(cwd, thread);
  ensureDir(msgDir);
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const msg: Message = {
    id,
    thread,
    from,
    content,
    timestamp: new Date().toISOString(),
    acknowledged: false,
  };
  writeJsonAtomic(normalizePath(path.join(msgDir, `${id}.json`)), msg);
  return msg;
}

/** Read all unacknowledged messages from inbox (optionally filtered by thread) */
export function readInbox(cwd: string, thread?: string): Message[] {
  const messages: Message[] = [];
  const baseDir = getMessagesDir(cwd);
  if (!fs.existsSync(baseDir)) return messages;

  let threads: string[];
  if (thread) {
    threads = [thread];
  } else {
    try {
      threads = fs.readdirSync(baseDir).filter(f => {
        try {
          const p = path.join(baseDir, f);
          return fs.statSync(p).isDirectory();
        } catch { return false; }
      });
    } catch { return messages; }
  }

  for (const t of threads) {
    const threadDir = normalizePath(path.join(baseDir, t));
    if (!fs.existsSync(threadDir)) continue;
    const files = fs.readdirSync(threadDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const msg = readJson<Message>(normalizePath(path.join(threadDir, file)));
      if (msg && !msg.acknowledged) messages.push(msg);
    }
  }

  return messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Acknowledge a message */
export function acknowledgeMessage(cwd: string, thread: string, messageId: string): void {
  const msgPath = normalizePath(path.join(getMessagesDir(cwd, thread), `${messageId}.json`));
  const msg = readJson<Message>(msgPath);
  if (msg) {
    msg.acknowledged = true;
    writeJsonAtomic(msgPath, msg);
  }
}

// --- Graph Analysis ---

/** Check for dependency cycles. Returns cycle path if found, null if clean. */
export function detectCycles(cwd: string): string[] | null {
  const allTasks = listTasks(cwd);
  const taskMap = new Map(allTasks.map(t => [t.link_id, t]));
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(id: string): string[] | null {
    if (inStack.has(id)) {
      const cycleStart = path.indexOf(id);
      return [...path.slice(cycleStart), id];
    }
    if (visited.has(id)) return null;

    visited.add(id);
    inStack.add(id);
    path.push(id);

    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.depends_on) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }

    path.pop();
    inStack.delete(id);
    return null;
  }

  for (const task of allTasks) {
    const cycle = dfs(task.link_id);
    if (cycle) return cycle;
  }
  return null;
}

/** Get task graph insights (cycles, orphans, bottlenecks) */
export function getTaskInsights(cwd: string): {
  cycles: string[] | null;
  orphaned: string[];
  bottlenecks: string[];
  total: number;
} {
  const allTasks = listTasks(cwd);
  const taskIds = new Set(allTasks.map(t => t.link_id));

  // Find orphaned tasks (depend on non-existent tasks)
  const orphaned: string[] = [];
  for (const task of allTasks) {
    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) {
        orphaned.push(`${task.link_id} depends on missing ${dep}`);
      }
    }
  }

  // Find bottlenecks (tasks that many others depend on)
  const depCount = new Map<string, number>();
  for (const task of allTasks) {
    for (const dep of task.depends_on) {
      depCount.set(dep, (depCount.get(dep) || 0) + 1);
    }
  }
  const bottlenecks = Array.from(depCount.entries())
    .filter(([, count]) => count >= 3)
    .map(([id, count]) => `${id} (${count} dependents)`);

  return {
    cycles: detectCycles(cwd),
    orphaned,
    bottlenecks,
    total: allTasks.length,
  };
}

/** Atomic claim: find next ready task AND mark it in_progress atomically */
export function claimNextTask(cwd: string, holder: string): TaskAssignment | null {
  const ready = getReadyTasks(cwd);
  if (ready.length === 0) return null;

  // Try each ready task until we successfully claim one
  for (const task of ready) {
    const taskPath = getTaskPath(cwd, task.link_id);
    try {
      const claimed = withLockMutex(taskPath, () => {
        // Re-read inside mutex to guarantee freshness
        const fresh = readTask(cwd, task.link_id);
        if (!fresh || fresh.status !== 'pending') return null;

        fresh.status = 'in_progress';
        fresh.assigned_to = holder;
        fresh.claimed_at = new Date().toISOString();
        writeJsonAtomic(taskPath, fresh);
        return fresh;
      });
      if (claimed) return claimed;
    } catch {
      // Mutex timeout — try next task
      continue;
    }
  }
  return null;
}

/** List all current file locks across all holders */
export function listAllLocks(cwd: string): FileLock[] {
  const locksDir = getLocksDir(cwd);
  if (!fs.existsSync(locksDir)) return [];

  const locks: FileLock[] = [];
  const files = fs.readdirSync(locksDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const lock = readJson<FileLock>(normalizePath(path.join(locksDir, file)));
    if (lock && !isLockExpired(lock)) locks.push(lock);
  }
  return locks;
}
