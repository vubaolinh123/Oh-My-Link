/**
 * Oh-My-Link — Post Tool Failure Hook Tests
 * Tests for dist/hooks/post-tool-failure.js
 * Run: node test/test-post-tool-failure.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-ptf-${Date.now()}`);
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

// Ensure dirs needed by post-tool-failure
state.ensureDir(state.getProjectStateRoot(TEMP_PROJECT));

console.log('Oh-My-Link — Post Tool Failure Hook Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Helpers
// ============================================================

const TRACKER_PATH = path.join(state.getProjectStateRoot(TEMP_PROJECT), 'last-tool-error.json');

function runFailure(toolName, toolError, envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `ptf-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ cwd: TEMP_PROJECT, tool_name: toolName, tool_error: toolError }));
  const cmd = `node "${path.join(DIST, 'hooks', 'post-tool-failure.js')}" < "${inputFile}"`;
  return JSON.parse(execSync(cmd, {
    timeout: 10000, encoding: 'utf-8', shell: true,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides }
  }).trim());
}

function cleanTracker() {
  try { fs.unlinkSync(TRACKER_PATH); } catch { /* ignore */ }
}

function readTracker() {
  return helpers.readJson(TRACKER_PATH);
}

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

function readSession() {
  return helpers.readJson(state.getSessionPath(TEMP_PROJECT));
}

// ============================================================
// Suite 1: post-tool-failure — retry tracking
// ============================================================

suite('post-tool-failure — retry tracking', () => {
  test('first failure records initial state (attempt 1/5)', () => {
    cleanTracker();
    const result = runFailure('Bash', 'command not found: foo');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('attempt 1/'), `should mention attempt 1, got: ${ctx}`);
    const tracker = readTracker();
    assert(tracker !== null, 'tracker file should be written');
    assertEqual(tracker.tool_name, 'Bash', 'tracker tool_name');
    assertEqual(tracker.count, 1, 'tracker count');
  });

  test('same tool within window increments count', () => {
    cleanTracker();
    runFailure('Bash', 'error one');
    const result = runFailure('Bash', 'error two');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('attempt 2/'), `should mention attempt 2, got: ${ctx}`);
    const tracker = readTracker();
    assertEqual(tracker.count, 2, 'tracker count should be 2');
  });

  test('different tool resets counter', () => {
    cleanTracker();
    runFailure('Bash', 'bash error');
    const result = runFailure('Read', 'read error');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('attempt 1/'), `should reset to attempt 1 for different tool, got: ${ctx}`);
    const tracker = readTracker();
    assertEqual(tracker.tool_name, 'Read', 'tracker should track Read now');
    assertEqual(tracker.count, 1, 'tracker count should be 1 after reset');
  });

  test('escalates at 5 retries for general tools', () => {
    cleanTracker();
    // Run 4 times (1-4)
    for (let i = 0; i < 4; i++) {
      runFailure('Bash', `error iteration ${i + 1}`);
    }
    // 5th time should escalate
    const result = runFailure('Bash', 'error iteration 5');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('failed 5 times'), `should mention escalation at 5 failures, got: ${ctx}`);
    assert(ctx.includes('different approach'), `should suggest different approach, got: ${ctx}`);
  });

  test('task-engine tools escalate at 2 retries', () => {
    cleanTracker();
    runFailure('acquireLock', 'lock contention');
    const result = runFailure('acquireLock', 'lock contention again');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('failed 2 times'), `should escalate at 2 for task-engine tool, got: ${ctx}`);
    assert(ctx.includes('doctor oml'), `should suggest doctor oml for task-engine tool, got: ${ctx}`);
  });

  test('task-engine escalation sets session.task_engine_error', () => {
    cleanTracker();
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    runFailure('acquireLock', 'lock error 1');
    runFailure('acquireLock', 'lock error 2');
    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.task_engine_error, true, 'session.task_engine_error should be true');
  });
});

// ============================================================
// Suite 2: post-tool-failure — retry window and edge cases
// ============================================================

suite('post-tool-failure — retry window and edge cases', () => {
  test('outside retry window resets counter', () => {
    cleanTracker();
    // Write a tracker with an old last_failure (>60s ago)
    const oldTime = new Date(Date.now() - 120 * 1000).toISOString();
    state.ensureDir(path.dirname(TRACKER_PATH));
    helpers.writeJsonAtomic(TRACKER_PATH, {
      tool_name: 'Bash',
      count: 4,
      first_failure: oldTime,
      last_failure: oldTime,
    });
    const result = runFailure('Bash', 'new error after window');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('attempt 1/'), `should reset to attempt 1 outside window, got: ${ctx}`);
    const tracker = readTracker();
    assertEqual(tracker.count, 1, 'tracker count should be reset to 1');
  });

  test('short state dir path is safe (passes through)', () => {
    cleanTracker();
    // Use a tiny OML_HOME path — the hook should guard against short stateDir
    const tinyHome = path.join(TEMP_ROOT, 'x');
    fs.mkdirSync(tinyHome, { recursive: true });
    const result = runFailure('Bash', 'some error', { OML_HOME: tinyHome });
    // Should not crash — should return valid JSON with continue: true
    assertEqual(result.continue, true, 'should return continue: true even with short path');
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
