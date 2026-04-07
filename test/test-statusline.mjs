/**
 * Oh-My-Link — Statusline Tests
 * Tests for dist/statusline.js output formatting.
 * Run: node test/test-statusline.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-statusline-${Date.now()}`);
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

function deleteSession() {
  const sessionPath = state.getSessionPath(TEMP_PROJECT);
  try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }
}

function runStatusline(stdinData = {}, envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `sl-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ cwd: TEMP_PROJECT, ...stdinData }));
  const cmd = `node "${path.join(DIST, 'statusline.js')}" < "${inputFile}"`;
  const output = execSync(cmd, {
    timeout: 10000, encoding: 'utf-8', shell: true,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides }
  }).trim();
  return output;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[\d+m/g, '');
}

function normalize(str) {
  return stripAnsi(str).replace(/\u00A0/g, ' ');
}

console.log('Oh-My-Link — Statusline Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Suite 1: Idle State
// ============================================================

suite('statusline — idle state', () => {
  test('shows OML version and idle when no session', () => {
    deleteSession();
    const raw = runStatusline();
    const output = normalize(raw);
    assert(output.includes('OML#'), `expected 'OML#' in output, got: ${output}`);
    assert(output.toLowerCase().includes('idle'), `expected 'idle' in output, got: ${output}`);
  });

  test('shows context percentage when idle', () => {
    deleteSession();
    const raw = runStatusline({ context_window: { used_percentage: 25 } });
    const output = normalize(raw);
    assert(output.includes('25%'), `expected '25%' in output, got: ${output}`);
  });
});

// ============================================================
// Suite 2: Start Link Mode
// ============================================================

suite('statusline — Start Link mode', () => {
  test('shows Start.Link and phase name', () => {
    writeSession({ mode: 'mylink', current_phase: 'phase_5_execution' });
    const raw = runStatusline();
    const output = normalize(raw);
    assert(output.includes('Start.Link'), `expected 'Start.Link' in output, got: ${output}`);
    assert(output.includes('Execution') || output.includes('Phase 5'),
      `expected 'Execution' or 'Phase 5' in output, got: ${output}`);
  });

  test('shows bootstrap phase', () => {
    writeSession({ mode: 'mylink', current_phase: 'bootstrap' });
    const raw = runStatusline();
    const output = normalize(raw);
    assert(output.includes('Bootstrapping') || output.includes('Bootstrap'),
      `expected 'Bootstrapping' or 'Bootstrap' in output, got: ${output}`);
  });
});

// ============================================================
// Suite 3: Start Fast Mode
// ============================================================

suite('statusline — Start Fast mode', () => {
  test('shows Start.Fast and Turbo', () => {
    writeSession({ mode: 'mylight', current_phase: 'light_turbo' });
    const raw = runStatusline();
    const output = normalize(raw);
    assert(output.includes('Start.Fast'), `expected 'Start.Fast' in output, got: ${output}`);
    assert(output.includes('Turbo'), `expected 'Turbo' in output, got: ${output}`);
  });

  test('shows Start.Fast Analyzing', () => {
    writeSession({ mode: 'mylight', current_phase: 'light_scout' });
    const raw = runStatusline();
    const output = normalize(raw);
    assert(output.includes('Analyzing'), `expected 'Analyzing' in output, got: ${output}`);
  });
});

// ============================================================
// Suite 4: Context Bar
// ============================================================

suite('statusline — context bar', () => {
  test('shows context bar with percentage', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    const raw = runStatusline({ context_window: { used_percentage: 62 } });
    const output = normalize(raw);
    assert(output.includes('62%'), `expected '62%' in output, got: ${output}`);
  });

  test('shows CRITICAL at >=85%', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    const raw = runStatusline({ context_window: { used_percentage: 85 } });
    const output = normalize(raw);
    assert(output.includes('CRITICAL'), `expected 'CRITICAL' in output, got: ${output}`);
  });
});

// ============================================================
// Suite 5: Counters
// ============================================================

suite('statusline — counters', () => {
  test('shows reinforcement and failure counters', () => {
    writeSession({
      mode: 'mylink',
      current_phase: 'phase_5_execution',
      reinforcement_count: 3,
      failure_count: 1,
    });
    const raw = runStatusline();
    const output = normalize(raw);
    assert(output.includes('R:3'), `expected 'R:3' in output, got: ${output}`);
    assert(output.includes('F:1'), `expected 'F:1' in output, got: ${output}`);
  });

  test('Start Fast hides reinforcement counter', () => {
    writeSession({
      mode: 'mylight',
      current_phase: 'light_turbo',
      reinforcement_count: 2,
      failure_count: 1,
    });
    const raw = runStatusline();
    const output = normalize(raw);
    assert(!output.includes('R:'), `expected NO 'R:' in Start.Fast output, got: ${output}`);
    assert(output.includes('F:'), `expected 'F:' in Start.Fast output, got: ${output}`);
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
