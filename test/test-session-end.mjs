/**
 * Oh-My-Link — Session-End Hook Tests
 * Tests for dist/hooks/session-end.js behavior.
 * Run: node test/test-session-end.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-session-end-${Date.now()}`);
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

// Ensure runtime dirs
state.ensureRuntimeDirs(TEMP_PROJECT);
state.ensureArtifactDirs(TEMP_PROJECT);

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

function readSession() {
  return helpers.readJson(state.getSessionPath(TEMP_PROJECT));
}

function runSessionEnd(envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `se-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ cwd: TEMP_PROJECT }));
  const cmd = `node "${path.join(DIST, 'hooks', 'session-end.js')}" < "${inputFile}"`;
  return JSON.parse(execSync(cmd, {
    timeout: 10000, encoding: 'utf-8', shell: true,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides }
  }).trim());
}

console.log('Oh-My-Link — Session-End Hook Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Suite 1: Non-critical phase deactivation
// ============================================================

suite('session-end — non-critical phase deactivation', () => {
  test('deactivates session in phase_2_planning', () => {
    writeSession({ current_phase: 'phase_2_planning' });
    runSessionEnd();
    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.active, false, 'session should be deactivated');
    assert(session.deactivated_reason != null && session.deactivated_reason.length > 0,
      `deactivated_reason should be set, got: ${session.deactivated_reason}`);
  });

  test('deactivates session in phase_3_decomposition', () => {
    writeSession({ current_phase: 'phase_3_decomposition' });
    runSessionEnd();
    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.active, false, 'session should be deactivated');
    assert(session.deactivated_reason != null && session.deactivated_reason.length > 0,
      `deactivated_reason should be set, got: ${session.deactivated_reason}`);
  });

  test('deactivates session in bootstrap', () => {
    writeSession({ current_phase: 'bootstrap' });
    runSessionEnd();
    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.active, false, 'session should be deactivated');
    assert(session.deactivated_reason != null && session.deactivated_reason.length > 0,
      `deactivated_reason should be set, got: ${session.deactivated_reason}`);
  });
});

// ============================================================
// Suite 2: Critical phase preservation
// ============================================================

suite('session-end — critical phase preservation', () => {
  test('preserves active session in phase_5_execution', () => {
    writeSession({ current_phase: 'phase_5_execution' });
    runSessionEnd();
    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.active, true, 'session should remain active in phase_5_execution');
    assert(session.session_ended_at != null,
      `session_ended_at should be set, got: ${session.session_ended_at}`);
  });

  test('preserves active session in phase_6_review', () => {
    writeSession({ current_phase: 'phase_6_review' });
    runSessionEnd();
    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.active, true, 'session should remain active in phase_6_review');
    assert(session.session_ended_at != null,
      `session_ended_at should be set, got: ${session.session_ended_at}`);
  });

  test('preserves active session in light_turbo', () => {
    writeSession({ mode: 'mylight', current_phase: 'light_turbo' });
    runSessionEnd();
    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.active, true, 'session should remain active in light_turbo');
    assert(session.session_ended_at != null,
      `session_ended_at should be set, got: ${session.session_ended_at}`);
  });

  test('preserves active session in light_execution', () => {
    writeSession({ mode: 'mylight', current_phase: 'light_execution' });
    runSessionEnd();
    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.active, true, 'session should remain active in light_execution');
    assert(session.session_ended_at != null,
      `session_ended_at should be set, got: ${session.session_ended_at}`);
  });
});

// ============================================================
// Suite 3: Cleanup
// ============================================================

suite('session-end — cleanup', () => {
  test('clears injected-skills.json on session end', () => {
    writeSession({ current_phase: 'phase_2_planning' });
    const injectedPath = path.join(state.getProjectStateRoot(TEMP_PROJECT), 'injected-skills.json');
    state.ensureDir(path.dirname(injectedPath));
    helpers.writeJsonAtomic(injectedPath, { skills: ['scout.md', 'worker.md'], injected_at: new Date().toISOString() });

    assert(fs.existsSync(injectedPath), 'injected-skills.json should exist before session-end');

    runSessionEnd();

    if (fs.existsSync(injectedPath)) {
      const content = helpers.readJson(injectedPath);
      // File either deleted or cleared/reset (empty skills array or null)
      const cleared = content === null || !content.skills || content.skills.length === 0;
      assert(cleared,
        `injected-skills.json should be cleared/reset after session-end, got: ${JSON.stringify(content)}`);
    }
    // If file doesn't exist, that's also a valid "cleared" state
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
