/**
 * Oh-My-Link — New Test Suites (Set 1)
 * Cancel flows, mode conflicts, intent classification,
 * awaiting_confirmation, and stop-handler advanced behavior.
 * Run: node test/new-tests-1.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-test1-${Date.now()}`);
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

// Ensure runtime/artifact dirs exist
state.ensureRuntimeDirs(TEMP_PROJECT);
state.ensureArtifactDirs(TEMP_PROJECT);

// ============================================================
// Tests: keyword-detector — cancel flows
// ============================================================

suite('keyword-detector — cancel flows', () => {
  const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');

  function cleanSession() {
    try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
    try { fs.unlinkSync(state.getCancelSignalPath(TEMP_PROJECT)); } catch {}
  }

  function writeActiveSession(mode, phase) {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(sessionPath));
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode, current_phase: phase || 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
    });
  }

  function sendPrompt(prompt, tag) {
    const inputFile = path.join(TEMP_ROOT, `cancel-${tag}.json`);
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT, prompt }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    return JSON.parse(output);
  }

  test('cancel oml deactivates active session', () => {
    cleanSession();
    writeActiveSession('mylink', 'phase_5_execution');
    sendPrompt('cancel oml', 'oml-deactivate');
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assertEqual(session.active, false, 'session should be inactive');
    assertEqual(session.current_phase, 'cancelled', 'phase should be cancelled');
    const cancelSignal = helpers.readJson(state.getCancelSignalPath(TEMP_PROJECT));
    assert(cancelSignal !== null, 'cancel-signal.json should exist');
    assert(cancelSignal.expires_at, 'expires_at should be set');
    const expiresAt = new Date(cancelSignal.expires_at).getTime();
    assert(expiresAt > Date.now(), 'expires_at should be in the future');
  });

  test('cancel link deactivates active Start Link session', () => {
    cleanSession();
    writeActiveSession('mylink', 'phase_3_decomposition');
    sendPrompt('cancel link', 'link-deactivate');
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assertEqual(session.active, false, 'session should be inactive');
    assertEqual(session.current_phase, 'cancelled', 'phase should be cancelled');
    const cancelSignal = helpers.readJson(state.getCancelSignalPath(TEMP_PROJECT));
    assert(cancelSignal !== null, 'cancel-signal.json should exist');
    assert(cancelSignal.expires_at, 'expires_at should be set');
  });

  test('cancel fast deactivates active Start Fast session', () => {
    cleanSession();
    writeActiveSession('mylight', 'light_execution');
    sendPrompt('cancel fast', 'fast-deactivate');
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assertEqual(session.active, false, 'session should be inactive');
    assertEqual(session.current_phase, 'cancelled', 'phase should be cancelled');
  });

  test('cancel output includes cancel magic keyword', () => {
    cleanSession();
    writeActiveSession('mylink', 'phase_5_execution');
    const parsed = sendPrompt('cancel oml', 'cancel-magic');
    const ctx = parsed.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('cancel-oml'), 'output should include cancel-oml keyword');
  });
});

// ============================================================
// Tests: keyword-detector — mode conflicts
// ============================================================

suite('keyword-detector — mode conflicts', () => {
  const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');

  function cleanSession() {
    try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
    try { fs.unlinkSync(state.getCancelSignalPath(TEMP_PROJECT)); } catch {}
  }

  function writeSession(data) {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(sessionPath));
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
      ...data,
    });
  }

  function sendPrompt(prompt, tag) {
    const inputFile = path.join(TEMP_ROOT, `conflict-${tag}.json`);
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT, prompt }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    try { return JSON.parse(output); } catch { return { continue: true, plainText: output }; }
  }

  test('blocks Start Fast when Start Link is active', () => {
    cleanSession();
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    const parsed = sendPrompt('start fast fix the bug', 'block-fast');
    const ctx = parsed.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('Start Link session is active'), 'should mention Start Link session is active');
  });

  test('blocks Start Link when Start Fast is active', () => {
    cleanSession();
    writeSession({ active: true, mode: 'mylight', current_phase: 'light_execution' });
    const parsed = sendPrompt('start link build auth', 'block-link');
    const ctx = parsed.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('Start Fast session is active'), 'should mention Start Fast session is active');
  });

  test('allows Start Link when no active session', () => {
    cleanSession();
    const parsed = sendPrompt('start link build new feature', 'allow-link');
    const ctx = parsed.hookSpecificOutput?.additionalContext || parsed.plainText || '';
    assert(ctx.includes('OML START LINK'), 'should detect start link keyword');
  });

  test('allows Start Fast when session is inactive', () => {
    cleanSession();
    writeSession({ active: false, mode: 'mylink', current_phase: 'complete' });
    const parsed = sendPrompt('start fast fix the bug', 'allow-fast-inactive');
    const ctx = parsed.hookSpecificOutput?.additionalContext || parsed.plainText || '';
    assert(ctx.includes('OML START FAST'), 'should detect start fast keyword');
  });
});

// ============================================================
// Tests: keyword-detector — intent classification
// ============================================================

suite('keyword-detector — intent classification', () => {
  const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');

  function cleanSession() {
    try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
    try { fs.unlinkSync(state.getCancelSignalPath(TEMP_PROJECT)); } catch {}
  }

  function sendPrompt(prompt, tag) {
    const inputFile = path.join(TEMP_ROOT, `intent-${tag}.json`);
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT, prompt }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    try { return JSON.parse(output); } catch { return { continue: true, plainText: output }; }
  }

  test('turbo intent for file:line pattern', () => {
    cleanSession();
    sendPrompt('start fast fix typo on line 42 of auth.ts', 'turbo-fileline');
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assert(session !== null, 'session should exist');
    assertEqual(session.intent, 'turbo', 'intent should be turbo');
    assertEqual(session.current_phase, 'light_turbo', 'phase should be light_turbo');
  });

  test('standard intent for moderate fix', () => {
    cleanSession();
    sendPrompt('start fast fix login validation in auth.ts', 'standard-fix');
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assert(session !== null, 'session should exist');
    assertEqual(session.intent, 'standard', 'intent should be standard');
    assertEqual(session.current_phase, 'light_scout', 'phase should be light_scout');
  });

  test('complex intent suggests Start Link', () => {
    cleanSession();
    const parsed = sendPrompt('start fast refactor entire authentication system', 'complex-suggest');
    const ctx = parsed.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('complex') || ctx.includes('Start Link'), 'output should mention complex or Start Link');
    // No active session should be created for complex intent
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assert(session === null || !session.active, 'no active session should be created for complex intent');
  });
});

// ============================================================
// Tests: keyword-detector — awaiting_confirmation
// ============================================================

suite('keyword-detector — awaiting_confirmation', () => {
  const hookPath = path.join(DIST, 'hooks', 'keyword-detector.js');

  function cleanSession() {
    try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
    try { fs.unlinkSync(state.getCancelSignalPath(TEMP_PROJECT)); } catch {}
  }

  function sendPrompt(prompt, tag) {
    const inputFile = path.join(TEMP_ROOT, `confirm-${tag}.json`);
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT, prompt }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    try { return JSON.parse(output); } catch { return { continue: true, plainText: output }; }
  }

  test('Start Link sets awaiting_confirmation', () => {
    cleanSession();
    sendPrompt('start link build new feature', 'link-confirm');
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assert(session !== null, 'session should exist');
    assertEqual(session.awaiting_confirmation, true, 'awaiting_confirmation should be true');
  });

  test('Start Fast sets awaiting_confirmation', () => {
    cleanSession();
    sendPrompt('start fast fix bug in app.ts', 'fast-confirm');
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assert(session !== null, 'session should exist');
    assertEqual(session.awaiting_confirmation, true, 'awaiting_confirmation should be true');
  });
});

// ============================================================
// Tests: stop-handler — advanced behavior
// ============================================================

suite('stop-handler — advanced behavior', () => {
  const hookPath = path.join(DIST, 'hooks', 'stop-handler.js');

  function cleanSession() {
    try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
    try { fs.unlinkSync(state.getCancelSignalPath(TEMP_PROJECT)); } catch {}
  }

  // Create a fake in-progress task so orphan detection doesn't auto-complete
  function ensureFakeTask() {
    const tasksDir = path.join(TEMP_PROJECT, '.oh-my-link', 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'fake-task.json'), JSON.stringify({
      link_id: 'fake-task', title: 'Fake', status: 'in_progress',
      description: 'test', file_scope: [], acceptance_criteria: [],
    }));
  }
  function cleanFakeTask() {
    try { fs.unlinkSync(path.join(TEMP_PROJECT, '.oh-my-link', 'tasks', 'fake-task.json')); } catch {}
  }

  function writeSession(data) {
    const sessionPath = state.getSessionPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(sessionPath));
    helpers.writeJsonAtomic(sessionPath, {
      active: true, mode: 'mylink', current_phase: 'phase_5_execution',
      started_at: new Date().toISOString(), reinforcement_count: 0,
      failure_count: 0, revision_count: 0,
      ...data,
    });
  }

  function runStop(tag) {
    const inputFile = path.join(TEMP_ROOT, `stop-adv-${tag}.json`);
    fs.writeFileSync(inputFile, JSON.stringify({ session_id: 'test', cwd: TEMP_PROJECT }));
    const cmd = `node "${hookPath}" < "${inputFile}"`;
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT, timeout: 10000,
      env: { ...process.env, OML_HOME: process.env.OML_HOME }, shell: true,
    }).toString().trim();
    return JSON.parse(output);
  }

  test('allows stop when no session exists', () => {
    cleanSession();
    const parsed = runStop('no-session');
    assert(!parsed.decision || parsed.decision !== 'block', 'should allow stop when no session');
  });

  test('allows stop for cancelled phase', () => {
    cleanSession();
    writeSession({ current_phase: 'cancelled' });
    const parsed = runStop('cancelled-phase');
    assert(!parsed.decision || parsed.decision !== 'block', 'should allow stop for cancelled phase');
  });

  test('allows stop for failed phase', () => {
    cleanSession();
    writeSession({ current_phase: 'failed' });
    const parsed = runStop('failed-phase');
    assert(!parsed.decision || parsed.decision !== 'block', 'should allow stop for failed phase');
  });

  test('allows stop when awaiting_confirmation is true', () => {
    cleanSession();
    writeSession({
      current_phase: 'phase_2_planning',
      awaiting_confirmation: true,
    });
    const parsed = runStop('awaiting-confirm');
    assert(!parsed.decision || parsed.decision !== 'block', 'should allow stop when awaiting confirmation');
  });

  test('increments reinforcement_count on block', () => {
    cleanSession();
    ensureFakeTask();
    writeSession({
      current_phase: 'phase_5_execution',
      reinforcement_count: 5,
    });
    const parsed = runStop('increment-reinf');
    cleanFakeTask();
    assertEqual(parsed.decision, 'block', 'should block stop during execution');
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assertEqual(session.reinforcement_count, 6, 'reinforcement_count should be incremented to 6');
  });

  test('circuit breaker at max reinforcements', () => {
    cleanSession();
    writeSession({
      current_phase: 'phase_5_execution',
      reinforcement_count: 50,
    });
    const parsed = runStop('circuit-breaker');
    // At max reinforcements, circuit breaker fires: session deactivated, stop allowed
    assert(!parsed.decision || parsed.decision !== 'block', 'should not block at circuit breaker');
    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assertEqual(session.active, false, 'session should be deactivated by circuit breaker');
  });

  test('stale session (>2hrs) allows stop', () => {
    cleanSession();
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    writeSession({
      current_phase: 'phase_5_execution',
      started_at: threeHoursAgo,
      last_checked_at: threeHoursAgo,
      reinforcement_count: 2,
    });
    const parsed = runStop('stale-session');
    assert(!parsed.decision || parsed.decision !== 'block', 'should allow stop for stale session');
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
