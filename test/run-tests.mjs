/**
 * Oh-My-Link — Test Suite
 * Tests core modules: state, helpers, config, task-engine
 * Run: npm test (or node test/run-tests.mjs)
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

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-test-${Date.now()}`);
const TEMP_PROJECT = path.join(TEMP_ROOT, 'test-project');

function setupTempDirs() {
  fs.mkdirSync(TEMP_PROJECT, { recursive: true });
  // Set env to isolate runtime from real ~/.oh-my-link
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
const config = require(path.join(DIST, 'config.js'));
const taskEngine = require(path.join(DIST, 'task-engine.js'));
const projectMemory = require(path.join(DIST, 'project-memory.js'));
const promptLeverage = require(path.join(DIST, 'prompt-leverage.js'));

// ============================================================
// Tests: state.ts
// ============================================================

suite('state — path functions', () => {
  test('normalizePath converts backslashes', () => {
    assertEqual(state.normalizePath('C:\\foo\\bar'), 'C:/foo/bar', 'normalizePath');
  });

  test('normalizePath preserves forward slashes', () => {
    assertEqual(state.normalizePath('/foo/bar'), '/foo/bar', 'normalizePath forward');
  });

  test('getSystemRoot uses OML_HOME env', () => {
    const root = state.getSystemRoot();
    assert(root.includes('oml-home'), `getSystemRoot should use OML_HOME, got: ${root}`);
  });

  test('projectHash returns 8-char hex', () => {
    const hash = state.projectHash(TEMP_PROJECT);
    assertEqual(hash.length, 8, 'hash length');
    assert(/^[0-9a-f]{8}$/.test(hash), `hash should be hex: ${hash}`);
  });

  test('projectHash is deterministic', () => {
    const h1 = state.projectHash(TEMP_PROJECT);
    const h2 = state.projectHash(TEMP_PROJECT);
    assertEqual(h1, h2, 'deterministic hash');
  });

  test('projectHash differs for different paths', () => {
    const h1 = state.projectHash(TEMP_PROJECT);
    const h2 = state.projectHash(path.join(TEMP_ROOT, 'other-project'));
    assert(h1 !== h2, 'different paths should produce different hashes');
  });

  test('getProjectStateRoot includes hash', () => {
    const hash = state.projectHash(TEMP_PROJECT);
    const root = state.getProjectStateRoot(TEMP_PROJECT);
    assert(root.includes(hash), `state root should contain hash: ${root}`);
    assert(root.includes('projects'), `state root should contain "projects": ${root}`);
  });

  test('getArtifactsDir is under cwd', () => {
    const dir = state.getArtifactsDir(TEMP_PROJECT);
    assert(dir.includes('.oh-my-link'), `artifacts dir should contain .oh-my-link: ${dir}`);
  });

  test('getTasksDir is under artifacts', () => {
    const dir = state.getTasksDir(TEMP_PROJECT);
    assert(dir.includes('tasks'), `tasks dir should contain "tasks": ${dir}`);
  });

  test('getLocksDir is under artifacts', () => {
    const dir = state.getLocksDir(TEMP_PROJECT);
    assert(dir.includes('locks'), `locks dir should contain "locks": ${dir}`);
  });

  test('getSessionPath ends with session.json', () => {
    const p = state.getSessionPath(TEMP_PROJECT);
    assert(p.endsWith('session.json'), `session path should end with session.json: ${p}`);
  });

  test('ensureDir creates directory', () => {
    const testDir = path.join(TEMP_ROOT, 'ensure-test', 'nested');
    state.ensureDir(testDir);
    assert(fs.existsSync(testDir), 'directory should exist after ensureDir');
  });

  test('ensureDir is idempotent', () => {
    const testDir = path.join(TEMP_ROOT, 'ensure-test', 'nested');
    state.ensureDir(testDir); // should not throw
    assert(fs.existsSync(testDir), 'directory should still exist');
  });

  test('ensureRuntimeDirs creates state root + handoffs', () => {
    state.ensureRuntimeDirs(TEMP_PROJECT);
    const stateRoot = state.getProjectStateRoot(TEMP_PROJECT);
    assert(fs.existsSync(stateRoot), 'state root should exist');
    assert(fs.existsSync(state.getHandoffsDir(TEMP_PROJECT)), 'handoffs should exist');
  });

  test('ensureArtifactDirs creates all 6 dirs', () => {
    state.ensureArtifactDirs(TEMP_PROJECT);
    const dirs = ['plans', 'history', 'tasks', 'locks', 'skills', 'context'];
    for (const d of dirs) {
      const p = path.join(state.getArtifactsDir(TEMP_PROJECT), d);
      assert(fs.existsSync(p), `${d} directory should exist`);
    }
  });

  test('resolveStateDir returns all fields', () => {
    const res = state.resolveStateDir(TEMP_PROJECT);
    assert(res.stateDir, 'stateDir should be present');
    assert(res.artifactsDir, 'artifactsDir should be present');
    assert(res.cwd, 'cwd should be present');
    assert(res.hash, 'hash should be present');
    assertEqual(res.hash.length, 8, 'hash length in resolution');
  });
});

// ============================================================
// Tests: helpers.ts
// ============================================================

suite('helpers — readJson / writeJsonAtomic', () => {
  test('writeJsonAtomic writes valid JSON', () => {
    const filePath = path.join(TEMP_ROOT, 'test-write.json');
    helpers.writeJsonAtomic(filePath, { foo: 'bar', num: 42 });
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    assertEqual(parsed.foo, 'bar', 'writeJsonAtomic foo');
    assertEqual(parsed.num, 42, 'writeJsonAtomic num');
  });

  test('readJson reads valid JSON', () => {
    const filePath = path.join(TEMP_ROOT, 'test-read.json');
    fs.writeFileSync(filePath, JSON.stringify({ hello: 'world' }));
    const result = helpers.readJson(filePath);
    assertEqual(result.hello, 'world', 'readJson hello');
  });

  test('readJson returns null for missing file', () => {
    const result = helpers.readJson(path.join(TEMP_ROOT, 'nonexistent.json'));
    assertEqual(result, null, 'readJson missing');
  });

  test('readJson returns null for invalid JSON', () => {
    const filePath = path.join(TEMP_ROOT, 'invalid.json');
    fs.writeFileSync(filePath, '{not valid json');
    const result = helpers.readJson(filePath);
    assertEqual(result, null, 'readJson invalid');
  });

  test('writeJsonAtomic creates parent dirs', () => {
    const filePath = path.join(TEMP_ROOT, 'deep', 'nested', 'file.json');
    helpers.writeJsonAtomic(filePath, { deep: true });
    const result = helpers.readJson(filePath);
    assertEqual(result.deep, true, 'deep nested write');
  });

  test('writeJsonAtomic overwrites existing file', () => {
    const filePath = path.join(TEMP_ROOT, 'overwrite.json');
    helpers.writeJsonAtomic(filePath, { version: 1 });
    helpers.writeJsonAtomic(filePath, { version: 2 });
    const result = helpers.readJson(filePath);
    assertEqual(result.version, 2, 'overwrite');
  });
});

suite('helpers — utility functions', () => {
  test('clipText truncates long text', () => {
    const long = 'x'.repeat(5000);
    const clipped = helpers.clipText(long, 100);
    assert(clipped.length <= 150, `clipped length should be <= 150, got ${clipped.length}`);
    assert(clipped.includes('[clipped') || clipped.length <= 150, 'should include clipped marker or be within limit');
  });

  test('clipText preserves short text', () => {
    const short = 'hello';
    assertEqual(helpers.clipText(short, 100), 'hello', 'short text unchanged');
  });

  test('isTerminalPhase detects terminal phases', () => {
    assert(helpers.isTerminalPhase('complete'), 'complete is terminal');
    assert(helpers.isTerminalPhase('cancelled'), 'cancelled is terminal');
    assert(!helpers.isTerminalPhase('phase_5_execution'), 'execution is not terminal');
  });

  test('isCriticalPhase detects critical phases', () => {
    assert(helpers.isCriticalPhase('phase_5_execution'), 'execution is critical');
    assert(helpers.isCriticalPhase('phase_6_review'), 'review is critical');
    assert(helpers.isCriticalPhase('phase_6_5_full_review'), 'full review is critical');
    assert(!helpers.isCriticalPhase('bootstrap'), 'bootstrap is not critical');
  });

  test('getElapsed returns elapsed string', () => {
    const past = new Date(Date.now() - 120000).toISOString(); // 2 min ago
    const elapsed = helpers.getElapsed(past);
    assert(typeof elapsed === 'string', 'elapsed should be string');
    assert(elapsed.length > 0, 'elapsed should not be empty');
  });

  test('getCwd extracts cwd from input', () => {
    const input = { cwd: '/test/path' };
    assertEqual(helpers.getCwd(input), '/test/path', 'getCwd with cwd');
  });

  test('getCwd falls back to directory field', () => {
    const input = { directory: '/fallback/path' };
    assertEqual(helpers.getCwd(input), '/fallback/path', 'getCwd with directory');
  });
});

// ============================================================
// Tests: config.ts
// ============================================================

suite('config — model resolution', () => {
  test('getModelForRole returns default models', () => {
    const masterModel = config.getModelForRole('master');
    assert(masterModel.includes('opus'), `master should use opus, got: ${masterModel}`);
  });

  test('getModelForRole returns worker model', () => {
    const workerModel = config.getModelForRole('worker');
    assert(workerModel.includes('sonnet'), `worker should use sonnet, got: ${workerModel}`);
  });

  test('getModelForRole returns explorer model', () => {
    const explorerModel = config.getModelForRole('explorer');
    assert(explorerModel.includes('haiku'), `explorer should use haiku, got: ${explorerModel}`);
  });

  test('getModelForRole handles unknown role', () => {
    const model = config.getModelForRole('unknown-role');
    assert(typeof model === 'string' && model.length > 0, 'should return a model for unknown role');
  });
});

// ============================================================
// Tests: task-engine.ts
// ============================================================

suite('task-engine — Task CRUD', () => {
  const taskCwd = path.join(TEMP_PROJECT, 'task-crud');

  test('createTask writes task file', () => {
    const task = {
      link_id: 'link-001',
      title: 'Test task',
      description: 'A test task',
      acceptance_criteria: ['it works'],
      file_scope: ['src/foo.ts'],
      locked_decisions: ['D1'],
      depends_on: [],
      status: 'pending',
    };
    taskEngine.createTask(taskCwd, task);
    const taskPath = taskEngine.getTaskPath(taskCwd, 'link-001');
    assert(fs.existsSync(taskPath), 'task file should exist');
  });

  test('readTask returns task data', () => {
    const task = taskEngine.readTask(taskCwd, 'link-001');
    assert(task !== null, 'task should not be null');
    assertEqual(task.title, 'Test task', 'task title');
    assertEqual(task.status, 'pending', 'task status');
  });

  test('readTask returns null for missing', () => {
    const task = taskEngine.readTask(taskCwd, 'nonexistent');
    assertEqual(task, null, 'missing task');
  });

  test('updateTaskStatus changes status', () => {
    taskEngine.updateTaskStatus(taskCwd, 'link-001', 'in_progress');
    const task = taskEngine.readTask(taskCwd, 'link-001');
    assertEqual(task.status, 'in_progress', 'updated status');
    assert(task.claimed_at, 'claimed_at should be set');
  });

  test('updateTaskStatus sets completed_at on done', () => {
    taskEngine.updateTaskStatus(taskCwd, 'link-001', 'done', 'All good');
    const task = taskEngine.readTask(taskCwd, 'link-001');
    assertEqual(task.status, 'done', 'done status');
    assert(task.completed_at, 'completed_at should be set');
    assertEqual(task.completion_report, 'All good', 'completion report');
  });

  test('listTasks returns all tasks', () => {
    // Create a second task
    taskEngine.createTask(taskCwd, {
      link_id: 'link-002',
      title: 'Second task',
      description: 'Another task',
      acceptance_criteria: [],
      file_scope: [],
      locked_decisions: [],
      depends_on: ['link-001'],
      status: 'pending',
    });
    const all = taskEngine.listTasks(taskCwd);
    assertEqual(all.length, 2, 'total tasks');
  });

  test('listTasks filters by status', () => {
    const pending = taskEngine.listTasks(taskCwd, 'pending');
    assertEqual(pending.length, 1, 'pending count');
    assertEqual(pending[0].link_id, 'link-002', 'pending task id');
  });

  test('getReadyTasks respects dependencies', () => {
    // link-002 depends on link-001 (which is done) → should be ready
    const ready = taskEngine.getReadyTasks(taskCwd);
    assertEqual(ready.length, 1, 'ready count');
    assertEqual(ready[0].link_id, 'link-002', 'ready task id');
  });

  test('getReadyTasks excludes blocked tasks', () => {
    // Create link-003 that depends on link-002 (still pending) → not ready
    taskEngine.createTask(taskCwd, {
      link_id: 'link-003',
      title: 'Blocked task',
      description: 'Depends on pending',
      acceptance_criteria: [],
      file_scope: [],
      locked_decisions: [],
      depends_on: ['link-002'],
      status: 'pending',
    });
    const ready = taskEngine.getReadyTasks(taskCwd);
    // Only link-002 should be ready (link-003 blocked by link-002)
    assertEqual(ready.length, 1, 'ready count with blocked');
  });

  test('getTaskSummary returns correct counts', () => {
    const summary = taskEngine.getTaskSummary(taskCwd);
    assertEqual(summary.total, 3, 'total');
    assertEqual(summary.done, 1, 'done');
    assertEqual(summary.pending, 2, 'pending');
    assertEqual(summary.in_progress, 0, 'in_progress');
    assertEqual(summary.failed, 0, 'failed');
  });
});

suite('task-engine — File Locking', () => {
  const lockCwd = path.join(TEMP_PROJECT, 'lock-tests');

  test('getLockPath returns hashed path', () => {
    const lockPath = taskEngine.getLockPath(lockCwd, '/src/foo.ts');
    assert(lockPath.includes('locks'), `lock path should be in locks dir: ${lockPath}`);
    assert(lockPath.endsWith('.json'), 'lock path should end with .json');
  });

  test('getLockPath is deterministic', () => {
    const p1 = taskEngine.getLockPath(lockCwd, '/src/foo.ts');
    const p2 = taskEngine.getLockPath(lockCwd, '/src/foo.ts');
    assertEqual(p1, p2, 'deterministic lock path');
  });

  test('getLockPath differs for different files', () => {
    const p1 = taskEngine.getLockPath(lockCwd, '/src/foo.ts');
    const p2 = taskEngine.getLockPath(lockCwd, '/src/bar.ts');
    assert(p1 !== p2, 'different files should have different lock paths');
  });

  test('acquireLock succeeds on new lock', () => {
    const result = taskEngine.acquireLock(lockCwd, '/src/a.ts', 'worker-1');
    assertEqual(result.success, true, 'lock should succeed');
    assert(result.lock, 'lock object should be present');
    assertEqual(result.lock.holder, 'worker-1', 'holder');
  });

  test('acquireLock fails for different holder', () => {
    const result = taskEngine.acquireLock(lockCwd, '/src/a.ts', 'worker-2');
    assertEqual(result.success, false, 'should fail for different holder');
    assertEqual(result.holder, 'worker-1', 'should report current holder');
  });

  test('acquireLock refreshes TTL for same holder', () => {
    const result = taskEngine.acquireLock(lockCwd, '/src/a.ts', 'worker-1');
    assertEqual(result.success, true, 'same holder should succeed (TTL refresh)');
  });

  test('checkLock returns lock info', () => {
    const lock = taskEngine.checkLock(lockCwd, '/src/a.ts');
    assert(lock !== null, 'lock should exist');
    assertEqual(lock.holder, 'worker-1', 'check holder');
  });

  test('checkLock returns null for unlocked file', () => {
    const lock = taskEngine.checkLock(lockCwd, '/src/unlocked.ts');
    assertEqual(lock, null, 'unlocked file');
  });

  test('releaseLock releases own lock', () => {
    const released = taskEngine.releaseLock(lockCwd, '/src/a.ts', 'worker-1');
    assertEqual(released, true, 'should release');
    const lock = taskEngine.checkLock(lockCwd, '/src/a.ts');
    assertEqual(lock, null, 'lock should be gone');
  });

  test('releaseLock refuses to release others lock', () => {
    taskEngine.acquireLock(lockCwd, '/src/b.ts', 'worker-1');
    const released = taskEngine.releaseLock(lockCwd, '/src/b.ts', 'worker-2');
    assertEqual(released, false, 'should not release others lock');
  });

  test('acquireLock takes over expired lock', () => {
    // Create an already-expired lock
    const lockPath = taskEngine.getLockPath(lockCwd, '/src/expired.ts');
    state.ensureDir(path.dirname(lockPath));
    const expiredLock = {
      path: '/src/expired.ts',
      holder: 'dead-worker',
      acquired_at: new Date(Date.now() - 120000).toISOString(),
      ttl_seconds: 1,
      expires_at: new Date(Date.now() - 60000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(expiredLock));

    const result = taskEngine.acquireLock(lockCwd, '/src/expired.ts', 'new-worker');
    assertEqual(result.success, true, 'should take over expired lock');
    assertEqual(result.lock.holder, 'new-worker', 'new holder');
  });

  test('releaseAllLocks releases all by holder', () => {
    taskEngine.acquireLock(lockCwd, '/src/c.ts', 'batch-worker');
    taskEngine.acquireLock(lockCwd, '/src/d.ts', 'batch-worker');
    taskEngine.acquireLock(lockCwd, '/src/e.ts', 'batch-worker');
    const count = taskEngine.releaseAllLocks(lockCwd, 'batch-worker');
    assertEqual(count, 3, 'should release 3 locks');
  });

  test('cleanExpiredLocks removes expired locks', () => {
    // Create an expired lock
    const lockPath = taskEngine.getLockPath(lockCwd, '/src/old.ts');
    const expiredLock = {
      path: '/src/old.ts',
      holder: 'old-worker',
      acquired_at: new Date(Date.now() - 120000).toISOString(),
      ttl_seconds: 1,
      expires_at: new Date(Date.now() - 60000).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(expiredLock));

    const count = taskEngine.cleanExpiredLocks(lockCwd);
    assert(count >= 1, `should clean at least 1 expired lock, got ${count}`);
  });

  test('isLockExpired detects expired lock', () => {
    const expired = {
      path: '/src/x.ts',
      holder: 'w',
      acquired_at: new Date(Date.now() - 120000).toISOString(),
      ttl_seconds: 10,
      expires_at: new Date(Date.now() - 60000).toISOString(),
    };
    assertEqual(taskEngine.isLockExpired(expired), true, 'should be expired');
  });

  test('isLockExpired detects active lock', () => {
    const active = {
      path: '/src/x.ts',
      holder: 'w',
      acquired_at: new Date().toISOString(),
      ttl_seconds: 600,
      expires_at: new Date(Date.now() + 600000).toISOString(),
    };
    assertEqual(taskEngine.isLockExpired(active), false, 'should not be expired');
  });
});

// ============================================================
// Tests: Hook smoke tests (via child_process)
// ============================================================

import { execSync } from 'child_process';

suite('hooks — smoke tests', () => {
  const hooks = [
    { name: 'keyword-detector', input: { session_id: 'test', cwd: TEMP_PROJECT, prompt: 'hello' } },
    { name: 'session-start', input: { session_id: 'test', cwd: TEMP_PROJECT } },
    { name: 'pre-tool-enforcer', input: { session_id: 'test', cwd: TEMP_PROJECT, tool_name: 'Read', tool_input: { file_path: '/test' } } },
    { name: 'post-tool-verifier', input: { session_id: 'test', cwd: TEMP_PROJECT, tool_name: 'Read', tool_input: {}, tool_output: 'ok' } },
    { name: 'post-tool-failure', input: { session_id: 'test', cwd: TEMP_PROJECT, tool_name: 'Read', tool_input: {}, error: 'not found' } },
    { name: 'stop-handler', input: { session_id: 'test', cwd: TEMP_PROJECT } },
    { name: 'pre-compact', input: { session_id: 'test', cwd: TEMP_PROJECT } },
    { name: 'session-end', input: { session_id: 'test', cwd: TEMP_PROJECT } },
  ];

  for (const hook of hooks) {
    test(`${hook.name} exits 0 and returns valid JSON`, () => {
      const hookPath = path.join(DIST, 'hooks', `${hook.name}.js`);
      const inputStr = JSON.stringify(hook.input);
      const cmd = process.platform === 'win32'
        ? `echo ${JSON.stringify(inputStr)} | node "${hookPath}"`
        : `echo '${inputStr}' | node "${hookPath}"`;

      const output = execSync(cmd, {
        cwd: TEMP_PROJECT,
        timeout: 10000,
        env: { ...process.env, OML_HOME: process.env.OML_HOME },
      }).toString().trim();

      // Should be valid JSON (schema-compliant — no `continue` field required)
      const parsed = JSON.parse(output);
      assert(typeof parsed === 'object' && parsed !== null, `${hook.name} should output valid JSON object`);
    });
  }

  test('keyword-detector detects start link keyword', () => {
    const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');
    const inputFile = path.join(TEMP_ROOT, 'kw-startlink.json');
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT, prompt: 'start link build auth' }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;

    const output = execSync(cmd, {
      cwd: TEMP_PROJECT,
      timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME },
      shell: true,
    }).toString().trim();

    // Output is now plain text (not JSON) — promptContextOutput writes plain stdout
    assert(
      output.includes('OML START LINK'),
      'should detect start link keyword'
    );
  });

  test('keyword-detector detects start fast keyword', () => {
    const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');
    // Clean session state from previous test (start link sets active session)
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }

    const inputFile = path.join(TEMP_ROOT, 'kw-startfast.json');
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT, prompt: 'start fast fix the bug' }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;

    const output = execSync(cmd, {
      cwd: TEMP_PROJECT,
      timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME },
      shell: true,
    }).toString().trim();

    // Output is now plain text (not JSON) — promptContextOutput writes plain stdout
    assert(
      output.includes('OML START FAST'),
      'should detect start fast keyword'
    );
  });

  test('subagent-lifecycle start exits 0', () => {
    const hookPath = path.join(DIST, 'hooks', 'subagent-lifecycle.js');
    const input = JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      subagent_id: 'agent-1', subagent_type: 'worker', description: 'test'
    });
    const cmd = process.platform === 'win32'
      ? `echo ${JSON.stringify(input)} | node "${hookPath}" start`
      : `echo '${input}' | node "${hookPath}" start`;

    const output = execSync(cmd, {
      cwd: TEMP_PROJECT,
      timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME },
    }).toString().trim();

    const parsed = JSON.parse(output);
    assert(typeof parsed === 'object' && parsed !== null, 'subagent start should output valid JSON');
  });

  test('subagent-lifecycle stop exits 0', () => {
    const hookPath = path.join(DIST, 'hooks', 'subagent-lifecycle.js');
    const input = JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      subagent_id: 'agent-1', subagent_type: 'worker', result: 'success'
    });
    const cmd = process.platform === 'win32'
      ? `echo ${JSON.stringify(input)} | node "${hookPath}" stop`
      : `echo '${input}' | node "${hookPath}" stop`;

    const output = execSync(cmd, {
      cwd: TEMP_PROJECT,
      timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME },
    }).toString().trim();

    const parsed = JSON.parse(output);
    assert(typeof parsed === 'object' && parsed !== null, 'subagent stop should output valid JSON');
  });
});

suite('project-memory — core functions', () => {
  const memCwd = path.join(TEMP_PROJECT, 'mem-test');

  test('loadMemory returns empty default for new project', () => {
    const memory = projectMemory.loadMemory(memCwd);
    assertDeepEqual(memory.hot_paths, [], 'hot_paths empty');
    assertDeepEqual(memory.user_directives, [], 'directives empty');
    assertDeepEqual(memory.notes, [], 'notes empty');
  });

  test('recordHotPath adds new entry', () => {
    const memory = projectMemory.loadMemory(memCwd);
    projectMemory.recordHotPath(memory, 'src/app.ts');
    assertEqual(memory.hot_paths.length, 1, 'one hot path');
    assertEqual(memory.hot_paths[0].path, 'src/app.ts', 'path matches');
    assertEqual(memory.hot_paths[0].access_count, 1, 'count is 1');
  });

  test('recordHotPath increments existing', () => {
    const memory = projectMemory.loadMemory(memCwd);
    projectMemory.recordHotPath(memory, 'src/app.ts');
    projectMemory.recordHotPath(memory, 'src/app.ts');
    projectMemory.recordHotPath(memory, 'src/app.ts');
    const entry = memory.hot_paths.find(h => h.path === 'src/app.ts');
    assertEqual(entry.access_count, 3, 'count incremented to 3');
  });

  test('recordHotPath sorts by access count', () => {
    const memory = { tech_stack: {}, hot_paths: [], user_directives: [], notes: [], last_scanned_at: '' };
    projectMemory.recordHotPath(memory, 'a.ts');
    projectMemory.recordHotPath(memory, 'b.ts');
    projectMemory.recordHotPath(memory, 'b.ts');
    projectMemory.recordHotPath(memory, 'b.ts');
    assertEqual(memory.hot_paths[0].path, 'b.ts', 'highest count first');
  });

  test('recordHotPath caps at 50 entries', () => {
    const memory = { tech_stack: {}, hot_paths: [], user_directives: [], notes: [], last_scanned_at: '' };
    for (let i = 0; i < 60; i++) {
      projectMemory.recordHotPath(memory, `file-${i}.ts`);
    }
    assert(memory.hot_paths.length <= 50, `capped at 50, got ${memory.hot_paths.length}`);
  });

  test('addDirective adds new directive', () => {
    const memory = { tech_stack: {}, hot_paths: [], user_directives: [], notes: [], last_scanned_at: '' };
    projectMemory.addDirective(memory, 'always use TypeScript', 'normal');
    assertEqual(memory.user_directives.length, 1, 'one directive');
    assertEqual(memory.user_directives[0].directive, 'always use TypeScript', 'directive text');
    assertEqual(memory.user_directives[0].priority, 'normal', 'priority');
  });

  test('addDirective deduplicates', () => {
    const memory = { tech_stack: {}, hot_paths: [], user_directives: [], notes: [], last_scanned_at: '' };
    projectMemory.addDirective(memory, 'always use TypeScript', 'normal');
    projectMemory.addDirective(memory, 'always use TypeScript', 'normal');
    assertEqual(memory.user_directives.length, 1, 'still one directive');
  });

  test('addDirective caps at 20', () => {
    const memory = { tech_stack: {}, hot_paths: [], user_directives: [], notes: [], last_scanned_at: '' };
    for (let i = 0; i < 25; i++) {
      projectMemory.addDirective(memory, `directive ${i}`, 'normal');
    }
    assert(memory.user_directives.length <= 20, `capped at 20, got ${memory.user_directives.length}`);
  });

  test('saveMemory and loadMemory round-trip', () => {
    state.ensureDir(state.getProjectStateRoot(memCwd));
    const memory = {
      tech_stack: { runtime: 'node', language: 'typescript' },
      hot_paths: [{ path: 'src/index.ts', access_count: 5 }],
      user_directives: [{ directive: 'always use pnpm', priority: 'high', added_at: new Date().toISOString() }],
      notes: ['test note'],
      last_scanned_at: new Date().toISOString(),
    };
    projectMemory.saveMemory(memCwd, memory);
    const loaded = projectMemory.loadMemory(memCwd);
    assertEqual(loaded.tech_stack.runtime, 'node', 'round-trip tech_stack');
    assertEqual(loaded.hot_paths[0].path, 'src/index.ts', 'round-trip hot_paths');
    assertEqual(loaded.user_directives[0].directive, 'always use pnpm', 'round-trip directives');
  });

  test('needsRescan returns true for empty last_scanned_at', () => {
    const memory = { tech_stack: {}, hot_paths: [], user_directives: [], notes: [], last_scanned_at: '' };
    assertEqual(projectMemory.needsRescan(memory), true, 'needs rescan');
  });

  test('needsRescan returns false for recent scan', () => {
    const memory = { tech_stack: {}, hot_paths: [], user_directives: [], notes: [], last_scanned_at: new Date().toISOString() };
    assertEqual(projectMemory.needsRescan(memory), false, 'no rescan needed');
  });

  test('needsRescan returns true for old scan', () => {
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const memory = { tech_stack: {}, hot_paths: [], user_directives: [], notes: [], last_scanned_at: oldDate };
    assertEqual(projectMemory.needsRescan(memory), true, 'needs rescan after 25h');
  });

  test('formatSummary produces string', () => {
    const memory = {
      tech_stack: { runtime: 'node', framework: 'react' },
      hot_paths: [{ path: 'src/App.tsx', access_count: 10 }],
      user_directives: [{ directive: 'always test', priority: 'high', added_at: new Date().toISOString() }],
      notes: [],
      last_scanned_at: new Date().toISOString(),
    };
    const summary = projectMemory.formatSummary(memory);
    assert(typeof summary === 'string', 'summary is string');
    assert(summary.includes('node'), 'includes tech stack');
    assert(summary.includes('App.tsx'), 'includes hot path');
  });

  test('formatSummary respects budget', () => {
    const memory = {
      tech_stack: { runtime: 'node' },
      hot_paths: [],
      user_directives: [],
      notes: [],
      last_scanned_at: '',
    };
    const summary = projectMemory.formatSummary(memory, 20);
    assert(summary.length <= 23, `budget respected, got ${summary.length}`);
  });

  test('detectProjectEnv detects node project', () => {
    const projDir = path.join(TEMP_ROOT, 'detect-test');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'package.json'), JSON.stringify({
      dependencies: { typescript: '^5.0.0', react: '^18.0.0' },
    }));
    const stack = projectMemory.detectProjectEnv(projDir);
    assertEqual(stack.runtime, 'node', 'detects node');
    assertEqual(stack.language, 'typescript', 'detects typescript');
    assertEqual(stack.framework, 'react', 'detects react');
  });

  test('addNote adds and deduplicates', () => {
    const memory = { tech_stack: {}, hot_paths: [], user_directives: [], notes: [], last_scanned_at: '' };
    projectMemory.addNote(memory, 'important note');
    projectMemory.addNote(memory, 'important note');
    assertEqual(memory.notes.length, 1, 'deduped to 1');
  });
});

suite('prompt-leverage — framework generation', () => {
  test('detectTaskType detects bugfix', () => {
    const result = promptLeverage.detectTaskType('fix the login bug');
    assertEqual(result.type, 'bugfix', 'bugfix type');
  });

  test('detectTaskType detects feature', () => {
    const result = promptLeverage.detectTaskType('add a new dashboard component');
    assertEqual(result.type, 'feature', 'feature type');
  });

  test('detectTaskType detects security', () => {
    const result = promptLeverage.detectTaskType('check the security permissions on the endpoint');
    assertEqual(result.type, 'security', 'security type');
  });

  test('detectTaskType defaults to general', () => {
    const result = promptLeverage.detectTaskType('hello world');
    assertEqual(result.type, 'general', 'general type');
  });

  test('generateFramework returns constraints and criteria', () => {
    const fw = promptLeverage.generateFramework('fix the login bug');
    assert(Array.isArray(fw.constraints), 'constraints is array');
    assert(Array.isArray(fw.success_criteria), 'success_criteria is array');
    assert(fw.constraints.length > 0, 'has constraints');
    assert(fw.success_criteria.length > 0, 'has criteria');
  });

  test('generateFramework caps intensity for mylight', () => {
    const fw = promptLeverage.generateFramework('build a new security auth system', 'mylight');
    assert(fw.intensity !== 'critical' && fw.intensity !== 'heavy', `intensity capped for mylight, got ${fw.intensity}`);
  });

  test('formatFramework produces string', () => {
    const fw = promptLeverage.generateFramework('refactor the database layer');
    const text = promptLeverage.formatFramework(fw);
    assert(typeof text === 'string', 'formatted is string');
    assert(text.length > 0, 'formatted is non-empty');
  });
});

suite('keyword-detector — sanitization and augmentation', () => {
  test('keyword-detector sanitizes code blocks before matching', () => {
    const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');
    try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
    const inputFile = path.join(TEMP_ROOT, 'kw-sanitize.json');
    fs.writeFileSync(inputFile, JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      prompt: 'Here is some code:\n```\nstart link build auth\n```\nWhat does it do?'
    }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('MAGIC KEYWORD'), 'should not trigger on code block content');
  });

  test('keyword-detector augments invoke prompt with framework', () => {
    const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');
    try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
    const inputFile = path.join(TEMP_ROOT, 'kw-augment.json');
    fs.writeFileSync(inputFile, JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      prompt: 'start link fix the authentication bug in login.ts'
    }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    // Output is now plain text (not JSON) — promptContextOutput writes plain stdout
    assert(output.includes('OML START LINK'), 'keyword detected');
    assert(
      output.includes('Scout') || output.includes('Agent tool') || output.includes('orchestrator'),
      'should include orchestration instructions'
    );
  });

  test('keyword-detector saves directives to project memory', () => {
    const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');
    try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
    const inputFile = path.join(TEMP_ROOT, 'kw-directive.json');
    fs.writeFileSync(inputFile, JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      prompt: 'always use pnpm instead of npm. start link build the API'
    }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    });
    const memory = projectMemory.loadMemory(TEMP_PROJECT);
    const found = memory.user_directives.some(d => d.directive.includes('always use pnpm'));
    assert(found, 'directive should be saved to project memory');
  });

  test('keyword-detector skips subagent role', () => {
    const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');
    try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
    const inputFile = path.join(TEMP_ROOT, 'kw-subagent.json');
    fs.writeFileSync(inputFile, JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      prompt: 'start link build the auth system'
    }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME, OML_AGENT_ROLE: 'worker' }, shell: true,
    }).toString().trim();
    const parsed = JSON.parse(output);
    const ctx = parsed.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('MAGIC KEYWORD'), 'should not trigger for subagent worker');
  });
});

suite('stop-handler — phase continuations', () => {
  test('stop-handler blocks with phase-specific guidance', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(sessionPath));
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
    const hookPath = path.join(DIST, 'hooks', 'stop-handler.js');
    const inputFile = path.join(TEMP_ROOT, 'stop-phase.json');
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    const parsed = JSON.parse(output);
    assert(parsed.decision === 'block', 'should block stop');
    assert(parsed.reason.includes('Workers are implementing'), 'should include phase_5 continuation');
    assert(parsed.reason.includes('START LINK'), 'should include mode label');
  });

  test('stop-handler allows stop for terminal phase', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'complete',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
    const hookPath = path.join(DIST, 'hooks', 'stop-handler.js');
    const inputFile = path.join(TEMP_ROOT, 'stop-terminal.json');
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    const parsed = JSON.parse(output);
    assert(!parsed.decision || parsed.decision !== 'block', 'should allow stop for terminal phase');
  });

  test('stop-handler respects cancel signal with expires_at', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
    const cancelPath = state.getCancelSignalPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(cancelPath, {
      cancelled_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30000).toISOString(),
    });
    const hookPath = path.join(DIST, 'hooks', 'stop-handler.js');
    const inputFile = path.join(TEMP_ROOT, 'stop-cancel.json');
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    const parsed = JSON.parse(output);
    assert(!parsed.decision || parsed.decision !== 'block', 'should allow stop with cancel signal');
  });

  test('stop-handler blocks for Start Fast phases', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylight', current_phase: 'light_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
    const hookPath = path.join(DIST, 'hooks', 'stop-handler.js');
    const inputFile = path.join(TEMP_ROOT, 'stop-fast.json');
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    const parsed = JSON.parse(output);
    assert(parsed.decision === 'block', 'should block stop for light_execution');
    assert(parsed.reason.includes('START FAST'), 'should include Start Fast label');
    assert(parsed.reason.includes('Executor is implementing'), 'should include light_execution continuation');
  });
});

suite('pre-tool-enforcer — camelCase path support', () => {
  test('pre-tool-enforcer allows filePath (camelCase) for worker role', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
    const hookPath = path.join(DIST, 'hooks', 'pre-tool-enforcer.js');
    const inputFile = path.join(TEMP_ROOT, 'pre-tool-camel.json');
    fs.writeFileSync(inputFile, JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      tool_name: 'Edit',
      tool_input: { filePath: '/test/src/app.ts', old_string: 'a', new_string: 'b' },
    }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME, OML_AGENT_ROLE: 'worker' }, shell: true,
    }).toString().trim();
    const parsed = JSON.parse(output);
    const denied = parsed.hookSpecificOutput?.permissionDecision === 'deny';
    assert(!denied, 'worker should be allowed to Edit with camelCase filePath');
  });

  test('pre-tool-enforcer blocks scout from Edit', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_1_scout',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
    const hookPath = path.join(DIST, 'hooks', 'pre-tool-enforcer.js');
    const inputFile = path.join(TEMP_ROOT, 'pre-tool-scout.json');
    fs.writeFileSync(inputFile, JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      tool_name: 'Edit',
      tool_input: { filePath: '/test/src/app.ts' },
    }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME, OML_AGENT_ROLE: 'scout' }, shell: true,
    }).toString().trim();
    const parsed = JSON.parse(output);
    const denied = parsed.hookSpecificOutput?.permissionDecision === 'deny';
    assert(denied, 'scout should be blocked from Edit');
  });
});

suite('post-tool-verifier — hot paths and feedback', () => {
  test('post-tool-verifier tracks hot paths for Read tool', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
    const memPath = state.getProjectMemoryPath(TEMP_PROJECT);
    try { fs.unlinkSync(memPath); } catch {}

    const hookPath = path.join(DIST, 'hooks', 'post-tool-verifier.js');
    const inputFile = path.join(TEMP_ROOT, 'post-hot.json');
    fs.writeFileSync(inputFile, JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      tool_name: 'Read', tool_input: { file_path: 'src/important.ts' }, tool_output: 'file content here',
    }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    });
    const memory = projectMemory.loadMemory(TEMP_PROJECT);
    const found = memory.hot_paths.some(h => h.path === 'src/important.ts');
    assert(found, 'hot path should be tracked for Read tool');
  });

  test('post-tool-verifier processes skill-feedback tags', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
    const feedbackPath = path.join(state.getProjectStateRoot(TEMP_PROJECT), 'skill-feedback.json');
    try { fs.unlinkSync(feedbackPath); } catch {}

    const hookPath = path.join(DIST, 'hooks', 'post-tool-verifier.js');
    const inputFile = path.join(TEMP_ROOT, 'post-feedback.json');
    fs.writeFileSync(inputFile, JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      tool_name: 'Bash', tool_input: { command: 'echo test' },
      tool_output: 'result <skill-feedback name="bad-skill" useful="false">not helpful</skill-feedback>',
    }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    });
    const feedback = helpers.readJson(feedbackPath);
    assert(feedback !== null, 'feedback file should exist');
    assert(feedback['bad-skill'], 'bad-skill feedback should be recorded');
    assertEqual(feedback['bad-skill'].negativeCount, 1, 'negative count');
    assertEqual(feedback['bad-skill'].reason, 'not helpful', 'reason');
  });

  test('post-tool-verifier supports filePath (camelCase) in Edit', () => {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
    const memPath = state.getProjectMemoryPath(TEMP_PROJECT);
    try { fs.unlinkSync(memPath); } catch {}

    const hookPath = path.join(DIST, 'hooks', 'post-tool-verifier.js');
    const inputFile = path.join(TEMP_ROOT, 'post-camel.json');
    fs.writeFileSync(inputFile, JSON.stringify({
      session_id: 'test', cwd: TEMP_PROJECT,
      tool_name: 'Edit',
      tool_input: { filePath: 'src/camel-case.ts', old_string: 'a', new_string: 'b' },
      tool_output: 'edit ok',
    }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    });
    const memory = projectMemory.loadMemory(TEMP_PROJECT);
    const found = memory.hot_paths.some(h => h.path === 'src/camel-case.ts');
    assert(found, 'hot path should be tracked for camelCase filePath');
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
