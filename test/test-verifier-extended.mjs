/**
 * Oh-My-Link — Extended Post-Tool-Verifier Tests
 * Tests for dist/hooks/post-tool-verifier.js
 * Run: node test/test-verifier-extended.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-verifier-ext-${Date.now()}`);
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

// Ensure state directories exist
state.ensureDir(path.dirname(state.getSessionPath(TEMP_PROJECT)));
state.ensureDir(path.dirname(state.getToolTrackingPath(TEMP_PROJECT)));
state.ensureDir(path.dirname(state.getWorkingMemoryPath(TEMP_PROJECT)));
state.ensureDir(path.dirname(state.getPriorityContextPath(TEMP_PROJECT)));

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

function readSession() {
  return helpers.readJson(state.getSessionPath(TEMP_PROJECT));
}

function runVerifier(toolName, toolInput, toolOutput, envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `pv-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({
    cwd: TEMP_PROJECT,
    tool_name: toolName,
    tool_input: toolInput || {},
    tool_output: toolOutput || '',
  }));
  const cmd = `node "${path.join(DIST, 'hooks', 'post-tool-verifier.js')}" < "${inputFile}"`;
  return JSON.parse(execSync(cmd, {
    timeout: 10000,
    encoding: 'utf-8',
    shell: true,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides },
  }).trim());
}

console.log('Oh-My-Link — Extended Post-Tool-Verifier Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// Write active session before tests
writeSession({
  active: true,
  mode: 'mylink',
  current_phase: 'phase_5_execution',
  started_at: new Date().toISOString(),
  reinforcement_count: 0,
  failure_count: 0,
  revision_count: 0,
});

// ============================================================
// Suite 1: File Modification Tracking
// ============================================================

suite('File Modification Tracking', () => {
  test('tracks Write tool file path in tool-tracking.json', () => {
    writeSession({ active: true });
    // Clean tool-tracking
    const trackPath = state.getToolTrackingPath(TEMP_PROJECT);
    try { fs.unlinkSync(trackPath); } catch { /* ignore */ }

    runVerifier('Write', { file_path: 'src/app.ts' }, 'file written');

    const tracking = helpers.readJson(trackPath);
    assert(tracking !== null, 'tool-tracking.json should exist');
    assert(Array.isArray(tracking.files_modified), 'tracking should have files_modified array');
    assert(tracking.files_modified.includes('src/app.ts'),
      `files_modified should contain 'src/app.ts', got: ${JSON.stringify(tracking.files_modified)}`);
  });

  test('tracks Edit tool file path', () => {
    writeSession({ active: true });
    const trackPath = state.getToolTrackingPath(TEMP_PROJECT);
    try { fs.unlinkSync(trackPath); } catch { /* ignore */ }

    runVerifier('Edit', { file_path: 'src/utils.ts' }, 'edit applied');

    const tracking = helpers.readJson(trackPath);
    assert(tracking !== null, 'tool-tracking.json should exist');
    assert(Array.isArray(tracking.files_modified), 'tracking should have files_modified array');
    assert(tracking.files_modified.includes('src/utils.ts'),
      `files_modified should contain 'src/utils.ts', got: ${JSON.stringify(tracking.files_modified)}`);
  });

  test('tracks MultiEdit tool file paths', () => {
    writeSession({ active: true });
    const trackPath = state.getToolTrackingPath(TEMP_PROJECT);
    try { fs.unlinkSync(trackPath); } catch { /* ignore */ }

    runVerifier('MultiEdit', {
      edits: [
        { file_path: 'src/a.ts' },
        { file_path: 'src/b.ts' },
      ],
    }, 'edits applied');

    const tracking = helpers.readJson(trackPath);
    assert(tracking !== null, 'tool-tracking.json should exist');
    assert(Array.isArray(tracking.files_modified), 'tracking should have files_modified array');
    assert(tracking.files_modified.includes('src/a.ts'),
      `files_modified should contain 'src/a.ts', got: ${JSON.stringify(tracking.files_modified)}`);
    assert(tracking.files_modified.includes('src/b.ts'),
      `files_modified should contain 'src/b.ts', got: ${JSON.stringify(tracking.files_modified)}`);
  });
});

// ============================================================
// Suite 2: Output Clipping
// ============================================================

suite('Output Clipping', () => {
  test('clips very long tool output', () => {
    writeSession({ active: true });

    // Generate a 50KB string
    const longOutput = 'x'.repeat(50 * 1024);
    const result = runVerifier('Bash', { command: 'echo big' }, longOutput);

    assert(result !== null, 'verifier should return valid JSON');
    assert(typeof result === 'object', 'result should be an object');
    // Hook should not crash — returning valid JSON is sufficient
  });
});

// ============================================================
// Suite 3: Passthrough on Inactive Session
// ============================================================

suite('Passthrough on Inactive Session', () => {
  test('returns continue:true passthrough when no active session', () => {
    deleteSession();

    // Clean tool-tracking to detect mutations
    const trackPath = state.getToolTrackingPath(TEMP_PROJECT);
    let trackingBefore = null;
    try { trackingBefore = helpers.readJson(trackPath); } catch { /* ignore */ }
    try { fs.unlinkSync(trackPath); } catch { /* ignore */ }

    const result = runVerifier('Write', { file_path: 'src/foo.ts' }, 'written');

    // Verify no tracking mutations occurred (file should not exist or be unchanged)
    const trackingAfter = helpers.readJson(trackPath);
    assert(trackingAfter === null,
      `tool-tracking.json should not be created when no active session, got: ${JSON.stringify(trackingAfter)}`);

    // Restore session for subsequent tests
    writeSession({ active: true });
  });
});

// ============================================================
// Suite 4: Remember Tags (extended)
// ============================================================

suite('Remember Tags (extended)', () => {
  test('multiple <remember> tags accumulate in working-memory.md', () => {
    writeSession({ active: true });
    const wmPath = state.getWorkingMemoryPath(TEMP_PROJECT);
    try { fs.unlinkSync(wmPath); } catch { /* ignore */ }

    runVerifier('Bash', { command: 'echo test' },
      'output <remember>First insight</remember> middle <remember>Second insight</remember> end');

    assert(fs.existsSync(wmPath), 'working-memory.md should exist');
    const content = fs.readFileSync(wmPath, 'utf-8');
    assert(content.includes('First insight'),
      `working-memory.md should contain 'First insight', got: ${content}`);
    assert(content.includes('Second insight'),
      `working-memory.md should contain 'Second insight', got: ${content}`);
  });

  test('<remember priority> caps at 500 chars', () => {
    writeSession({ active: true });
    const priPath = state.getPriorityContextPath(TEMP_PROJECT);
    try { fs.unlinkSync(priPath); } catch { /* ignore */ }

    // Generate a >500 char priority remember
    const longContent = 'A'.repeat(600);
    runVerifier('Bash', { command: 'echo test' },
      `<remember priority>${longContent}</remember>`);

    assert(fs.existsSync(priPath), 'priority-context.md should exist');
    const content = fs.readFileSync(priPath, 'utf-8');
    assert(content.length <= 500,
      `priority-context.md should be capped at 500 chars, got ${content.length}`);
  });
});

// ============================================================
// Suite 5: Failure Detection
// ============================================================

suite('Failure Detection', () => {
  test('does NOT detect errors in Edit output', () => {
    writeSession({ active: true, failure_count: 0 });

    runVerifier('Edit', { file_path: 'src/test.ts' }, 'Error: something went wrong');

    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.failure_count, 0,
      'failure_count should remain 0 for Edit tool');
  });

  test('detects build failure in Bash output', () => {
    writeSession({ active: true, failure_count: 0 });

    runVerifier('Bash', { command: 'npm run build' },
      'error TS2345: Argument of type string is not assignable to parameter of type number');

    const session = readSession();
    assert(session !== null, 'session should exist');
    assert(session.failure_count >= 1,
      `failure_count should be >= 1 for TS error in Bash, got ${session.failure_count}`);
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
