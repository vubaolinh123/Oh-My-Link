/**
 * Oh-My-Link — Session Start Hook Tests
 * Tests for dist/hooks/session-start.js
 * Run: node test/test-session-start.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-ss-${Date.now()}`);
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

// Ensure dirs needed by session-start
state.ensureDir(state.getProjectStateRoot(TEMP_PROJECT));

console.log('Oh-My-Link — Session Start Hook Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Helpers
// ============================================================

function runSessionStart(inputOverrides = {}, envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `ss-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ cwd: TEMP_PROJECT, session_id: 'test', ...inputOverrides }));
  const cmd = `node "${path.join(DIST, 'hooks', 'session-start.js')}" < "${inputFile}"`;
  return JSON.parse(execSync(cmd, {
    timeout: 10000, encoding: 'utf-8', shell: true,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides }
  }).trim());
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

function deleteSession() {
  const sessionPath = state.getSessionPath(TEMP_PROJECT);
  try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }
}

// ============================================================
// Suite 1: Basic I/O
// ============================================================

suite('session-start — Basic I/O', () => {
  test('returns continue: true and valid JSON', () => {
    deleteSession();
    const result = runSessionStart();
    assertEqual(result.continue, true, 'continue should be true');
    assert(typeof result === 'object', 'result should be an object');
  });

  test('creates runtime and artifact directories', () => {
    deleteSession();
    runSessionStart();
    // Runtime dir: OML_HOME/projects/{hash}
    const stateRoot = state.getProjectStateRoot(TEMP_PROJECT);
    assert(fs.existsSync(stateRoot), `runtime state dir should exist: ${stateRoot}`);
    // Artifact dir: TEMP_PROJECT/.oh-my-link/plans
    const plansDir = path.join(TEMP_PROJECT, '.oh-my-link', 'plans');
    assert(fs.existsSync(plansDir), `artifact plans dir should exist: ${plansDir}`);
  });
});

// ============================================================
// Suite 2: Startup Banner
// ============================================================

suite('session-start — Startup Banner', () => {
  test('shows version banner when no active session (quiet=0)', () => {
    deleteSession();
    const result = runSessionStart({}, { OML_QUIET: '0' });
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('oh-my-link v'), `should include version banner, got: ${ctx.slice(0, 200)}`);
    assert(ctx.includes('loaded'), `should include "loaded", got: ${ctx.slice(0, 200)}`);
  });

  test('no banner at quiet=2', () => {
    deleteSession();
    const result = runSessionStart({}, { OML_QUIET: '2' });
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('oh-my-link v'), `should NOT include version banner at quiet=2, got: ${ctx.slice(0, 200)}`);
  });
});

// ============================================================
// Suite 3: Active Session Resume
// ============================================================

suite('session-start — Active Session Resume', () => {
  test('shows active session banner for Start Link', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    const result = runSessionStart();
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('Start Link'), `should mention Start Link, got: ${ctx.slice(0, 300)}`);
    assert(ctx.includes('phase_5_execution'), `should mention phase, got: ${ctx.slice(0, 300)}`);
    assert(ctx.includes('ACTIVE SESSION DETECTED'), `should include ACTIVE SESSION DETECTED, got: ${ctx.slice(0, 300)}`);
  });

  test('shows resume options for Start Fast', () => {
    writeSession({ active: true, mode: 'mylight', current_phase: 'light_execution' });
    const result = runSessionStart();
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('ACTIVE Start Fast SESSION'), `should mention active Start Fast session, got: ${ctx.slice(0, 400)}`);
    assert(ctx.includes('Options'), `should include Options, got: ${ctx.slice(0, 400)}`);
    assert(ctx.includes('Resume'), `should include Resume option, got: ${ctx.slice(0, 400)}`);
    assert(ctx.includes('Cancel'), `should include Cancel option, got: ${ctx.slice(0, 400)}`);
  });

  test('shows failure count in resume banner', () => {
    writeSession({ active: true, mode: 'mylight', current_phase: 'light_execution', failure_count: 3 });
    const result = runSessionStart();
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('Retries: 3'), `should show failure count as Retries: 3, got: ${ctx.slice(0, 400)}`);
  });
});

// ============================================================
// Suite 4: Project Memory Injection
// ============================================================

suite('session-start — Project Memory Injection', () => {
  test('injects project memory summary when memory exists', () => {
    deleteSession();
    const memPath = state.getProjectMemoryPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(memPath));
    helpers.writeJsonAtomic(memPath, {
      tech_stack: {
        runtime: 'node',
        language: 'typescript',
        pkg: 'npm',
      },
      hot_paths: [],
      user_directives: [{ directive: 'Always use strict mode', priority: 'high', added_at: new Date().toISOString() }],
      notes: [],
      last_scanned_at: new Date().toISOString(),
    });
    const result = runSessionStart();
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('Project Memory'), `should include Project Memory section, got: ${ctx.slice(0, 400)}`);
  });

  test('rescans if memory is stale', () => {
    deleteSession();
    const memPath = state.getProjectMemoryPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(memPath));
    // Write memory with old last_scanned_at (30 days ago)
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    helpers.writeJsonAtomic(memPath, {
      tech_stack: {
        runtime: 'node',
        language: 'javascript',
        pkg: 'npm',
      },
      hot_paths: [],
      user_directives: [],
      notes: [],
      last_scanned_at: oldDate,
    });
    const result = runSessionStart();
    // After rescan, the memory should be updated
    const updatedMem = helpers.readJson(memPath);
    assert(updatedMem !== null, 'memory should still exist after rescan');
    assert(updatedMem.last_scanned_at !== oldDate, `last_scanned_at should be updated from ${oldDate}, got ${updatedMem.last_scanned_at}`);
  });
});

// ============================================================
// Suite 5: Priority Context Injection
// ============================================================

suite('session-start — Priority Context Injection', () => {
  test('injects priority context when file exists', () => {
    deleteSession();
    const priPath = state.getPriorityContextPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(priPath));
    fs.writeFileSync(priPath, 'CRITICAL: Always run tests before committing', 'utf-8');
    const result = runSessionStart();
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('Priority Context'), `should include Priority Context section, got: ${ctx.slice(0, 400)}`);
    assert(ctx.includes('Always run tests'), `should include priority content, got: ${ctx.slice(0, 400)}`);
  });

  test('omits priority context when file missing', () => {
    deleteSession();
    const priPath = state.getPriorityContextPath(TEMP_PROJECT);
    try { fs.unlinkSync(priPath); } catch { /* ignore */ }
    const result = runSessionStart();
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('Priority Context'), `should NOT include Priority Context when file missing, got: ${ctx.slice(0, 400)}`);
  });
});

// ============================================================
// Suite 6: Post-Compaction Resume
// ============================================================

suite('session-start — Post-Compaction Resume', () => {
  test('loads checkpoint on compact source', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    const checkpointPath = state.getCheckpointPath(TEMP_PROJECT);
    state.ensureDir(path.dirname(checkpointPath));
    helpers.writeJsonAtomic(checkpointPath, {
      session: {
        current_phase: 'phase_5_execution',
        feature_slug: 'auth-refactor',
        reinforcement_count: 2,
      },
      created_at: new Date().toISOString(),
      active_agents: [],
    });
    const result = runSessionStart({ source: 'compact' });
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('POST-COMPACTION'), `should mention POST-COMPACTION, got: ${ctx.slice(0, 500)}`);
    assert(ctx.includes('auth-refactor'), `should mention feature slug, got: ${ctx.slice(0, 500)}`);
    assert(ctx.includes('RESUME STEPS'), `should include RESUME STEPS, got: ${ctx.slice(0, 800)}`);
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
