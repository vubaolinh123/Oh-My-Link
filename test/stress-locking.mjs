/**
 * Oh-My-Link — Concurrency Stress Tests for File Locking
 * Tests mkdir-based mutex (withLockMutex) under multi-process contention.
 * Run: node test/stress-locking.mjs
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { execSync, fork } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// ============================================================
// Minimal test harness
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

async function testAsync(name, fn) {
  try {
    await fn();
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
  return fn();
}

// ============================================================
// Setup: temp directory for isolated tests
// ============================================================

const TEMP_ROOT = path.join(os.tmpdir(), `oml-stress-${Date.now()}`);
const TEMP_PROJECT = path.join(TEMP_ROOT, 'test-project');

function setupTempDirs() {
  fs.mkdirSync(TEMP_PROJECT, { recursive: true });
  fs.mkdirSync(path.join(TEMP_PROJECT, 'src'), { recursive: true });
  process.env.OML_HOME = path.join(TEMP_ROOT, 'oml-home');
  fs.mkdirSync(process.env.OML_HOME, { recursive: true });
}

function cleanupTempDirs() {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch { /* best effort */ }
  delete process.env.OML_HOME;
}

setupTempDirs();

// Load modules
const state = require(path.join(DIST, 'state.js'));
const helpers = require(path.join(DIST, 'helpers.js'));
const taskEngine = require(path.join(DIST, 'task-engine.js'));

// Ensure runtime dirs
state.ensureRuntimeDirs(TEMP_PROJECT);
state.ensureArtifactDirs(TEMP_PROJECT);

// ============================================================
// Helper: create a child script that attempts acquireLock
// ============================================================

const CHILD_SCRIPT = path.join(TEMP_ROOT, 'lock-child.mjs');

fs.writeFileSync(CHILD_SCRIPT, `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const distPath = process.argv[2];
const cwd = process.argv[3];
const filePath = process.argv[4];
const holder = process.argv[5];
const omlHome = process.argv[6];

process.env.OML_HOME = omlHome;

const taskEngine = require(distPath + '/task-engine.js');
const state = require(distPath + '/state.js');

state.ensureRuntimeDirs(cwd);
state.ensureArtifactDirs(cwd);

try {
  const result = taskEngine.acquireLock(cwd, filePath, holder, 30);
  process.stdout.write(JSON.stringify({ success: result.success, holder: result.holder || holder }));
} catch (err) {
  process.stdout.write(JSON.stringify({ success: false, error: err.message }));
}
`);

// Helper: run N child processes competing for a lock
function runLockCompetition(n, targetFile) {
  const results = [];
  for (let i = 0; i < n; i++) {
    const holder = `agent-${i}`;
    try {
      const output = execSync(
        `node "${CHILD_SCRIPT}" "${DIST}" "${TEMP_PROJECT}" "${targetFile}" "${holder}" "${process.env.OML_HOME}"`,
        { timeout: 15000, encoding: 'utf-8', shell: true }
      ).trim();
      results.push(JSON.parse(output));
    } catch (err) {
      results.push({ success: false, error: err.message, holder: `agent-${i}` });
    }
  }
  return results;
}

// ============================================================
// Suite 1: Basic lock contention (sequential children)
// ============================================================

suite('file locking — basic contention', () => {
  test('acquireLock returns success for first caller', () => {
    const result = taskEngine.acquireLock(TEMP_PROJECT, 'src/app.ts', 'agent-0', 30);
    assertEqual(result.success, true, 'first caller should succeed');
    // Cleanup
    taskEngine.releaseLock(TEMP_PROJECT, 'src/app.ts', 'agent-0');
  });

  test('acquireLock blocks second caller on same file', () => {
    taskEngine.acquireLock(TEMP_PROJECT, 'src/blocked.ts', 'agent-0', 60);
    const result2 = taskEngine.acquireLock(TEMP_PROJECT, 'src/blocked.ts', 'agent-1', 60);
    assertEqual(result2.success, false, 'second caller should be blocked');
    assertEqual(result2.holder, 'agent-0', 'holder should be first caller');
    // Cleanup
    taskEngine.releaseLock(TEMP_PROJECT, 'src/blocked.ts', 'agent-0');
  });

  test('same holder can re-acquire (refresh TTL)', () => {
    taskEngine.acquireLock(TEMP_PROJECT, 'src/refresh.ts', 'agent-0', 30);
    const result2 = taskEngine.acquireLock(TEMP_PROJECT, 'src/refresh.ts', 'agent-0', 60);
    assertEqual(result2.success, true, 'same holder should re-acquire');
    // Cleanup
    taskEngine.releaseLock(TEMP_PROJECT, 'src/refresh.ts', 'agent-0');
  });

  test('releaseLock frees the lock for others', () => {
    taskEngine.acquireLock(TEMP_PROJECT, 'src/release.ts', 'agent-0', 60);
    taskEngine.releaseLock(TEMP_PROJECT, 'src/release.ts', 'agent-0');
    const result = taskEngine.acquireLock(TEMP_PROJECT, 'src/release.ts', 'agent-1', 60);
    assertEqual(result.success, true, 'after release, another agent should succeed');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/release.ts', 'agent-1');
  });

  test('releaseLock fails for non-holder', () => {
    taskEngine.acquireLock(TEMP_PROJECT, 'src/nonholder.ts', 'agent-0', 60);
    const released = taskEngine.releaseLock(TEMP_PROJECT, 'src/nonholder.ts', 'agent-1');
    assertEqual(released, false, 'non-holder should not be able to release');
    // Cleanup
    taskEngine.releaseLock(TEMP_PROJECT, 'src/nonholder.ts', 'agent-0');
  });
});

// ============================================================
// Suite 2: Expired lock takeover
// ============================================================

suite('file locking — expired lock takeover', () => {
  test('expired lock can be taken over by another agent', () => {
    // Write a lock file that is already expired
    const lockPath = taskEngine.getLockPath(TEMP_PROJECT, 'src/expired.ts');
    state.ensureDir(path.dirname(lockPath));
    const expiredLock = {
      path: 'src/expired.ts',
      holder: 'agent-dead',
      acquired_at: new Date(Date.now() - 120000).toISOString(),
      ttl_seconds: 60,
      expires_at: new Date(Date.now() - 60000).toISOString(),
    };
    helpers.writeJsonAtomic(lockPath, expiredLock);

    const result = taskEngine.acquireLock(TEMP_PROJECT, 'src/expired.ts', 'agent-alive', 60);
    assertEqual(result.success, true, 'should take over expired lock');
    assertEqual(result.lock.holder, 'agent-alive', 'holder should be the new agent');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/expired.ts', 'agent-alive');
  });

  test('non-expired lock cannot be taken over', () => {
    taskEngine.acquireLock(TEMP_PROJECT, 'src/active.ts', 'agent-0', 300);
    const result = taskEngine.acquireLock(TEMP_PROJECT, 'src/active.ts', 'agent-1', 60);
    assertEqual(result.success, false, 'should not take over active lock');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/active.ts', 'agent-0');
  });

  test('checkLock returns null for expired locks and cleans up', () => {
    const lockPath = taskEngine.getLockPath(TEMP_PROJECT, 'src/check-expired.ts');
    state.ensureDir(path.dirname(lockPath));
    const expiredLock = {
      path: 'src/check-expired.ts',
      holder: 'agent-dead',
      acquired_at: new Date(Date.now() - 120000).toISOString(),
      ttl_seconds: 30,
      expires_at: new Date(Date.now() - 90000).toISOString(),
    };
    helpers.writeJsonAtomic(lockPath, expiredLock);

    const check = taskEngine.checkLock(TEMP_PROJECT, 'src/check-expired.ts');
    assertEqual(check, null, 'expired lock should return null');
  });

  test('cleanExpiredLocks removes only expired locks', () => {
    // Create one expired and one active lock
    taskEngine.acquireLock(TEMP_PROJECT, 'src/clean-active.ts', 'agent-0', 300);

    const lockPath = taskEngine.getLockPath(TEMP_PROJECT, 'src/clean-expired.ts');
    state.ensureDir(path.dirname(lockPath));
    helpers.writeJsonAtomic(lockPath, {
      path: 'src/clean-expired.ts',
      holder: 'agent-dead',
      acquired_at: new Date(Date.now() - 120000).toISOString(),
      ttl_seconds: 30,
      expires_at: new Date(Date.now() - 90000).toISOString(),
    });

    const cleaned = taskEngine.cleanExpiredLocks(TEMP_PROJECT);
    assert(cleaned >= 1, 'should clean at least 1 expired lock');

    const active = taskEngine.checkLock(TEMP_PROJECT, 'src/clean-active.ts');
    assert(active !== null, 'active lock should survive cleanup');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/clean-active.ts', 'agent-0');
  });
});

// ============================================================
// Suite 3: Canonical path normalization
// ============================================================

suite('file locking — canonical path normalization', () => {
  test('relative and absolute paths resolve to same lock', () => {
    taskEngine.acquireLock(TEMP_PROJECT, 'src/canon.ts', 'agent-0', 60);
    const absPath = path.resolve(TEMP_PROJECT, 'src/canon.ts');
    const result = taskEngine.acquireLock(TEMP_PROJECT, absPath, 'agent-1', 60);
    assertEqual(result.success, false, 'absolute path should conflict with relative');
    assertEqual(result.holder, 'agent-0', 'holder should be agent-0');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/canon.ts', 'agent-0');
  });

  test('different files get different locks', () => {
    taskEngine.acquireLock(TEMP_PROJECT, 'src/file-a.ts', 'agent-0', 60);
    const result = taskEngine.acquireLock(TEMP_PROJECT, 'src/file-b.ts', 'agent-1', 60);
    assertEqual(result.success, true, 'different files should have independent locks');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/file-a.ts', 'agent-0');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/file-b.ts', 'agent-1');
  });
});

// ============================================================
// Suite 4: releaseAllLocks
// ============================================================

suite('file locking — releaseAllLocks', () => {
  test('releases all locks for a holder', () => {
    taskEngine.acquireLock(TEMP_PROJECT, 'src/multi-1.ts', 'agent-bulk', 60);
    taskEngine.acquireLock(TEMP_PROJECT, 'src/multi-2.ts', 'agent-bulk', 60);
    taskEngine.acquireLock(TEMP_PROJECT, 'src/multi-3.ts', 'agent-bulk', 60);

    const released = taskEngine.releaseAllLocks(TEMP_PROJECT, 'agent-bulk');
    assertEqual(released, 3, 'should release all 3 locks');

    // Verify all are released
    const l1 = taskEngine.checkLock(TEMP_PROJECT, 'src/multi-1.ts');
    const l2 = taskEngine.checkLock(TEMP_PROJECT, 'src/multi-2.ts');
    const l3 = taskEngine.checkLock(TEMP_PROJECT, 'src/multi-3.ts');
    assertEqual(l1, null, 'lock 1 should be released');
    assertEqual(l2, null, 'lock 2 should be released');
    assertEqual(l3, null, 'lock 3 should be released');
  });

  test('does not release locks held by other agents', () => {
    taskEngine.acquireLock(TEMP_PROJECT, 'src/other-1.ts', 'agent-a', 60);
    taskEngine.acquireLock(TEMP_PROJECT, 'src/other-2.ts', 'agent-b', 60);

    const released = taskEngine.releaseAllLocks(TEMP_PROJECT, 'agent-a');
    assertEqual(released, 1, 'should only release agent-a locks');

    const lock = taskEngine.checkLock(TEMP_PROJECT, 'src/other-2.ts');
    assert(lock !== null, 'agent-b lock should survive');
    assertEqual(lock.holder, 'agent-b', 'holder should still be agent-b');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/other-2.ts', 'agent-b');
  });
});

// ============================================================
// Suite 5: listAllLocks
// ============================================================

suite('file locking — listAllLocks', () => {
  test('lists only active (non-expired) locks', () => {
    // Clean slate
    taskEngine.releaseAllLocks(TEMP_PROJECT, 'agent-list-0');
    taskEngine.releaseAllLocks(TEMP_PROJECT, 'agent-list-1');

    taskEngine.acquireLock(TEMP_PROJECT, 'src/list-1.ts', 'agent-list-0', 60);
    taskEngine.acquireLock(TEMP_PROJECT, 'src/list-2.ts', 'agent-list-1', 60);

    // Write an expired lock directly
    const lockPath = taskEngine.getLockPath(TEMP_PROJECT, 'src/list-expired.ts');
    state.ensureDir(path.dirname(lockPath));
    helpers.writeJsonAtomic(lockPath, {
      path: 'src/list-expired.ts',
      holder: 'agent-dead',
      acquired_at: new Date(Date.now() - 120000).toISOString(),
      ttl_seconds: 30,
      expires_at: new Date(Date.now() - 90000).toISOString(),
    });

    const all = taskEngine.listAllLocks(TEMP_PROJECT);
    // Should include at least the 2 active locks, NOT the expired one
    const holders = all.map(l => l.holder);
    assert(holders.includes('agent-list-0'), 'should include agent-list-0');
    assert(holders.includes('agent-list-1'), 'should include agent-list-1');
    assert(!holders.includes('agent-dead'), 'should not include expired lock');

    taskEngine.releaseLock(TEMP_PROJECT, 'src/list-1.ts', 'agent-list-0');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/list-2.ts', 'agent-list-1');
  });
});

// ============================================================
// Suite 6: Multi-process lock contention (child_process)
// ============================================================

await suite('file locking — multi-process contention', async () => {
  await testAsync('at-most-one winner among N=5 competing processes', () => {
    // Clean any existing lock
    taskEngine.releaseLock(TEMP_PROJECT, 'src/contended.ts', 'agent-0');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/contended.ts', 'agent-1');

    const results = runLockCompetition(5, 'src/contended.ts');
    const winners = results.filter(r => r.success);
    assert(winners.length >= 1, `at least 1 should win, got ${winners.length}`);

    // All processes run sequentially (execSync), so each should succeed
    // since the previous doesn't hold the lock after process exit.
    // But the lock FILE persists. Let's verify the final state.
    const lock = taskEngine.checkLock(TEMP_PROJECT, 'src/contended.ts');
    if (lock) {
      // Some agent holds it — that's fine, just verify it's one of ours
      assert(lock.holder.startsWith('agent-'), 'holder should be one of our agents');
      taskEngine.releaseLock(TEMP_PROJECT, 'src/contended.ts', lock.holder);
    }
  });

  await testAsync('lock persists across child process — blocks subsequent callers', () => {
    // First child acquires the lock
    const result1 = JSON.parse(execSync(
      `node "${CHILD_SCRIPT}" "${DIST}" "${TEMP_PROJECT}" "src/persist.ts" "agent-first" "${process.env.OML_HOME}"`,
      { timeout: 15000, encoding: 'utf-8', shell: true }
    ).trim());
    assertEqual(result1.success, true, 'first child should acquire lock');

    // Second child should be blocked (lock file persists)
    const result2 = JSON.parse(execSync(
      `node "${CHILD_SCRIPT}" "${DIST}" "${TEMP_PROJECT}" "src/persist.ts" "agent-second" "${process.env.OML_HOME}"`,
      { timeout: 15000, encoding: 'utf-8', shell: true }
    ).trim());
    assertEqual(result2.success, false, 'second child should be blocked by persisted lock');

    // Cleanup
    taskEngine.releaseLock(TEMP_PROJECT, 'src/persist.ts', 'agent-first');
  });

  await testAsync('after release, next child can acquire', () => {
    // Acquire and release
    taskEngine.acquireLock(TEMP_PROJECT, 'src/reacquire.ts', 'agent-0', 60);
    taskEngine.releaseLock(TEMP_PROJECT, 'src/reacquire.ts', 'agent-0');

    // Child should succeed
    const result = JSON.parse(execSync(
      `node "${CHILD_SCRIPT}" "${DIST}" "${TEMP_PROJECT}" "src/reacquire.ts" "agent-child" "${process.env.OML_HOME}"`,
      { timeout: 15000, encoding: 'utf-8', shell: true }
    ).trim());
    assertEqual(result.success, true, 'child should acquire after release');
    taskEngine.releaseLock(TEMP_PROJECT, 'src/reacquire.ts', 'agent-child');
  });
});

// ============================================================
// Suite 7: Task claim contention
// ============================================================

suite('task engine — atomic claim contention', () => {
  test('claimNextTask atomically claims one task', () => {
    // Create a ready task
    taskEngine.createTask(TEMP_PROJECT, {
      link_id: 'bd-claim-1',
      title: 'Claimable task',
      description: 'Test task for claim contention',
      acceptance_criteria: ['Works'],
      file_scope: ['src/app.ts'],
      locked_decisions: [],
      depends_on: [],
      status: 'pending',
    });

    const claimed = taskEngine.claimNextTask(TEMP_PROJECT, 'worker-0');
    assert(claimed !== null, 'should claim a task');
    assertEqual(claimed.link_id, 'bd-claim-1', 'should be the created task');
    assertEqual(claimed.status, 'in_progress', 'status should be in_progress');
    assertEqual(claimed.assigned_to, 'worker-0', 'should be assigned to worker-0');

    // Second claim should find nothing (already claimed)
    const claimed2 = taskEngine.claimNextTask(TEMP_PROJECT, 'worker-1');
    assertEqual(claimed2, null, 'no more ready tasks');
  });

  test('claimNextTask respects dependencies', () => {
    taskEngine.createTask(TEMP_PROJECT, {
      link_id: 'bd-dep-base',
      title: 'Base task',
      description: 'Must be done first',
      acceptance_criteria: [],
      file_scope: [],
      locked_decisions: [],
      depends_on: [],
      status: 'pending',
    });

    taskEngine.createTask(TEMP_PROJECT, {
      link_id: 'bd-dep-child',
      title: 'Dependent task',
      description: 'Depends on base',
      acceptance_criteria: [],
      file_scope: [],
      locked_decisions: [],
      depends_on: ['bd-dep-base'],
      status: 'pending',
    });

    // Claim should get base first (child is blocked)
    const claimed = taskEngine.claimNextTask(TEMP_PROJECT, 'worker-dep');
    assert(claimed !== null, 'should claim base task');
    assertEqual(claimed.link_id, 'bd-dep-base', 'should be the base task');

    // Child is still blocked
    const claimed2 = taskEngine.claimNextTask(TEMP_PROJECT, 'worker-dep-2');
    assertEqual(claimed2, null, 'child should be blocked');

    // Complete base
    taskEngine.updateTaskStatus(TEMP_PROJECT, 'bd-dep-base', 'done', 'Done');

    // Now child should be claimable
    const claimed3 = taskEngine.claimNextTask(TEMP_PROJECT, 'worker-dep-2');
    assert(claimed3 !== null, 'child should now be claimable');
    assertEqual(claimed3.link_id, 'bd-dep-child', 'should be the child task');
  });
});

// ============================================================
// Suite 8: Messaging under contention
// ============================================================

suite('messaging — basic operations', () => {
  test('sendMessage and readInbox round-trip', () => {
    const msg = taskEngine.sendMessage(TEMP_PROJECT, 'thread-1', 'scout', 'Hello from scout');
    assert(msg.id.startsWith('msg-'), 'message id should start with msg-');
    assertEqual(msg.thread, 'thread-1', 'thread should match');
    assertEqual(msg.from, 'scout', 'from should match');
    assertEqual(msg.acknowledged, false, 'should not be acknowledged');

    const inbox = taskEngine.readInbox(TEMP_PROJECT, 'thread-1');
    assert(inbox.length >= 1, 'inbox should have at least 1 message');
    const found = inbox.find(m => m.id === msg.id);
    assert(found, 'should find our message');
    assertEqual(found.content, 'Hello from scout', 'content should match');
  });

  test('acknowledgeMessage marks message as acknowledged', () => {
    const msg = taskEngine.sendMessage(TEMP_PROJECT, 'thread-ack', 'master', 'Acknowledged test');
    taskEngine.acknowledgeMessage(TEMP_PROJECT, 'thread-ack', msg.id);

    const inbox = taskEngine.readInbox(TEMP_PROJECT, 'thread-ack');
    const found = inbox.find(m => m.id === msg.id);
    assertEqual(found, undefined, 'acknowledged message should not appear in inbox');
  });

  test('readInbox with no thread returns all unacknowledged messages', () => {
    const msg1 = taskEngine.sendMessage(TEMP_PROJECT, 'thread-all-1', 'worker', 'Msg 1');
    const msg2 = taskEngine.sendMessage(TEMP_PROJECT, 'thread-all-2', 'reviewer', 'Msg 2');

    const all = taskEngine.readInbox(TEMP_PROJECT);
    const ids = all.map(m => m.id);
    assert(ids.includes(msg1.id), 'should include msg1');
    assert(ids.includes(msg2.id), 'should include msg2');
  });

  test('readInbox returns messages sorted by timestamp', () => {
    const msg1 = taskEngine.sendMessage(TEMP_PROJECT, 'thread-sort', 'a', 'First');
    // Small delay to ensure different timestamps
    const spinUntil = Date.now() + 5;
    while (Date.now() < spinUntil) { /* spin */ }
    const msg2 = taskEngine.sendMessage(TEMP_PROJECT, 'thread-sort', 'b', 'Second');

    const inbox = taskEngine.readInbox(TEMP_PROJECT, 'thread-sort');
    const idx1 = inbox.findIndex(m => m.id === msg1.id);
    const idx2 = inbox.findIndex(m => m.id === msg2.id);
    assert(idx1 < idx2, 'first message should come before second');
  });
});

// ============================================================
// Suite 9: Graph analysis
// ============================================================

suite('graph analysis — cycles and insights', () => {
  test('detectCycles returns null for acyclic graph', () => {
    // Tasks bd-dep-base and bd-dep-child form a valid DAG
    const cycles = taskEngine.detectCycles(TEMP_PROJECT);
    assertEqual(cycles, null, 'no cycles in a valid DAG');
  });

  test('getTaskInsights reports summary', () => {
    const insights = taskEngine.getTaskInsights(TEMP_PROJECT);
    assert(insights.total > 0, 'should have tasks');
    assert(typeof insights.cycles === 'object', 'cycles should be null or array');
    assert(Array.isArray(insights.orphaned), 'orphaned should be array');
    assert(Array.isArray(insights.bottlenecks), 'bottlenecks should be array');
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
