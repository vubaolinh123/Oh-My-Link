/**
 * Oh-My-Link — Parity Fix Tests 
 * Tests the specific behavior fixes in OML.
 * Run: node test/test-parity-fixes.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-parity-${Date.now()}`);
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

setupTempDirs();

// Load modules
const state = require(path.join(DIST, 'state.js'));
const helpers = require(path.join(DIST, 'helpers.js'));
const taskEngine = require(path.join(DIST, 'task-engine.js'));
const projectMemory = require(path.join(DIST, 'project-memory.js'));
const promptLeverage = require(path.join(DIST, 'prompt-leverage.js'));

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

function cleanSession() {
  try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
}

function cleanTracking() {
  const trackingPath = state.getSubagentTrackingPath(TEMP_PROJECT);
  try { fs.unlinkSync(trackingPath); } catch {}
}

function cleanToolTracking() {
  const trackPath = state.getToolTrackingPath(TEMP_PROJECT);
  try { fs.unlinkSync(trackPath); } catch {}
}

function runHook(hookFile, inputData, envOverrides = {}) {
  const hookPath = path.join(DIST, 'hooks', hookFile);
  const inputFile = path.join(TEMP_ROOT, `input-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ cwd: TEMP_PROJECT, ...inputData }));
  const cmd = `node "${hookPath}" < "${inputFile}"`;
  try {
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT,
      timeout: 15000,
      encoding: 'utf-8',
      env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides },
      shell: true,
    }).trim();
    return JSON.parse(output);
  } catch (err) {
    return { error: err.message };
  }
}

function runLifecycleHook(mode, inputData, envOverrides = {}) {
  const hookPath = path.join(DIST, 'hooks', 'subagent-lifecycle.js');
  const inputFile = path.join(TEMP_ROOT, `lifecycle-${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ cwd: TEMP_PROJECT, ...inputData }));
  const cmd = `node "${hookPath}" ${mode} < "${inputFile}"`;
  try {
    const output = execSync(cmd, {
      cwd: TEMP_PROJECT,
      timeout: 15000,
      encoding: 'utf-8',
      env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides },
      shell: true,
    }).trim();
    return JSON.parse(output);
  } catch (err) {
    return { error: err.message };
  }
}

console.log('Oh-My-Link — Parity Fix Tests)');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Suite 1: C-1 — session.last_failure is now an object (not a string)
// ============================================================

suite('C-1: session.last_failure is an object', () => {
  test('post-tool-verifier records last_failure as object with correct fields', () => {
    writeSession({ active: true, failure_count: 0 });
    cleanToolTracking();

    runHook('post-tool-verifier.js', {
      tool_name: 'Bash',
      tool_input: { command: 'npm run build' },
      tool_output: 'src/app.ts(12,5): error TS1234: Something went wrong\nMore output here',
    });

    const session = readSession();
    assert(session !== null, 'session should exist');
    assert(typeof session.last_failure === 'object' && session.last_failure !== null,
      `last_failure should be an object, got ${typeof session.last_failure}: ${JSON.stringify(session.last_failure)}`);
  });

  test('last_failure.tool === "Bash"', () => {
    const session = readSession();
    assertEqual(session.last_failure.tool, 'Bash', 'last_failure.tool');
  });

  test('last_failure.error contains the matched pattern', () => {
    const session = readSession();
    assert(session.last_failure.error.includes('error TS1234'),
      `last_failure.error should contain "error TS1234", got: ${session.last_failure.error}`);
  });

  test('last_failure.snippet is a string (first 500 chars of output)', () => {
    const session = readSession();
    assertEqual(typeof session.last_failure.snippet, 'string', 'last_failure.snippet type');
    assert(session.last_failure.snippet.length > 0, 'snippet should not be empty');
    assert(session.last_failure.snippet.length <= 500, 'snippet should be <= 500 chars');
  });

  test('last_failure.timestamp is set', () => {
    const session = readSession();
    assert(session.last_failure.timestamp !== undefined, 'timestamp should be set');
    assert(typeof session.last_failure.timestamp === 'string', 'timestamp should be a string');
    // Should be a valid ISO date
    assert(!isNaN(new Date(session.last_failure.timestamp).getTime()), 'timestamp should be valid ISO date');
  });

  test('session.last_checked_at is set', () => {
    const session = readSession();
    assert(session.last_checked_at !== undefined, 'last_checked_at should be set');
    assert(typeof session.last_checked_at === 'string', 'last_checked_at should be a string');
    assert(!isNaN(new Date(session.last_checked_at).getTime()), 'last_checked_at should be valid ISO date');
  });
});

// ============================================================
// Suite 2: H-3 — tracking.failures has correct schema
// ============================================================

suite('H-3: tracking.failures has correct schema', () => {
  test('post-tool-verifier records failure in tool-tracking.json', () => {
    writeSession({ active: true, failure_count: 0 });
    cleanToolTracking();

    runHook('post-tool-verifier.js', {
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      tool_output: 'npm ERR! code E404\nnpm ERR! 404 Not Found\nSome long output ' + 'x'.repeat(600),
    });

    const trackPath = state.normalizePath(path.join(state.getProjectStateRoot(TEMP_PROJECT), 'tool-tracking.json'));
    const tracking = helpers.readJson(trackPath);
    assert(tracking !== null, 'tool-tracking.json should exist');
    assert(Array.isArray(tracking.failures), 'tracking.failures should be an array');
    assert(tracking.failures.length >= 1, 'should have at least 1 failure');
  });

  test('tracking.failures[0] has correct fields: tool, error, timestamp, snippet', () => {
    const trackPath = state.normalizePath(path.join(state.getProjectStateRoot(TEMP_PROJECT), 'tool-tracking.json'));
    const tracking = helpers.readJson(trackPath);
    const failure = tracking.failures[0];

    assert(failure.tool !== undefined, 'failure.tool should exist');
    assertEqual(failure.tool, 'Bash', 'failure.tool');

    assert(failure.error !== undefined, 'failure.error should exist');
    assert(failure.timestamp !== undefined, 'failure.timestamp should exist');
    assert(failure.snippet !== undefined, 'failure.snippet should exist');
  });

  test('tracking.failures[0].error is the matched keyword (short), NOT 500 chars', () => {
    const trackPath = state.normalizePath(path.join(state.getProjectStateRoot(TEMP_PROJECT), 'tool-tracking.json'));
    const tracking = helpers.readJson(trackPath);
    const failure = tracking.failures[0];

    // error should be the matched pattern text like "npm ERR!" — not a long snippet
    assert(failure.error.includes('npm ERR!'),
      `failure.error should contain "npm ERR!", got: ${failure.error}`);
    assert(failure.error.length < 100,
      `failure.error should be short (matched pattern), not 500 chars. Got length: ${failure.error.length}`);
  });

  test('tracking.failures[0].snippet is longer raw text (up to 500 chars)', () => {
    const trackPath = state.normalizePath(path.join(state.getProjectStateRoot(TEMP_PROJECT), 'tool-tracking.json'));
    const tracking = helpers.readJson(trackPath);
    const failure = tracking.failures[0];

    assert(typeof failure.snippet === 'string', 'snippet should be a string');
    assert(failure.snippet.length > 0, 'snippet should not be empty');
    assert(failure.snippet.length <= 500, 'snippet should be <= 500 chars');
    // snippet should contain more context than just the keyword
    assert(failure.snippet.length > failure.error.length,
      'snippet should be longer than the error keyword');
  });
});

// ============================================================
// Suite 3: H-1 — Review gate (no auto-task completion)
// ============================================================

suite('H-1: Review gate — worker stop does NOT auto-complete tasks', () => {
  test('worker stop with exit_code=0 leaves task in_progress (review gate)', () => {
    cleanTracking();
    cleanSession();
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });

    // Create a task assigned to this worker
    taskEngine.createTask(TEMP_PROJECT, {
      link_id: 'parity-gate-ok',
      title: 'Review gate test (success)',
      description: 'Test that worker does not auto-complete',
      acceptance_criteria: ['Works'],
      file_scope: ['src/app.ts'],
      locked_decisions: [],
      depends_on: [],
      status: 'pending',
      assigned_to: 'agent-gate-ok',
    });

    // Start worker (auto-claims task)
    runLifecycleHook('start', {
      agent_id: 'agent-gate-ok',
      agent_type: 'oh-my-link:worker',
      agent_description: 'Worker for gate test',
      agent_prompt: 'Implement feature',
    });

    // Verify task is now in_progress after start
    const taskAfterStart = taskEngine.readTask(TEMP_PROJECT, 'parity-gate-ok');
    assertEqual(taskAfterStart.status, 'in_progress', 'task should be in_progress after worker start');

    // Stop worker with success (exit_code=0)
    runLifecycleHook('stop', {
      agent_id: 'agent-gate-ok',
      exit_code: 0,
    });

    // Verify task remains in_progress — NOT auto-completed to "done"
    const taskAfterStop = taskEngine.readTask(TEMP_PROJECT, 'parity-gate-ok');
    assertEqual(taskAfterStop.status, 'in_progress',
      'task should remain in_progress after worker stop (review gate required)');
  });

  test('worker stop with exit_code=1 marks task as failed', () => {
    cleanTracking();
    cleanSession();
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });

    // Create a task assigned to this worker
    taskEngine.createTask(TEMP_PROJECT, {
      link_id: 'parity-gate-fail',
      title: 'Review gate test (failure)',
      description: 'Test that worker marks task failed on error',
      acceptance_criteria: ['Works'],
      file_scope: ['src/app.ts'],
      locked_decisions: [],
      depends_on: [],
      status: 'pending',
      assigned_to: 'agent-gate-fail',
    });

    // Start worker
    runLifecycleHook('start', {
      agent_id: 'agent-gate-fail',
      agent_type: 'oh-my-link:worker',
      agent_description: 'Worker for fail test',
      agent_prompt: 'Implement feature',
    });

    // Stop worker with failure (exit_code=1)
    runLifecycleHook('stop', {
      agent_id: 'agent-gate-fail',
      exit_code: 1,
    });

    // Verify task IS marked failed
    const task = taskEngine.readTask(TEMP_PROJECT, 'parity-gate-fail');
    assertEqual(task.status, 'failed',
      'task should be marked failed after worker stop with exit_code=1');
  });
});

// ============================================================
// Suite 4: Prompt leverage intensity cap
// ============================================================

suite('Prompt leverage — intensity cap for mylight mode', () => {
  test('generateFramework with mylight caps security intensity to light', () => {
    // "security" prompt should normally be "critical" intensity
    const result = promptLeverage.generateFramework('Fix the security auth permissions vulnerability', 'mylight');
    assertEqual(result.intensity, 'light',
      `mylight mode should cap intensity to "light", got "${result.intensity}"`);
  });

  test('generateFramework with mylink does NOT cap security intensity', () => {
    const result = promptLeverage.generateFramework('Fix the security auth permissions vulnerability', 'mylink');
    assertEqual(result.intensity, 'critical',
      `mylink mode should keep intensity as "critical", got "${result.intensity}"`);
  });

  test('generateFramework with mylight caps heavy intensity to light', () => {
    // "feature" prompt should normally be "heavy" intensity
    const result = promptLeverage.generateFramework('Add a new feature to implement the build system', 'mylight');
    assertEqual(result.intensity, 'light',
      `mylight mode should cap "heavy" to "light", got "${result.intensity}"`);
  });

  test('generateFramework with mylink preserves heavy intensity', () => {
    const result = promptLeverage.generateFramework('Add a new feature to implement the build system', 'mylink');
    assertEqual(result.intensity, 'heavy',
      `mylink mode should keep intensity as "heavy", got "${result.intensity}"`);
  });

  test('generateFramework with mylight allows light intensity through (no-op cap)', () => {
    // "docs" prompt should be "light" intensity — cap to light is a no-op
    const result = promptLeverage.generateFramework('Update the documentation readme comments', 'mylight');
    assertEqual(result.intensity, 'light',
      `mylight mode with "light" intensity should stay "light", got "${result.intensity}"`);
  });
});

// ============================================================
// Suite 5: Session-start — project memory injection
// ============================================================

suite('Session-start — project memory injection path', () => {
  test('session-start returns project memory injection when memory exists', () => {
    cleanSession();
    // Set up project memory
    const memory = projectMemory.loadMemory(TEMP_PROJECT);
    memory.tech_stack = { runtime: 'node', language: 'typescript', framework: 'next.js' };
    memory.last_scanned_at = new Date().toISOString();
    projectMemory.saveMemory(TEMP_PROJECT, memory);

    // Run session-start hook
    const result = runHook('session-start.js', {
      session_id: 'test-session',
      source: 'startup',
    });

    assert(!result.error, `session-start should not error: ${result.error}`);
  });

  test('session-start output contains [Project Memory]', () => {
    cleanSession();
    // Set up project memory with data
    const memory = projectMemory.loadMemory(TEMP_PROJECT);
    memory.tech_stack = { runtime: 'node', language: 'typescript', framework: 'next.js' };
    memory.last_scanned_at = new Date().toISOString();
    projectMemory.saveMemory(TEMP_PROJECT, memory);

    const result = runHook('session-start.js', {
      session_id: 'test-session-2',
      source: 'startup',
    });

    assert(!result.error, `session-start should not error: ${result.error}`);
    // Check the output contains project memory
    const outputStr = JSON.stringify(result);
    assert(outputStr.includes('[Project Memory]') || outputStr.includes('Project Memory'),
      `session-start output should contain "[Project Memory]", got: ${outputStr.slice(0, 500)}`);
  });

  test('session-start does not crash on Node >= 18 (no blocking warning)', () => {
    cleanSession();
    const result = runHook('session-start.js', {
      session_id: 'test-session-3',
      source: 'startup',
    });

    assert(!result.error, `session-start should not error on Node >= 18: ${result.error}`);
    // The output should NOT contain the Node warning since we're on >= 18
    const outputStr = JSON.stringify(result);
    const hasWarning = outputStr.includes('[WARNING] Node.js');
    assertEqual(hasWarning, false,
      'session-start should NOT emit Node.js warning on Node >= 18');
  });
});

// ============================================================
// Suite 6: Path containment guard (post-tool-failure)
// ============================================================

suite('Path containment guard — post-tool-failure', () => {
  test('post-tool-failure returns valid hookOutput with valid cwd', () => {
    writeSession({ active: true });

    const result = runHook('post-tool-failure.js', {
      tool_name: 'Bash',
      tool_error: 'Command not found: foobar',
    });

    assert(!result.error, `post-tool-failure should not error: ${result.error}`);
    assert(typeof result === 'object', 'result should be an object');
  });

  test('post-tool-failure does not crash with path containment check', () => {
    writeSession({ active: true });

    // Run multiple times to test retry tracking (which uses stateDir)
    const result1 = runHook('post-tool-failure.js', {
      tool_name: 'Write',
      tool_error: 'Permission denied: /etc/passwd',
    });
    const result2 = runHook('post-tool-failure.js', {
      tool_name: 'Write',
      tool_error: 'Permission denied: /etc/passwd',
    });

    assert(!result1.error, `first call should not error: ${result1.error}`);
    assert(!result2.error, `second call should not error: ${result2.error}`);
  });

  test('post-tool-failure tracks retry count correctly', () => {
    writeSession({ active: true });

    // Clean the last-tool-error tracker
    const stateDir = state.getProjectStateRoot(TEMP_PROJECT);
    const trackPath = state.normalizePath(path.join(stateDir, 'last-tool-error.json'));
    try { fs.unlinkSync(trackPath); } catch {}

    // First failure
    runHook('post-tool-failure.js', {
      tool_name: 'Bash',
      tool_error: 'exit code 1',
    });

    const tracker = helpers.readJson(trackPath);
    assert(tracker !== null, 'last-tool-error.json should exist');
    assertEqual(tracker.tool_name, 'Bash', 'tracker.tool_name');
    assertEqual(tracker.count, 1, 'tracker.count should be 1 after first failure');
    assert(tracker.error_snippet !== undefined, 'error_snippet should be captured');
  });
});

// ============================================================
// Cleanup & Summary
// ============================================================

cleanupTempDirs();

console.log(`\n${'='.repeat(40)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`${'='.repeat(40)}`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
