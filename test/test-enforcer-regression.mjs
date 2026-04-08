/**
 * Oh-My-Link — Enforcer Regression Tests
 * Tests for dist/hooks/pre-tool-enforcer.js (regression & edge cases)
 * Run: node test/test-enforcer-regression.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-enfregr-${Date.now()}`);
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

// Load modules from DIST
const state = require(path.join(DIST, 'state.js'));
const helpers = require(path.join(DIST, 'helpers.js'));

// Ensure dirs
state.ensureDir(state.getProjectStateRoot(TEMP_PROJECT));
state.ensureDir(state.getHandoffsDir(TEMP_PROJECT));
state.ensureDir(state.getTasksDir(TEMP_PROJECT));

// ============================================================
// Helpers
// ============================================================

function writeSession(data) {
  const sessionPath = state.getSessionPath(TEMP_PROJECT);
  state.ensureDir(path.dirname(sessionPath));
  helpers.writeJsonAtomic(sessionPath, {
    active: true,
    mode: 'mylink',
    current_phase: 'phase_5_execution',
    started_at: new Date().toISOString(),
    reinforcement_count: 0,
    failure_count: 0,
    revision_count: 0,
    ...data,
  });
}

function deleteSession() {
  const sessionPath = state.getSessionPath(TEMP_PROJECT);
  try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }
}

function runEnforcer(toolName, toolInput, role, envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `enf-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({
    cwd: TEMP_PROJECT,
    tool_name: toolName,
    tool_input: toolInput,
  }));
  const cmd = `node "${path.join(DIST, 'hooks', 'pre-tool-enforcer.js')}" < "${inputFile}"`;
  const env = {
    ...process.env,
    OML_HOME: process.env.OML_HOME,
    OML_QUIET: '3',
    ...envOverrides,
  };
  if (role !== null && role !== undefined && role !== '') {
    env.OML_AGENT_ROLE = role;
  } else {
    delete env.OML_AGENT_ROLE;
  }
  return JSON.parse(execSync(cmd, {
    timeout: 10000, encoding: 'utf-8', shell: true,
    env,
  }).trim());
}

function runStopHandler(envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `stop-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ cwd: TEMP_PROJECT }));
  const cmd = `node "${path.join(DIST, 'hooks', 'stop-handler.js')}" < "${inputFile}"`;
  return JSON.parse(execSync(cmd, {
    timeout: 10000, encoding: 'utf-8', shell: true,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides },
  }).trim());
}

console.log('Oh-My-Link — Enforcer Regression Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Suite 1: Bash Safety Without Role (bug fix verification)
// ============================================================

suite('enforcer — Bash Safety Without Role', () => {
  function beforeEach() {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
  }

  test('blocks rm -rf / even without OML_AGENT_ROLE set', () => {
    beforeEach();
    const parsed = runEnforcer('Bash', { command: 'rm -rf /' }, '');
    assert(parsed.hookSpecificOutput?.permissionDecision === 'deny',
      'rm -rf / should be denied even without a role');
  });

  test('blocks DROP DATABASE without role', () => {
    beforeEach();
    const parsed = runEnforcer('Bash', { command: 'DROP DATABASE users' }, '');
    assert(parsed.hookSpecificOutput?.permissionDecision === 'deny',
      'DROP DATABASE should be denied even without a role');
  });

  test('allows normal Bash without role', () => {
    beforeEach();
    const parsed = runEnforcer('Bash', { command: 'ls -la' }, '');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'ls -la should be allowed without a role');
  });
});

// ============================================================
// Suite 2: Role Detection False Positives
// ============================================================

suite('enforcer — Role Detection False Positives', () => {
  function beforeEach() {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
  }

  test('prompt text mentioning "scout" does NOT detect caller as scout', () => {
    beforeEach();
    // Worker writes a file whose content mentions "scout" — should NOT be treated as scout
    const parsed = runEnforcer('Write', {
      file_path: 'src/scout-mention.ts',
      content: 'The scout agent analyzed the codebase and found issues.',
    }, 'worker');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'worker should NOT be blocked even when tool_input mentions "scout"');
  });

  test('OML_AGENT_ROLE takes precedence over heuristics', () => {
    beforeEach();
    // Set role to worker explicitly — worker should be able to Write
    const parsed = runEnforcer('Write', { file_path: 'src/precedence-test.ts' }, 'worker');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'worker role (via OML_AGENT_ROLE) should allow Write');
  });
});

// ============================================================
// Suite 3: Exact Tool Name Match
// ============================================================

suite('enforcer — Exact Tool Name Match', () => {
  function beforeEach() {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
  }

  test('WriteFile is NOT blocked when Write is denied (reviewer)', () => {
    beforeEach();
    // 'Write' is in the reviewer deny list, but 'WriteFile' is a different tool name
    const parsed = runEnforcer('WriteFile', { file_path: 'src/output.txt' }, 'reviewer');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'WriteFile should NOT be blocked for reviewer (only exact "Write" is denied)');
  });
});

// ============================================================
// Suite 4: Path Restriction Variants
// ============================================================

suite('enforcer — Path Restriction Variants', () => {
  function beforeEach() {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
  }

  test('architect can write to .oh-my-link/plans/plan.md', () => {
    beforeEach();
    const parsed = runEnforcer('Write', {
      file_path: '.oh-my-link/plans/plan.md',
    }, 'architect');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'architect should be allowed to write to .oh-my-link/plans/plan.md');
  });

  test('architect allowed to write to src/app.ts (role enforcement removed)', () => {
    beforeEach();
    const parsed = runEnforcer('Write', {
      file_path: 'src/app.ts',
    }, 'architect');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'architect should be allowed (role enforcement removed — now prompt-based)');
  });

  test('test-engineer can write to __tests__/foo.test.ts', () => {
    beforeEach();
    const parsed = runEnforcer('Write', {
      file_path: '__tests__/foo.test.ts',
    }, 'test-engineer');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'test-engineer should be allowed to write to __tests__/foo.test.ts');
  });

  test('test-engineer can write to path with .spec.ts', () => {
    beforeEach();
    const parsed = runEnforcer('Write', {
      file_path: 'src/components/Button.spec.ts',
    }, 'test-engineer');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'test-engineer should be allowed to write to .spec.ts files');
  });
});

// ============================================================
// Suite 5: Phase Renumbering Regression (stop-handler fix verification)
// ============================================================

suite('stop-handler — Phase Renumbering Regression', () => {
  test('stop-handler blocks during bootstrap phase', () => {
    // Create a fake in-progress task so orphan detection doesn't auto-complete
    const tasksDir = path.join(TEMP_PROJECT, '.oh-my-link', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'fake-task.json'), JSON.stringify({
      link_id: 'fake-task', title: 'Fake', status: 'in_progress',
      description: 'test', file_scope: [], acceptance_criteria: [],
    }));
    writeSession({
      active: true,
      mode: 'mylink',
      current_phase: 'bootstrap',
      reinforcement_count: 0,
    });
    const parsed = runStopHandler();
    // Clean up fake task
    try { fs.unlinkSync(path.join(tasksDir, 'fake-task.json')); } catch {}
    // bootstrap is NOT in the idle phases list, so stop-handler should block
    assertEqual(parsed.decision, 'block',
      'stop-handler should block during bootstrap phase');
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
