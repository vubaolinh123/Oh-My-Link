/**
 * Oh-My-Link — New Test Suite 3
 * Comprehensive integration test patterns.
 * Covers: session-end, pre-compact, task-engine messaging/graph/locks, helpers, project-memory, prompt-leverage.
 * Run: node test/new-tests-3.mjs
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// ============================================================
// Minimal test harness (same as run-tests.mjs)
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-test3-${Date.now()}`);
const TEMP_PROJECT = path.join(TEMP_ROOT, 'test-project');

function setupTempDirs() {
  fs.mkdirSync(TEMP_PROJECT, { recursive: true });
  process.env.OML_HOME = path.join(TEMP_ROOT, 'oml-home');
  fs.mkdirSync(process.env.OML_HOME, { recursive: true });
}

function cleanupTempDirs() {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch { /* best effort */ }
  delete process.env.OML_HOME;
}

// ============================================================
// Load modules under test
// ============================================================

setupTempDirs();

const state = require(path.join(DIST, 'state.js'));
const helpers = require(path.join(DIST, 'helpers.js'));
const taskEngine = require(path.join(DIST, 'task-engine.js'));
const projectMemory = require(path.join(DIST, 'project-memory.js'));
const promptLeverage = require(path.join(DIST, 'prompt-leverage.js'));

// Ensure runtime dirs exist for all tests
state.ensureRuntimeDirs(TEMP_PROJECT);
state.ensureArtifactDirs(TEMP_PROJECT);

// ============================================================
// Helper: run a hook via child_process with JSON stdin from file
// ============================================================

function runHook(hookName, input, extraEnv = {}) {
  const hookPath = path.join(DIST, 'hooks', `${hookName}.js`);
  const inputFile = path.join(TEMP_ROOT, `${hookName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const cmd = `node "${hookPath}" < "${inputFile}"`;
  const output = execSync(cmd, {
    cwd: TEMP_PROJECT,
    timeout: 10000,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, ...extraEnv },
    shell: true,
  }).toString().trim();
  return JSON.parse(output);
}

// ============================================================
// Suite 1: session-end — critical phase handling
// ============================================================

suite('session-end — critical phase handling', () => {
  test('preserves active session for phase_5_execution', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(sessionPath));
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });

    const hookPath = path.join(DIST, 'hooks', 'session-end.js');
    const inputFile = path.join(TEMP_ROOT, 'session-end-exec.json');
    fs.writeFileSync(inputFile, JSON.stringify({ hook: 'SessionEnd', session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, { cwd: TEMP_PROJECT, timeout: 10000, env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true });

    const session = helpers.readJson(sessionPath);
    assertEqual(session.active, true, 'session should remain active for critical phase');
    assert(session.session_ended_at, 'session_ended_at should be set');
  });

  test('preserves active session for light_turbo', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylight', current_phase: 'light_turbo',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });

    const hookPath = path.join(DIST, 'hooks', 'session-end.js');
    const inputFile = path.join(TEMP_ROOT, 'session-end-turbo.json');
    fs.writeFileSync(inputFile, JSON.stringify({ hook: 'SessionEnd', session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, { cwd: TEMP_PROJECT, timeout: 10000, env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true });

    const session = helpers.readJson(sessionPath);
    assertEqual(session.active, true, 'session should remain active for light_turbo');
    assert(session.session_ended_at, 'session_ended_at should be set');
  });

  test('deactivates phase_3_planning (non-critical)', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_3_planning',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });

    const hookPath = path.join(DIST, 'hooks', 'session-end.js');
    const inputFile = path.join(TEMP_ROOT, 'session-end-planning.json');
    fs.writeFileSync(inputFile, JSON.stringify({ hook: 'SessionEnd', session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, { cwd: TEMP_PROJECT, timeout: 10000, env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true });

    const session = helpers.readJson(sessionPath);
    assertEqual(session.active, false, 'session should be deactivated for non-critical phase');
    assertEqual(session.deactivated_reason, 'session_ended', 'deactivated_reason should be session_ended');
  });

  test('clears injected-skills.json on session end', () => {
    // Create injected-skills.json with content
    const stateRoot = state.getProjectStateRoot(TEMP_PROJECT);
    state.ensureDir(stateRoot);
    const skillsPath = state.normalizePath(path.join(stateRoot, 'injected-skills.json'));
    helpers.writeJsonAtomic(skillsPath, { skills: ['skill-a', 'skill-b'], injected_at: new Date().toISOString() });
    assert(fs.existsSync(skillsPath), 'injected-skills.json should exist before hook');

    // Also write an active non-critical session so hook runs full logic
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'bootstrap',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });

    const hookPath = path.join(DIST, 'hooks', 'session-end.js');
    const inputFile = path.join(TEMP_ROOT, 'session-end-skills.json');
    fs.writeFileSync(inputFile, JSON.stringify({ hook: 'SessionEnd', session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, { cwd: TEMP_PROJECT, timeout: 10000, env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true });

    const content = helpers.readJson(skillsPath);
    assert(content !== null, 'injected-skills.json should still exist');
    assert(content.cleared_at, 'cleared_at marker should be set');
  });
});

// ============================================================
// Suite 2: pre-compact — checkpoint writing
// ============================================================

suite('pre-compact — checkpoint writing', () => {
  test('writes checkpoint on active session', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(sessionPath));
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      feature_slug: 'auth-fix',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });

    const hookPath = path.join(DIST, 'hooks', 'pre-compact.js');
    const inputFile = path.join(TEMP_ROOT, 'pre-compact-active.json');
    fs.writeFileSync(inputFile, JSON.stringify({ hook: 'PreCompact', session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, { cwd: TEMP_PROJECT, timeout: 10000, env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true });

    const checkpointPath = state.getCheckpointPath(TEMP_PROJECT);
    assert(fs.existsSync(checkpointPath), 'checkpoint.json should exist');
    const checkpoint = helpers.readJson(checkpointPath);
    assert(checkpoint !== null, 'checkpoint should be parseable JSON');
    assert(checkpoint.session, 'checkpoint should contain session data');
    assertEqual(checkpoint.session.feature_slug, 'auth-fix', 'checkpoint session should have feature_slug');
    assertEqual(checkpoint.session.current_phase, 'phase_5_execution', 'checkpoint session phase');
  });

  test('skips checkpoint when no active session', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }

    // Delete any existing checkpoint
    const checkpointPath = state.getCheckpointPath(TEMP_PROJECT);
    try { fs.unlinkSync(checkpointPath); } catch { /* ignore */ }

    const hookPath = path.join(DIST, 'hooks', 'pre-compact.js');
    const inputFile = path.join(TEMP_ROOT, 'pre-compact-nosession.json');
    fs.writeFileSync(inputFile, JSON.stringify({ hook: 'PreCompact', session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, { cwd: TEMP_PROJECT, timeout: 10000, env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true });

    assert(!fs.existsSync(checkpointPath), 'checkpoint should not be created when no active session');
  });

  test('includes systemMessage for post-compaction', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      feature_slug: 'auth-fix',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });

    const hookPath = path.join(DIST, 'hooks', 'pre-compact.js');
    const inputFile = path.join(TEMP_ROOT, 'pre-compact-sysmsg.json');
    fs.writeFileSync(inputFile, JSON.stringify({ hook: 'PreCompact', session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, { cwd: TEMP_PROJECT, timeout: 10000, env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true }).toString().trim();

    const parsed = JSON.parse(output);
    assert(parsed.systemMessage, 'output should have systemMessage');
    assert(parsed.systemMessage.includes('POST-COMPACTION'), `systemMessage should contain POST-COMPACTION, got: ${parsed.systemMessage.slice(0, 200)}`);
  });
});

// ============================================================
// Suite 3: task-engine — messaging
// ============================================================

suite('task-engine — messaging', () => {
  // Clean message dirs before this suite
  const msgsDir = path.join(TEMP_PROJECT, '.oh-my-link', 'messages');
  try { fs.rmSync(msgsDir, { recursive: true, force: true }); } catch {}

  test('sendMessage creates message file', () => {
    const msg = taskEngine.sendMessage(TEMP_PROJECT, 'general', 'master', 'Hello workers');
    assert(msg.id, 'message should have an id');
    assertEqual(msg.thread, 'general', 'thread should be general');
    assertEqual(msg.from, 'master', 'from should be master');
    assertEqual(msg.content, 'Hello workers', 'content should match');

    // Verify file exists
    const msgDir = path.join(TEMP_PROJECT, '.oh-my-link', 'messages', 'general');
    const files = fs.readdirSync(msgDir).filter(f => f.endsWith('.json'));
    assert(files.length >= 1, 'message file should exist in general thread dir');
  });

  test('readInbox returns unacknowledged messages', () => {
    // Clean first
    const msgsDir2 = path.join(TEMP_PROJECT, '.oh-my-link', 'messages');
    try { fs.rmSync(msgsDir2, { recursive: true, force: true }); } catch {}

    taskEngine.sendMessage(TEMP_PROJECT, 'general', 'master', 'Message 1');
    // Small delay to ensure different timestamps
    const before = Date.now();
    while (Date.now() - before < 5) { /* spin */ }
    taskEngine.sendMessage(TEMP_PROJECT, 'general', 'master', 'Message 2');

    const inbox = taskEngine.readInbox(TEMP_PROJECT, 'general');
    assertEqual(inbox.length, 2, 'should have 2 unacknowledged messages');
    // Verify sorted by timestamp (ascending)
    assert(inbox[0].timestamp <= inbox[1].timestamp, 'messages should be sorted by timestamp');
  });

  test('acknowledgeMessage marks message as read', () => {
    // Clean first
    const msgsDir3 = path.join(TEMP_PROJECT, '.oh-my-link', 'messages');
    try { fs.rmSync(msgsDir3, { recursive: true, force: true }); } catch {}

    const msg = taskEngine.sendMessage(TEMP_PROJECT, 'general', 'master', 'Ack me');
    taskEngine.acknowledgeMessage(TEMP_PROJECT, 'general', msg.id);

    const inbox = taskEngine.readInbox(TEMP_PROJECT, 'general');
    assertEqual(inbox.length, 0, 'inbox should be empty after acknowledging');
  });

  test('readInbox filters by thread', () => {
    // Clean first
    const msgsDir4 = path.join(TEMP_PROJECT, '.oh-my-link', 'messages');
    try { fs.rmSync(msgsDir4, { recursive: true, force: true }); } catch {}

    taskEngine.sendMessage(TEMP_PROJECT, 'a', 'worker-1', 'Thread A msg');
    taskEngine.sendMessage(TEMP_PROJECT, 'b', 'worker-2', 'Thread B msg');

    const inboxA = taskEngine.readInbox(TEMP_PROJECT, 'a');
    const inboxB = taskEngine.readInbox(TEMP_PROJECT, 'b');
    assertEqual(inboxA.length, 1, 'thread a should have 1 message');
    assertEqual(inboxB.length, 1, 'thread b should have 1 message');
    assertEqual(inboxA[0].content, 'Thread A msg', 'thread a content');
    assertEqual(inboxB[0].content, 'Thread B msg', 'thread b content');
  });
});

// ============================================================
// Suite 4: task-engine — graph analysis
// ============================================================

suite('task-engine — graph analysis', () => {
  const graphCwd = path.join(TEMP_PROJECT, 'graph-test');

  // Clean task dirs before this suite
  const tasksDir = state.getTasksDir(graphCwd);
  const locksDir = state.getLocksDir(graphCwd);
  try { fs.rmSync(tasksDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(locksDir, { recursive: true, force: true }); } catch {}

  test('detectCycles returns null for acyclic graph', () => {
    // Clean
    try { fs.rmSync(state.getTasksDir(graphCwd), { recursive: true, force: true }); } catch {}

    taskEngine.createTask(graphCwd, {
      link_id: 'task-a', title: 'Task A', description: 'First',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: [], status: 'pending',
    });
    taskEngine.createTask(graphCwd, {
      link_id: 'task-b', title: 'Task B', description: 'Second',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: ['task-a'], status: 'pending',
    });
    taskEngine.createTask(graphCwd, {
      link_id: 'task-c', title: 'Task C', description: 'Third',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: ['task-b'], status: 'pending',
    });

    const cycles = taskEngine.detectCycles(graphCwd);
    assertEqual(cycles, null, 'acyclic graph should return null');
  });

  test('detectCycles finds cycle', () => {
    // Clean
    try { fs.rmSync(state.getTasksDir(graphCwd), { recursive: true, force: true }); } catch {}

    taskEngine.createTask(graphCwd, {
      link_id: 'cycle-a', title: 'Cycle A', description: 'Depends on B',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: ['cycle-b'], status: 'pending',
    });
    taskEngine.createTask(graphCwd, {
      link_id: 'cycle-b', title: 'Cycle B', description: 'Depends on A',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: ['cycle-a'], status: 'pending',
    });

    const cycles = taskEngine.detectCycles(graphCwd);
    assert(Array.isArray(cycles), 'should return an array for cycle');
    assert(cycles.length >= 2, `cycle should contain at least 2 elements, got ${cycles.length}`);
  });

  test('getTaskInsights finds orphaned tasks', () => {
    // Clean
    try { fs.rmSync(state.getTasksDir(graphCwd), { recursive: true, force: true }); } catch {}

    taskEngine.createTask(graphCwd, {
      link_id: 'orphan-task', title: 'Orphan Task', description: 'Depends on missing',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: ['missing-id'], status: 'pending',
    });

    const insights = taskEngine.getTaskInsights(graphCwd);
    assert(insights.orphaned.length > 0, 'should detect orphaned tasks');
    assert(insights.orphaned[0].includes('missing-id'), 'orphan message should mention missing-id');
  });

  test('claimNextTask claims first ready task', () => {
    // Clean
    try { fs.rmSync(state.getTasksDir(graphCwd), { recursive: true, force: true }); } catch {}

    taskEngine.createTask(graphCwd, {
      link_id: 'claim-a', title: 'Claim A', description: 'Ready',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: [], status: 'pending',
    });
    taskEngine.createTask(graphCwd, {
      link_id: 'claim-b', title: 'Claim B', description: 'Also ready',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: [], status: 'pending',
    });

    const claimed = taskEngine.claimNextTask(graphCwd, 'worker-1');
    assert(claimed !== null, 'should claim a task');
    assertEqual(claimed.status, 'in_progress', 'claimed task should be in_progress');
    assertEqual(claimed.assigned_to, 'worker-1', 'assigned_to should be set');
  });

  test('claimNextTask returns null when no ready tasks', () => {
    // Clean
    try { fs.rmSync(state.getTasksDir(graphCwd), { recursive: true, force: true }); } catch {}

    taskEngine.createTask(graphCwd, {
      link_id: 'blocked-dep', title: 'Blocking task', description: 'Pending',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: [], status: 'pending',
    });
    // This task depends on blocked-dep, but blocked-dep is pending (not done) so blocked
    // Actually getReadyTasks considers pending tasks with no unfinished deps as ready.
    // We need blocked-dep to still be pending (not done). The task below depends on it:
    taskEngine.createTask(graphCwd, {
      link_id: 'waiting-task', title: 'Waiting Task', description: 'Blocked by dep',
      acceptance_criteria: [], file_scope: [], locked_decisions: [],
      depends_on: ['blocked-dep'], status: 'pending',
    });

    // Claim the first ready task (blocked-dep), leaving waiting-task blocked
    taskEngine.claimNextTask(graphCwd, 'worker-1');

    // Now try again — waiting-task depends on blocked-dep which is in_progress (not done)
    const result = taskEngine.claimNextTask(graphCwd, 'worker-2');
    assertEqual(result, null, 'should return null when no ready tasks');
  });
});

// ============================================================
// Suite 5: task-engine — listAllLocks
// ============================================================

suite('task-engine — listAllLocks', () => {
  const locksCwd = path.join(TEMP_PROJECT, 'locks-list-test');

  // Clean lock dirs
  const locksDir = state.getLocksDir(locksCwd);
  try { fs.rmSync(locksDir, { recursive: true, force: true }); } catch {}

  test('listAllLocks returns active locks', () => {
    taskEngine.acquireLock(locksCwd, '/src/file1.ts', 'holder-a');
    taskEngine.acquireLock(locksCwd, '/src/file2.ts', 'holder-b');

    const locks = taskEngine.listAllLocks(locksCwd);
    assertEqual(locks.length, 2, 'should return 2 active locks');
  });

  test('listAllLocks excludes expired locks', () => {
    // Clean
    try { fs.rmSync(state.getLocksDir(locksCwd), { recursive: true, force: true }); } catch {}

    // Create a valid lock
    taskEngine.acquireLock(locksCwd, '/src/active.ts', 'holder-a');

    // Create an expired lock by directly writing JSON
    const expiredLockPath = taskEngine.getLockPath(locksCwd, '/src/expired-file.ts');
    state.ensureDir(path.dirname(expiredLockPath));
    const expiredLock = {
      path: '/src/expired-file.ts',
      holder: 'dead-worker',
      acquired_at: new Date(Date.now() - 120000).toISOString(),
      ttl_seconds: 1,
      expires_at: new Date(Date.now() - 60000).toISOString(),
    };
    fs.writeFileSync(expiredLockPath, JSON.stringify(expiredLock));

    const locks = taskEngine.listAllLocks(locksCwd);
    assertEqual(locks.length, 1, 'should exclude expired lock');
    assertEqual(locks[0].holder, 'holder-a', 'only active lock should be returned');
  });
});

// ============================================================
// Suite 6: helpers — additional coverage
// ============================================================

suite('helpers — additional coverage', () => {
  test('isTerminalPhase detects completed', () => {
    assertEqual(helpers.isTerminalPhase('completed'), true, 'completed is terminal');
  });

  test('isTerminalPhase detects failed', () => {
    assertEqual(helpers.isTerminalPhase('failed'), true, 'failed is terminal');
  });

  test('isTerminalPhase detects fast_complete', () => {
    assertEqual(helpers.isTerminalPhase('fast_complete'), true, 'fast_complete is terminal');
  });

  test('getElapsed handles invalid timestamp', () => {
    assertEqual(helpers.getElapsed('not-a-date'), '?', 'invalid timestamp should return ?');
  });

  test('getElapsed handles future timestamp', () => {
    const future = new Date(Date.now() + 60000).toISOString();
    assertEqual(helpers.getElapsed(future), '0s', 'future timestamp should return 0s');
  });

  test('isCriticalPhase detects light_execution', () => {
    assertEqual(helpers.isCriticalPhase('light_execution'), true, 'light_execution is critical');
  });
});

// ============================================================
// Suite 7: project-memory — needsRescan edge cases
// ============================================================

suite('project-memory — needsRescan edge cases', () => {
  test('needsRescan returns true for corrupt timestamp', () => {
    const result = projectMemory.needsRescan({
      last_scanned_at: 'garbage',
      tech_stack: {},
      hot_paths: [],
      user_directives: [],
      notes: [],
    });
    assertEqual(result, true, 'corrupt timestamp should trigger rescan');
  });
});

// ============================================================
// Suite 8: prompt-leverage — framework context
// ============================================================

suite('prompt-leverage — framework context', () => {
  test('formatFramework includes context line', () => {
    const framework = promptLeverage.generateFramework('fix a bug');
    const text = promptLeverage.formatFramework(framework);
    assert(typeof text === 'string', 'formatted framework should be a string');
    assert(text.includes('Task type:'), `formatted framework should include 'Task type:', got: ${text.slice(0, 200)}`);
  });
});

// ============================================================
// Cleanup & Summary
// ============================================================

cleanupTempDirs();

console.log('\n========================================');
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('========================================');

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
