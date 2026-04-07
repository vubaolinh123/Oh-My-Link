/**
 * Oh-My-Link — Pre-Compact Hook Tests
 * Tests for dist/hooks/pre-compact.js
 * Run: node test/test-pre-compact.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-precompact-${Date.now()}`);
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
const taskEngine = require(path.join(DIST, 'task-engine.js'));

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

function runPreCompact(envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `pc-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ cwd: TEMP_PROJECT }));
  const cmd = `node "${path.join(DIST, 'hooks', 'pre-compact.js')}" < "${inputFile}"`;
  return JSON.parse(execSync(cmd, {
    timeout: 10000, encoding: 'utf-8', shell: true,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides }
  }).trim());
}

console.log('Oh-My-Link — Pre-Compact Hook Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Suite 1: Basic I/O
// ============================================================

suite('pre-compact — Basic I/O', () => {
  test('returns continue: true and valid JSON', () => {
    writeSession({ active: true });
    const parsed = runPreCompact();
    assertEqual(parsed.continue, true, 'continue field');
    assert(typeof parsed === 'object', 'output should be valid JSON object');
  });

  test('passes through when no active session', () => {
    deleteSession();
    const parsed = runPreCompact();
    assertEqual(parsed.continue, true, 'continue field');
    // Verify no checkpoint written when no session
    const checkpointPath = state.getCheckpointPath(TEMP_PROJECT);
    // Delete any existing checkpoint first, then run again
    try { fs.unlinkSync(checkpointPath); } catch { /* ignore */ }
    deleteSession();
    runPreCompact();
    assert(!fs.existsSync(checkpointPath),
      'checkpoint should NOT be written when no active session');
  });
});

// ============================================================
// Suite 2: Checkpoint Writing
// ============================================================

suite('pre-compact — Checkpoint Writing', () => {
  test('writes checkpoint.json for active session', () => {
    // Clean checkpoint
    const checkpointPath = state.getCheckpointPath(TEMP_PROJECT);
    try { fs.unlinkSync(checkpointPath); } catch { /* ignore */ }

    writeSession({ active: true, current_phase: 'phase_5_execution' });
    runPreCompact();

    assert(fs.existsSync(checkpointPath),
      'checkpoint.json should exist after pre-compact with active session');
    const checkpoint = helpers.readJson(checkpointPath);
    assert(checkpoint !== null, 'checkpoint should be valid JSON');
    assert(checkpoint.session !== undefined, 'checkpoint should include session snapshot');
    assert(checkpoint.session.active === true, 'checkpoint session should be active');
  });

  test('checkpoint includes task data', () => {
    // Clean checkpoint
    const checkpointPath = state.getCheckpointPath(TEMP_PROJECT);
    try { fs.unlinkSync(checkpointPath); } catch { /* ignore */ }

    // Create a task via task-engine
    taskEngine.createTask(TEMP_PROJECT, {
      link_id: 'test-task-pc-1',
      title: 'Test task for pre-compact',
      status: 'in_progress',
      assigned_to: 'worker-1',
      depends_on: [],
    });

    writeSession({ active: true, current_phase: 'phase_5_execution' });
    runPreCompact();

    const checkpoint = helpers.readJson(checkpointPath);
    assert(checkpoint !== null, 'checkpoint should exist');
    assert(checkpoint.active_tasks !== undefined, 'checkpoint should have active_tasks');
    assert(Array.isArray(checkpoint.active_tasks), 'active_tasks should be an array');
    assert(checkpoint.active_tasks.length >= 1,
      `active_tasks should have at least 1 entry, got ${checkpoint.active_tasks.length}`);
  });

  test('checkpoint includes trigger field', () => {
    const checkpointPath = state.getCheckpointPath(TEMP_PROJECT);
    try { fs.unlinkSync(checkpointPath); } catch { /* ignore */ }

    writeSession({ active: true, current_phase: 'phase_5_execution' });
    runPreCompact();

    const checkpoint = helpers.readJson(checkpointPath);
    assert(checkpoint !== null, 'checkpoint should exist');
    assertEqual(checkpoint.trigger, 'pre_compact', 'trigger field');
  });
});

// ============================================================
// Suite 3: Handoff File
// ============================================================

suite('pre-compact — Handoff File', () => {
  test('writes handoff markdown file', () => {
    const handoffsDir = state.getHandoffsDir(TEMP_PROJECT);
    state.ensureDir(handoffsDir);

    // Clean existing handoffs
    try {
      const existing = fs.readdirSync(handoffsDir);
      for (const f of existing) {
        fs.unlinkSync(path.join(handoffsDir, f));
      }
    } catch { /* ignore */ }

    writeSession({ active: true, current_phase: 'phase_5_execution' });
    runPreCompact();

    const files = fs.readdirSync(handoffsDir).filter(f => f.endsWith('.md'));
    assert(files.length >= 1,
      `handoff .md file should be created in handoffs dir, found ${files.length} files`);

    // Verify content mentions phase
    const content = fs.readFileSync(path.join(handoffsDir, files[0]), 'utf-8');
    assert(content.includes('phase_5_execution'),
      'handoff should mention the current phase');
  });
});

// ============================================================
// Suite 4: systemMessage
// ============================================================

suite('pre-compact — systemMessage', () => {
  test('output includes systemMessage for recovery', () => {
    writeSession({ active: true, current_phase: 'phase_5_execution' });
    const parsed = runPreCompact();

    assert(parsed.systemMessage !== undefined, 'output should include systemMessage');
    assert(typeof parsed.systemMessage === 'string', 'systemMessage should be a string');
    assert(parsed.systemMessage.includes('phase_5_execution'),
      'systemMessage should mention the current phase');
  });

  test('systemMessage includes project memory summary', () => {
    // Write project-memory.json with some data
    const memoryPath = state.getProjectMemoryPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(memoryPath));
    helpers.writeJsonAtomic(memoryPath, {
      tech_stack: { lang: 'typescript', runtime: 'node' },
      hot_paths: [{ path: 'src/index.ts', access_count: 5 }],
      user_directives: [{ directive: 'Always use strict mode', priority: 'high' }],
      notes: [],
      last_scanned_at: new Date().toISOString(),
    });

    writeSession({ active: true, current_phase: 'phase_5_execution' });
    const parsed = runPreCompact();

    assert(parsed.systemMessage !== undefined, 'systemMessage should exist');
    // Memory summary should mention tech stack or directives
    assert(
      parsed.systemMessage.includes('Project Memory') ||
      parsed.systemMessage.includes('Stack') ||
      parsed.systemMessage.includes('typescript'),
      `systemMessage should mention project memory, got: ${parsed.systemMessage.slice(0, 200)}`
    );
  });
});

// ============================================================
// Suite 5: Mr.Fast Sessions
// ============================================================

suite('pre-compact — Mr.Fast Sessions', () => {
  test('checkpoints Mr.Fast sessions', () => {
    const checkpointPath = state.getCheckpointPath(TEMP_PROJECT);
    try { fs.unlinkSync(checkpointPath); } catch { /* ignore */ }

    writeSession({
      active: true,
      mode: 'mylight',
      current_phase: 'light_execution',
    });
    runPreCompact();

    assert(fs.existsSync(checkpointPath),
      'checkpoint should be written for Mr.Fast (mylight) sessions');
    const checkpoint = helpers.readJson(checkpointPath);
    assert(checkpoint !== null, 'checkpoint should be valid JSON');
    assert(checkpoint.session.mode === 'mylight',
      `checkpoint session mode should be mylight, got ${checkpoint.session.mode}`);
    assert(checkpoint.session.current_phase === 'light_execution',
      `checkpoint phase should be light_execution, got ${checkpoint.session.current_phase}`);
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
