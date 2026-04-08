/**
 * Oh-My-Link — Integration Hook Tests
 * Verifies each hook's I/O behavior by piping JSON to compiled hooks and checking output.
 * Run: node test/integration-hooks.mjs
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
// Minimal test harness (mirrors run-tests.mjs)
// ============================================================

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
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

function suite(name, fn) {
  console.log(`\n--- ${name} ---`);
  fn();
}

// ============================================================
// Setup: temp directory for isolated tests
// ============================================================

const TEMP_ROOT = path.join(os.tmpdir(), `oml-integ-${Date.now()}`);
const TEMP_PROJECT = path.join(TEMP_ROOT, 'test-project');
const OML_HOME = path.join(TEMP_ROOT, 'oml-home');

function setupTempDirs() {
  fs.mkdirSync(TEMP_PROJECT, { recursive: true });
  fs.mkdirSync(path.join(TEMP_PROJECT, 'src'), { recursive: true });
  fs.mkdirSync(OML_HOME, { recursive: true });
  process.env.OML_HOME = OML_HOME;
  process.env.OML_QUIET = '3';
}

function cleanupTempDirs() {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch { /* best effort */ }
  delete process.env.OML_HOME;
  delete process.env.OML_QUIET;
}

setupTempDirs();

// Load modules for state manipulation
const state = require(path.join(DIST, 'state.js'));
const helpers = require(path.join(DIST, 'helpers.js'));

// ============================================================
// Helper: run a hook and return parsed JSON output
// ============================================================

function runHook(hookName, input, extraEnv = {}) {
  const hookPath = path.join(DIST, 'hooks', `${hookName}.js`);
  const inputFile = path.join(TEMP_ROOT, `integ-${hookName}-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const cmd = `node "${hookPath}" < "${inputFile}"`;
  const output = execSync(cmd, {
    cwd: TEMP_PROJECT,
    timeout: 15000,
    env: { ...process.env, OML_HOME, OML_QUIET: '3', ...extraEnv },
    shell: true,
  }).toString().trim();
  try {
    return JSON.parse(output);
  } catch {
    // keyword-detector now outputs plain text for invoke/invoke-light
    return { continue: true, plainText: output };
  }
}

function ensureCleanSession() {
  const sessionPath = state.getSessionPath(TEMP_PROJECT);
  try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }
}

function writeSession(data) {
  const sessionPath = state.getSessionPath(TEMP_PROJECT);
  state.ensureDir(path.dirname(sessionPath));
  helpers.writeJsonAtomic(sessionPath, {
    started_at: new Date().toISOString(),
    reinforcement_count: 0,
    failure_count: 0,
    revision_count: 0,
    ...data,
  });
}

function readSession() {
  const sessionPath = state.getSessionPath(TEMP_PROJECT);
  return helpers.readJson(sessionPath);
}

console.log('Oh-My-Link Integration Hook Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);
console.log(`OML_HOME:  ${OML_HOME}`);

// ============================================================
// 1. keyword-detector (UserPromptSubmit)
// ============================================================

suite('keyword-detector — trigger and non-trigger', () => {
  test('start link prompt triggers session activation', () => {
    ensureCleanSession();
    const result = runHook('keyword-detector', {
      hook: 'UserPromptSubmit',
      prompt: 'start link fix login bug',
      cwd: TEMP_PROJECT,
    });
    // Should have continue: true (or at least not block)
    assert(result.continue !== false, 'should continue');
    // Check session.json was created
    const session = readSession();
    assert(session !== null, 'session.json should be created in state dir');
    assert(session.active === true, 'session should be active');
  });

  test('informational prompt does NOT trigger keyword', () => {
    ensureCleanSession();
    const result = runHook('keyword-detector', {
      hook: 'UserPromptSubmit',
      prompt: 'what is a closure in JS?',
      cwd: TEMP_PROJECT,
    });
    // Should return JSON but no keyword activation
    assert(typeof result === 'object', 'should return JSON object');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('MAGIC KEYWORD'), 'should NOT detect keyword for informational prompt');
    // No new active session
    const session = readSession();
    const isActive = session && session.active === true;
    assert(!isActive, 'no session should be activated for informational prompt');
  });
});

// ============================================================
// 2. session-start (SessionStart)
// ============================================================

suite('session-start — basic I/O', () => {
  test('session-start returns continue: true', () => {
    const result = runHook('session-start', {
      hook: 'SessionStart',
      session_id: 'test-sess',
      cwd: TEMP_PROJECT,
    });
    assert(typeof result === 'object', 'should return JSON object');
    // Session-start should not block
    assert(result.decision !== 'block', 'should not block session start');
  });
});

// ============================================================
// 3. pre-tool-enforcer (PreToolUse)
// ============================================================

suite('pre-tool-enforcer — no role-based enforcement (prompt-based)', () => {
  test('allows Edit without role (role enforcement removed)', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    const result = runHook('pre-tool-enforcer', {
      hook: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: {
        filePath: path.join(TEMP_PROJECT, 'src', 'app.ts'),
        old_string: 'a',
        new_string: 'b',
      },
      cwd: TEMP_PROJECT,
    });

    const denied = result.hookSpecificOutput?.permissionDecision === 'deny';
    assert(!denied, 'Edit should be allowed (role enforcement removed — now prompt-based)');
  });

  test('blocks dangerous Bash regardless of role', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    const result = runHook('pre-tool-enforcer', {
      hook: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      cwd: TEMP_PROJECT,
    });

    const denied = result.hookSpecificOutput?.permissionDecision === 'deny';
    assert(denied, 'dangerous Bash should be blocked regardless of role');
  });
});

// ============================================================
// 4. post-tool-verifier (PostToolUse)
// ============================================================

suite('post-tool-verifier — failure detection and passthrough', () => {
  test('Bash with TS error increments failure_count', () => {
    writeSession({
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      failure_count: 0,
    });
    const result = runHook('post-tool-verifier', {
      hook: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_output: "error TS2304: Cannot find name 'foo'",
      cwd: TEMP_PROJECT,
    });
    assert(typeof result === 'object', 'should return JSON object');
    // Check session failure_count was incremented
    const session = readSession();
    assert(session !== null, 'session should exist');
    assert(session.failure_count >= 1, `failure_count should be incremented, got ${session.failure_count}`);
  });

  test('Read tool output does NOT increment failure count', () => {
    writeSession({
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      failure_count: 0,
    });
    const result = runHook('post-tool-verifier', {
      hook: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(TEMP_PROJECT, 'src', 'app.ts') },
      tool_output: 'some file content',
      cwd: TEMP_PROJECT,
    });
    assert(typeof result === 'object', 'should return JSON object');
    // Check failure_count was NOT incremented
    const session = readSession();
    assert(session !== null, 'session should exist');
    assert(session.failure_count === 0, `failure_count should remain 0, got ${session.failure_count}`);
  });
});

// ============================================================
// 5. stop-handler (Stop)
// ============================================================

suite('stop-handler — phase-based blocking', () => {
  test('blocks stop during active execution phase', () => {
    writeSession({
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
    });
    // Create a fake in-progress task so orphan detection doesn't auto-complete
    const tasksDir = path.join(TEMP_PROJECT, '.oh-my-link', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'task-1.json'), JSON.stringify({
      link_id: 'task-1', title: 'Test task', status: 'in_progress',
      description: 'test', file_scope: [], acceptance_criteria: [],
    }));
    const result = runHook('stop-handler', {
      hook: 'Stop',
      session_id: 'test',
      cwd: TEMP_PROJECT,
    });
    // Clean up fake task
    try { fs.rmSync(tasksDir, { recursive: true, force: true }); } catch {}
    assert(result.decision === 'block', 'should block stop during execution');
    assert(result.reason.includes('START LINK'), `reason should include START LINK, got: ${result.reason}`);
  });

  test('allows stop for complete phase', () => {
    writeSession({
      active: true, mode: 'mylink', current_phase: 'complete',
    });
    const result = runHook('stop-handler', {
      hook: 'Stop',
      session_id: 'test',
      cwd: TEMP_PROJECT,
    });
    const blocked = result.decision === 'block';
    assert(!blocked, 'should allow stop for complete phase');
  });
});

// ============================================================
// 6. session-end (SessionEnd)
// ============================================================

suite('session-end — session deactivation', () => {
  test('deactivates non-critical session on end', () => {
    writeSession({
      active: true, mode: 'mylink', current_phase: 'phase_3_planning',
    });
    const result = runHook('session-end', {
      hook: 'SessionEnd',
      session_id: 'test',
      cwd: TEMP_PROJECT,
    });
    assert(typeof result === 'object', 'should return JSON object');
    // Check session was deactivated
    const session = readSession();
    if (session) {
      assert(session.active !== true, `session should be deactivated, got active=${session.active}`);
    }
    // If session is null (deleted), that's also acceptable
  });
});

// ============================================================
// 7. pre-compact (PreCompact)
// ============================================================

suite('pre-compact — basic I/O', () => {
  test('pre-compact returns valid JSON and continues', () => {
    const result = runHook('pre-compact', {
      hook: 'PreCompact',
      session_id: 'test',
      cwd: TEMP_PROJECT,
    });
    assert(typeof result === 'object', 'should return JSON object');
    assert(result.decision !== 'block', 'should not block compact');
  });
});

// ============================================================
// Cleanup & Summary
// ============================================================

cleanupTempDirs();

console.log('\n========================================');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('========================================');

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
