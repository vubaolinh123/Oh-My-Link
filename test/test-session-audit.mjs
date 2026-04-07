/**
 * Oh-My-Link — Session Audit & Hardening Tests
 * Tests for session-write-audit, locked_* hardening, and isDebugMode
 * Run: node test/test-session-audit.mjs
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// ============================================================
// Minimal test harness (same pattern as test-mcp-config.mjs)
// ============================================================

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function skip(name) {
  skipped++;
  console.log(`  SKIP  ${name}`);
}

function suite(name, fn) {
  console.log(`\n--- ${name} ---`);
  fn();
}

// ============================================================
// Setup: temp directory for isolated tests
// ============================================================

const TEMP_ROOT = path.join(os.tmpdir(), `oml-session-audit-${Date.now()}`);
const OML_HOME = path.join(TEMP_ROOT, 'oml-home');
const TEMP_PROJECT = path.join(TEMP_ROOT, 'test-project');

function setupTempDirs() {
  fs.mkdirSync(OML_HOME, { recursive: true });
  fs.mkdirSync(TEMP_PROJECT, { recursive: true });
  process.env.OML_HOME = OML_HOME;
}

function cleanupTempDirs() {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch { /* best effort */ }
  delete process.env.OML_HOME;
}

/** Write the global config.json (debug_mode on by default). */
function writeGlobalConfig(config = { debug_mode: true }) {
  fs.writeFileSync(path.join(OML_HOME, 'config.json'), JSON.stringify(config), 'utf-8');
}

/** Remove the global config if it exists. */
function removeGlobalConfig() {
  try { fs.unlinkSync(path.join(OML_HOME, 'config.json')); } catch { /* ignore */ }
}

/** Get the audit log path. */
function auditLogPath() {
  return path.join(OML_HOME, 'session-write-audit.log');
}

/** Read the audit log contents (empty string if not present). */
function readAuditLog() {
  try { return fs.readFileSync(auditLogPath(), 'utf-8'); } catch { return ''; }
}

/** Remove the audit log so each test starts clean. */
function clearAuditLog() {
  try { fs.unlinkSync(auditLogPath()); } catch { /* ignore */ }
}

setupTempDirs();
writeGlobalConfig({ debug_mode: true });

// Load module
const helpers = require(path.join(DIST, 'helpers.js'));
const { writeJsonAtomic, readJson, isDebugMode, sessionWriteAudit, _resetDebugModeCache } = helpers;

console.log('Oh-My-Link — Session Audit & Hardening Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Suite 1: Session-write audit
// ============================================================

suite('Session-write audit', () => {
  clearAuditLog();

  test('Writing a non-session JSON file should NOT create an audit entry', () => {
    clearAuditLog();
    const nonSessionPath = path.join(TEMP_ROOT, 'data', 'something.json');
    writeJsonAtomic(nonSessionPath, { foo: 'bar' });

    const log = readAuditLog();
    assertEqual(log, '', 'audit log should be empty for non-session writes');
  });

  test('Writing session.json should create an audit entry with expected fields', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'proj1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'scouting',
      mode: 'link',
    });

    const log = readAuditLog();
    assert(log.length > 0, 'audit log should not be empty');
    // Should contain WRITE keyword
    assert(log.includes('WRITE'), 'audit entry should contain WRITE');
    // Should contain phase info
    assert(log.includes('phase=scouting'), 'audit entry should contain phase');
    // Should contain active info
    assert(log.includes('active=true'), 'audit entry should contain active');
    // Should contain pid
    assert(log.includes(`pid=${process.pid}`), 'audit entry should contain pid');
    // Should contain argv
    assert(log.includes('argv='), 'audit entry should contain argv');
    // Should contain a timestamp (ISO 8601 pattern)
    assert(/\[\d{4}-\d{2}-\d{2}T/.test(log), 'audit entry should contain timestamp');
  });

  test('Multiple session.json writes should append multiple audit entries', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'proj-multi');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    writeJsonAtomic(sessionPath, { active: true, current_phase: 'init', mode: 'link' });
    writeJsonAtomic(sessionPath, { active: true, current_phase: 'scouting', mode: 'link' });
    writeJsonAtomic(sessionPath, { active: false, current_phase: 'complete', mode: 'link' });

    const log = readAuditLog();
    // Each WRITE produces one entry; count occurrences of "WRITE phase="
    const writeMatches = log.match(/WRITE phase=/g);
    assert(writeMatches !== null, 'should find WRITE entries');
    assert(writeMatches.length >= 3, `should have at least 3 WRITE entries, got ${writeMatches.length}`);
  });
});

// ============================================================
// Suite 2: locked_* hardening
// ============================================================

suite('locked_* hardening', () => {
  clearAuditLog();

  test('Writing session.json with different locked_mode — should preserve old value', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'locked-mode-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Write initial session with locked_mode
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'link',
      locked_mode: 'link',
    });

    clearAuditLog();

    // Try to overwrite locked_mode
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'fast',
      locked_mode: 'fast',
    });

    // Read back — locked_mode should still be 'link'
    const written = readJson(sessionPath);
    assertEqual(written.locked_mode, 'link', 'locked_mode should be preserved as original value');

    // Audit log should contain LOCKED_FIELD_CORRECTED
    const log = readAuditLog();
    assert(log.includes('LOCKED_FIELD_CORRECTED'), 'should log LOCKED_FIELD_CORRECTED');
    assert(log.includes('locked_mode'), 'should mention locked_mode in correction log');
  });

  test('Writing session.json with different locked_phase — should preserve old value', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'locked-phase-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Write initial session with locked_phase
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'link',
      locked_phase: 'work',
    });

    clearAuditLog();

    // Try to overwrite locked_phase
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'review',
      mode: 'link',
      locked_phase: 'review',
    });

    // Read back — locked_phase should still be 'work'
    const written = readJson(sessionPath);
    assertEqual(written.locked_phase, 'work', 'locked_phase should be preserved as original value');

    // Audit log should contain LOCKED_FIELD_CORRECTED
    const log = readAuditLog();
    assert(log.includes('LOCKED_FIELD_CORRECTED'), 'should log LOCKED_FIELD_CORRECTED');
    assert(log.includes('locked_phase'), 'should mention locked_phase in correction log');
  });

  test('Writing session.json where incoming omits locked_mode — old value carried forward', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'locked-omit-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Write initial session with locked_mode
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'link',
      locked_mode: 'link',
    });

    // Write again WITHOUT locked_mode — it should be carried forward
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'review',
      mode: 'link',
    });

    const written = readJson(sessionPath);
    assertEqual(written.locked_mode, 'link', 'locked_mode should be carried forward when omitted');
  });

  test('Writing session.json where existing has no locked fields — should write normally', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'no-locked-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Write initial session WITHOUT locked fields
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'init',
      mode: 'link',
    });

    clearAuditLog();

    // Write again WITH locked_mode — should write as-is (no existing locked fields to protect)
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'link',
      locked_mode: 'link',
      locked_phase: 'work',
    });

    const written = readJson(sessionPath);
    assertEqual(written.locked_mode, 'link', 'locked_mode should be written normally');
    assertEqual(written.locked_phase, 'work', 'locked_phase should be written normally');

    // No LOCKED_FIELD_CORRECTED should appear
    const log = readAuditLog();
    assert(!log.includes('LOCKED_FIELD_CORRECTED'), 'should NOT log correction when no existing locked fields');
  });

  test('Writing a brand new session.json (no existing file) — should write as-is', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'brand-new-session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Ensure file does not exist
    try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }

    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'init',
      mode: 'link',
      locked_mode: 'link',
      locked_phase: 'init',
    });

    const written = readJson(sessionPath);
    assertEqual(written.active, true, 'active should be written');
    assertEqual(written.locked_mode, 'link', 'locked_mode should be written as-is');
    assertEqual(written.locked_phase, 'init', 'locked_phase should be written as-is');

    // No LOCKED_FIELD_CORRECTED since there was no existing file
    const log = readAuditLog();
    assert(!log.includes('LOCKED_FIELD_CORRECTED'), 'should NOT log correction for brand-new file');
  });
});

// ============================================================
// Suite 3: parseHookInput raw payload capture (SKIPPED)
// ============================================================

suite('parseHookInput raw payload capture', () => {
  skip('parseHookInput reads from process.stdin — stdin capture via pipe. Tested manually.');
  skip('captureRawPayload is not exported — cannot test directly. Tested manually.');
  skip('Debug payload files written to $OML_HOME/debug/payloads/. Tested manually.');
});

// ============================================================
// Suite 4: isDebugMode helper
// ============================================================

suite('isDebugMode helper', () => {

  test('With global config debug_mode: true — should return true', () => {
    _resetDebugModeCache();
    writeGlobalConfig({ debug_mode: true });
    const result = isDebugMode();
    assertEqual(result, true, 'isDebugMode should return true');
  });

  test('With global config debug_mode: false — should return false', () => {
    _resetDebugModeCache();
    writeGlobalConfig({ debug_mode: false });
    const result = isDebugMode();
    assertEqual(result, false, 'isDebugMode should return false');
  });

  test('With no config file — should return false', () => {
    _resetDebugModeCache();
    removeGlobalConfig();
    const result = isDebugMode();
    assertEqual(result, false, 'isDebugMode should return false when no config');
  });

  test('With project-level config debug_mode: true and no global — should return true', () => {
    _resetDebugModeCache();
    removeGlobalConfig();
    // Create project-level config
    const projectOml = path.join(TEMP_PROJECT, '.oh-my-link');
    fs.mkdirSync(projectOml, { recursive: true });
    fs.writeFileSync(
      path.join(projectOml, 'config.json'),
      JSON.stringify({ debug_mode: true }),
      'utf-8'
    );

    const result = isDebugMode(TEMP_PROJECT);
    assertEqual(result, true, 'isDebugMode should return true from project config');

    // Cleanup project config
    try { fs.rmSync(projectOml, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// ============================================================
// normalizeToolOutput tests
// ============================================================

console.log('\n--- normalizeToolOutput —  tool_response normalization ---');

const { normalizeToolOutput } = require(path.join(DIST, 'helpers.js'));

test('normalizeToolOutput returns stdout from tool_response object', () => {
  const result = normalizeToolOutput({
    tool_response: { stdout: 'hello world', stderr: '' }
  });
  assertEqual(result, 'hello world', 'stdout extraction');
});

test('normalizeToolOutput concatenates stdout + stderr', () => {
  const result = normalizeToolOutput({
    tool_response: { stdout: 'output line', stderr: 'warning line' }
  });
  assertEqual(result, 'output line\nwarning line', 'stdout+stderr concat');
});

test('normalizeToolOutput handles tool_response as string', () => {
  const result = normalizeToolOutput({ tool_response: 'plain string output' });
  assertEqual(result, 'plain string output', 'string tool_response');
});

test('normalizeToolOutput falls back to tool_output for backward compat', () => {
  const result = normalizeToolOutput({ tool_output: 'legacy output' });
  assertEqual(result, 'legacy output', 'tool_output fallback');
});

test('normalizeToolOutput prefers tool_response over tool_output', () => {
  const result = normalizeToolOutput({
    tool_response: { stdout: 'from response' },
    tool_output: 'from output'
  });
  assertEqual(result, 'from response', 'tool_response takes priority');
});

test('normalizeToolOutput returns empty string when neither present', () => {
  const result = normalizeToolOutput({ tool_name: 'Bash' });
  assertEqual(result, '', 'empty when no output fields');
});

test('normalizeToolOutput JSON-stringifies non-stdout response objects', () => {
  const result = normalizeToolOutput({
    tool_response: { filePath: '/a/b.ts', oldString: 'x', newString: 'y' }
  });
  assert(result.includes('filePath'), 'should contain filePath key');
  assert(result.includes('/a/b.ts'), 'should contain path value');
});

test('normalizeToolOutput handles null tool_response gracefully', () => {
  const result = normalizeToolOutput({ tool_response: null });
  assertEqual(result, '', 'null tool_response → empty');
});

test('normalizeToolOutput handles stderr-only response', () => {
  const result = normalizeToolOutput({
    tool_response: { stdout: '', stderr: 'error: something failed' }
  });
  assertEqual(result, 'error: something failed', 'stderr-only');
});

// ============================================================
// Suite: session-end task cleanup (failAllInProgressTasks)
// ============================================================

const taskEngine = require(path.join(DIST, 'task-engine.js'));
const state = require(path.join(DIST, 'state.js'));

suite('session-end task cleanup — failAllInProgressTasks', () => {

  test('failAllInProgressTasks marks all in_progress tasks as failed', () => {
    const testCwd = path.join(TEMP_ROOT, 'cleanup-test-1');
    const tasksDir = path.join(testCwd, '.oh-my-link', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });

    // Create 3 tasks: 1 pending, 1 in_progress, 1 done
    taskEngine.createTask(testCwd, {
      link_id: 'task-pending',
      title: 'Pending task',
      status: 'pending',
      assigned_to: 'worker-1',
      depends_on: [],
      files: [],
    });
    taskEngine.createTask(testCwd, {
      link_id: 'task-ip-1',
      title: 'In progress 1',
      status: 'in_progress',
      assigned_to: 'worker-1',
      depends_on: [],
      files: [],
      claimed_at: new Date().toISOString(),
    });
    taskEngine.createTask(testCwd, {
      link_id: 'task-ip-2',
      title: 'In progress 2',
      status: 'in_progress',
      assigned_to: 'worker-2',
      depends_on: [],
      files: [],
      claimed_at: new Date().toISOString(),
    });
    taskEngine.createTask(testCwd, {
      link_id: 'task-done',
      title: 'Done task',
      status: 'done',
      assigned_to: 'worker-1',
      depends_on: [],
      files: [],
      completed_at: new Date().toISOString(),
    });

    const count = taskEngine.failAllInProgressTasks(testCwd, 'session terminated');
    assertEqual(count, 2, 'should fail 2 in-progress tasks');

    // Verify states
    const t1 = taskEngine.readTask(testCwd, 'task-ip-1');
    assertEqual(t1.status, 'failed', 'task-ip-1 should be failed');
    assert(t1.completion_report.includes('session terminated'), 'should contain reason');

    const t2 = taskEngine.readTask(testCwd, 'task-ip-2');
    assertEqual(t2.status, 'failed', 'task-ip-2 should be failed');

    // Pending and done should be unchanged
    const tp = taskEngine.readTask(testCwd, 'task-pending');
    assertEqual(tp.status, 'pending', 'pending task should remain pending');

    const td = taskEngine.readTask(testCwd, 'task-done');
    assertEqual(td.status, 'done', 'done task should remain done');
  });

  test('failAllInProgressTasks returns 0 when no in-progress tasks', () => {
    const testCwd = path.join(TEMP_ROOT, 'cleanup-test-2');
    const tasksDir = path.join(testCwd, '.oh-my-link', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });

    taskEngine.createTask(testCwd, {
      link_id: 'task-p1',
      title: 'Pending',
      status: 'pending',
      assigned_to: '',
      depends_on: [],
      files: [],
    });

    const count = taskEngine.failAllInProgressTasks(testCwd, 'test reason');
    assertEqual(count, 0, 'should return 0 when no in-progress tasks');
  });

  test('failAllInProgressTasks returns 0 when tasks dir does not exist', () => {
    const testCwd = path.join(TEMP_ROOT, 'cleanup-test-nonexistent');
    // Don't create tasks dir
    const count = taskEngine.failAllInProgressTasks(testCwd, 'test reason');
    assertEqual(count, 0, 'should return 0 when no tasks dir');
  });

  test('failAllInProgressTasks sets completed_at and completion_report', () => {
    const testCwd = path.join(TEMP_ROOT, 'cleanup-test-3');
    const tasksDir = path.join(testCwd, '.oh-my-link', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });

    taskEngine.createTask(testCwd, {
      link_id: 'task-check-fields',
      title: 'Check fields',
      status: 'in_progress',
      assigned_to: 'worker-x',
      depends_on: [],
      files: [],
      claimed_at: new Date().toISOString(),
    });

    taskEngine.failAllInProgressTasks(testCwd, 'interrupted by session end');

    const task = taskEngine.readTask(testCwd, 'task-check-fields');
    assertEqual(task.status, 'failed', 'status should be failed');
    assert(task.completed_at != null, 'completed_at should be set');
    assertEqual(task.completion_report, 'interrupted by session end', 'completion_report should match reason');
  });
});

// ============================================================
// Suite: same-mode re-invoke force cleanup
// ============================================================

suite('same-mode re-invoke force cleanup', () => {

  test('force reinvoke fails both in_progress AND pending tasks', () => {
    const testCwd = path.join(TEMP_ROOT, 'force-reinvoke-1');
    const tasksDir = path.join(testCwd, '.oh-my-link', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });

    // Create tasks in various states
    taskEngine.createTask(testCwd, {
      link_id: 'fr-pending',
      title: 'Pending task',
      status: 'pending',
      assigned_to: '',
      depends_on: [],
      files: [],
    });
    taskEngine.createTask(testCwd, {
      link_id: 'fr-ip',
      title: 'In progress task',
      status: 'in_progress',
      assigned_to: 'worker-1',
      depends_on: [],
      files: [],
      claimed_at: new Date().toISOString(),
    });
    taskEngine.createTask(testCwd, {
      link_id: 'fr-done',
      title: 'Done task',
      status: 'done',
      assigned_to: 'worker-1',
      depends_on: [],
      files: [],
      completed_at: new Date().toISOString(),
    });

    // Simulate force reinvoke cleanup: fail in_progress tasks
    const failedIp = taskEngine.failAllInProgressTasks(testCwd, 'force_reinvoke: session restarted');
    assertEqual(failedIp, 1, 'should fail 1 in-progress task');

    // Also fail pending tasks (as the keyword-detector does)
    const pendingTasks = taskEngine.listTasks(testCwd, 'pending');
    for (const task of pendingTasks) {
      taskEngine.updateTaskStatus(testCwd, task.link_id, 'failed', 'force_reinvoke: session restarted');
    }

    // Verify all non-done tasks are failed
    const frPending = taskEngine.readTask(testCwd, 'fr-pending');
    assertEqual(frPending.status, 'failed', 'pending task should be failed');

    const frIp = taskEngine.readTask(testCwd, 'fr-ip');
    assertEqual(frIp.status, 'failed', 'in-progress task should be failed');

    // Done task should be untouched
    const frDone = taskEngine.readTask(testCwd, 'fr-done');
    assertEqual(frDone.status, 'done', 'done task should remain done');
  });

  test('force reinvoke with no tasks does not error', () => {
    const testCwd = path.join(TEMP_ROOT, 'force-reinvoke-empty');
    // Don't create tasks dir — should not throw
    const count = taskEngine.failAllInProgressTasks(testCwd, 'force_reinvoke');
    assertEqual(count, 0, 'should return 0 with no tasks dir');
  });
});

// ============================================================
// Suite: Integration — zombie → cleanup → re-invoke e2e flow
// ============================================================

suite('integration: zombie → cleanup → re-invoke e2e', () => {

  test('full lifecycle: session dies → zombie created → zombie cleaned → re-invoke', () => {
    const testCwd = path.join(TEMP_ROOT, 'e2e-zombie');
    const omlDir = path.join(testCwd, '.oh-my-link');
    const tasksDir = path.join(omlDir, 'tasks');
    const locksDir = path.join(omlDir, 'locks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.mkdirSync(locksDir, { recursive: true });

    // --- Phase 1: Simulate active session mid-execution ---
    const stateRoot = state.getProjectStateRoot(testCwd);
    fs.mkdirSync(stateRoot, { recursive: true });
    const sessionPath = state.getSessionPath(testCwd);

    const activeSession = {
      active: true,
      mode: 'mylink',
      current_phase: 'phase_5_execution',
      started_at: new Date(Date.now() - 60000).toISOString(),
      reinforcement_count: 5,
      failure_count: 0,
      revision_count: 0,
      locked_mode: 'mylink',
      locked_phase: 'phase_5_execution',
    };
    writeJsonAtomic(sessionPath, activeSession);

    // Create in-progress and pending tasks
    taskEngine.createTask(testCwd, {
      link_id: 'e2e-task-1',
      title: 'Implement auth module',
      status: 'in_progress',
      assigned_to: 'worker-1',
      depends_on: [],
      files: ['src/auth.ts'],
      claimed_at: new Date().toISOString(),
    });
    taskEngine.createTask(testCwd, {
      link_id: 'e2e-task-2',
      title: 'Implement routes',
      status: 'pending',
      assigned_to: '',
      depends_on: ['e2e-task-1'],
      files: ['src/routes.ts'],
    });
    taskEngine.createTask(testCwd, {
      link_id: 'e2e-task-3',
      title: 'Write tests',
      status: 'done',
      assigned_to: 'worker-1',
      depends_on: [],
      files: ['test/auth.test.ts'],
      completed_at: new Date().toISOString(),
    });

    // Create a file lock
    taskEngine.acquireLock(testCwd, 'src/auth.ts', 'worker-1', 600);
    const lockBefore = taskEngine.checkLock(testCwd, 'src/auth.ts');
    assert(lockBefore !== null, 'lock should exist before session-end');

    // --- Phase 2: Simulate session-end for critical phase ---
    // session-end sets session_ended_at but keeps active=true for critical phases
    // Also runs failAllInProgressTasks, releases locks, writes checkpoint
    const failedCount = taskEngine.failAllInProgressTasks(testCwd, 'session_end: Claude session terminated mid-execution');
    assertEqual(failedCount, 1, 'should fail 1 in-progress task');

    // Release all locks (simulating session-end behavior)
    const allLocks = taskEngine.listAllLocks(testCwd);
    for (const lock of allLocks) {
      taskEngine.releaseAllLocks(testCwd, lock.holder);
    }

    // Set session_ended_at (zombie signal)
    const zombieSession = readJson(sessionPath);
    zombieSession.session_ended_at = new Date().toISOString();
    writeJsonAtomic(sessionPath, zombieSession);

    // Write checkpoint
    const checkpointPath = state.getCheckpointPath(testCwd);
    writeJsonAtomic(checkpointPath, {
      session: { ...zombieSession },
      active_tasks: [],
      failed_tasks_count: failedCount,
      created_at: new Date().toISOString(),
      trigger: 'session_end_interrupted',
    });

    // --- Phase 3: Verify zombie state ---
    const afterSessionEnd = readJson(sessionPath);
    assertEqual(afterSessionEnd.active, true, 'session should still be active (zombie)');
    assert(afterSessionEnd.session_ended_at != null, 'session_ended_at should be set');

    // Verify tasks
    const task1 = taskEngine.readTask(testCwd, 'e2e-task-1');
    assertEqual(task1.status, 'failed', 'in-progress task should be failed');

    const task2 = taskEngine.readTask(testCwd, 'e2e-task-2');
    assertEqual(task2.status, 'pending', 'pending task should remain pending (session-end only fails in-progress)');

    const task3 = taskEngine.readTask(testCwd, 'e2e-task-3');
    assertEqual(task3.status, 'done', 'done task should remain done');

    // Verify lock released
    const lockAfter = taskEngine.checkLock(testCwd, 'src/auth.ts');
    assertEqual(lockAfter, null, 'lock should be released after session-end');

    // Verify checkpoint exists
    const checkpoint = readJson(checkpointPath);
    assert(checkpoint !== null, 'checkpoint should exist');
    assertEqual(checkpoint.trigger, 'session_end_interrupted', 'checkpoint trigger');
    assertEqual(checkpoint.failed_tasks_count, 1, 'checkpoint should record 1 failed task');

    // --- Phase 4: Simulate zombie cleanup (keyword-detector behavior) ---
    // In a new CC session, keyword-detector detects active=true + session_ended_at → deactivates
    const maybeZombie = readJson(sessionPath);
    if (maybeZombie.active && maybeZombie.session_ended_at) {
      maybeZombie.active = false;
      maybeZombie.deactivated_reason = 'zombie_cleared';
      writeJsonAtomic(sessionPath, maybeZombie);
    }

    const afterZombieCleanup = readJson(sessionPath);
    assertEqual(afterZombieCleanup.active, false, 'session should be inactive after zombie cleanup');
    assertEqual(afterZombieCleanup.deactivated_reason, 'zombie_cleared', 'deactivated_reason should be zombie_cleared');

    // --- Phase 5: Simulate force re-invoke ---
    // User types "start link force" → keyword-detector creates a fresh session
    // First, fail remaining pending tasks (force reinvoke behavior)
    const pendingTasks = taskEngine.listTasks(testCwd, 'pending');
    for (const task of pendingTasks) {
      taskEngine.updateTaskStatus(testCwd, task.link_id, 'failed', 'force_reinvoke: session restarted');
    }

    // Create fresh session
    const freshSession = {
      active: true,
      mode: 'mylink',
      current_phase: 'bootstrap',
      started_at: new Date().toISOString(),
      reinforcement_count: 0,
      failure_count: 0,
      revision_count: 0,
      locked_mode: 'mylink',
      locked_phase: 'bootstrap',
    };
    writeJsonAtomic(sessionPath, freshSession);

    // Verify fresh session
    const finalSession = readJson(sessionPath);
    assertEqual(finalSession.active, true, 'fresh session should be active');
    assertEqual(finalSession.current_phase, 'bootstrap', 'fresh session should be at bootstrap');
    assertEqual(finalSession.reinforcement_count, 0, 'fresh session should have 0 reinforcements');

    // Verify all old tasks are terminated
    const task2Final = taskEngine.readTask(testCwd, 'e2e-task-2');
    assertEqual(task2Final.status, 'failed', 'pending task should be failed after force reinvoke');

    // Summary of task states
    const summary = taskEngine.getTaskSummary(testCwd);
    assertEqual(summary.pending, 0, 'no pending tasks');
    assertEqual(summary.in_progress, 0, 'no in-progress tasks');
    assertEqual(summary.failed, 2, '2 failed tasks (1 from session-end, 1 from force reinvoke)');
    assertEqual(summary.done, 1, '1 done task (unchanged)');
  });

  test('zombie cleanup is idempotent — double cleanup does not error', () => {
    const testCwd = path.join(TEMP_ROOT, 'e2e-zombie-idempotent');
    const stateRoot = state.getProjectStateRoot(testCwd);
    fs.mkdirSync(stateRoot, { recursive: true });
    const sessionPath = state.getSessionPath(testCwd);

    // Create zombie session
    writeJsonAtomic(sessionPath, {
      active: true,
      mode: 'mylink',
      current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(),
      session_ended_at: new Date().toISOString(),
      reinforcement_count: 0,
      failure_count: 0,
      revision_count: 0,
    });

    // First cleanup
    const s1 = readJson(sessionPath);
    if (s1.active && s1.session_ended_at) {
      s1.active = false;
      s1.deactivated_reason = 'zombie_cleared';
      writeJsonAtomic(sessionPath, s1);
    }

    // Second cleanup — should be a no-op
    const s2 = readJson(sessionPath);
    if (s2.active && s2.session_ended_at) {
      s2.active = false;
      s2.deactivated_reason = 'zombie_cleared';
      writeJsonAtomic(sessionPath, s2);
    }

    const final = readJson(sessionPath);
    assertEqual(final.active, false, 'should remain inactive');
    assertEqual(final.deactivated_reason, 'zombie_cleared', 'reason should be preserved');
  });
});

// ============================================================
// Cleanup & Summary
// ============================================================

cleanupTempDirs();

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('========================================');

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
