/**
 * Oh-My-Link — Session Audit & Hardening Tests
 * Tests for session-write-audit, locked_* hardening, and isDebugMode
 * Run: node test/test-session-audit.mjs
 */

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

// ============================================================
// Minimal test harness (same pattern as test-mcp-config.mjs)
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-session-audit-${Date.now()}`);
const OML_HOME = path.join(TEMP_ROOT, 'oml-home');
const TEMP_PROJECT = path.join(TEMP_ROOT, 'test-project');

function setupTempDirs() {
  fs.mkdirSync(OML_HOME, { recursive: true });
  fs.mkdirSync(TEMP_PROJECT, { recursive: true });
  process.env.OML_HOME = OML_HOME;
}

function cleanupTempDirs() {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch { /* best effort */ }
  delete process.env.OML_HOME;
}

/** Write the global config.json (debug_mode on by default). */
function writeGlobalConfig(config = { debug_mode: true }) {
  fs.writeFileSync(path.join(OML_HOME, 'config.json'), JSON.stringify(config), 'utf-8');
}

/** Remove the global config if it exists. */
function removeGlobalConfig() {
  try { fs.unlinkSync(path.join(OML_HOME, 'config.json')); } catch { /* ignore */ }
}

/** Get the audit log path. */
function auditLogPath() {
  return path.join(OML_HOME, 'session-write-audit.log');
}

/** Read the audit log contents (empty string if not present). */
function readAuditLog() {
  try { return fs.readFileSync(auditLogPath(), 'utf-8'); } catch { return ''; }
}

/** Remove the audit log so each test starts clean. */
function clearAuditLog() {
  try { fs.unlinkSync(auditLogPath()); } catch { /* ignore */ }
}

setupTempDirs();
writeGlobalConfig({ debug_mode: true });

// Load module
const helpers = require(path.join(DIST, 'helpers.js'));
const { writeJsonAtomic, readJson, isDebugMode, sessionWriteAudit } = helpers;

console.log('Oh-My-Link — Session Audit & Hardening Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Suite 1: Session-write audit
// ============================================================

suite('Session-write audit', () => {
  clearAuditLog();

  test('Writing a non-session JSON file should NOT create an audit entry', () => {
    clearAuditLog();
    const nonSessionPath = path.join(TEMP_ROOT, 'data', 'something.json');
    writeJsonAtomic(nonSessionPath, { foo: 'bar' });

    const log = readAuditLog();
    assertEqual(log, '', 'audit log should be empty for non-session writes');
  });

  test('Writing session.json should create an audit entry with expected fields', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'proj1');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'scouting',
      mode: 'link',
    });

    const log = readAuditLog();
    assert(log.length > 0, 'audit log should not be empty');
    // Should contain WRITE keyword
    assert(log.includes('WRITE'), 'audit entry should contain WRITE');
    // Should contain phase info
    assert(log.includes('phase=scouting'), 'audit entry should contain phase');
    // Should contain active info
    assert(log.includes('active=true'), 'audit entry should contain active');
    // Should contain pid
    assert(log.includes(`pid=${process.pid}`), 'audit entry should contain pid');
    // Should contain argv
    assert(log.includes('argv='), 'audit entry should contain argv');
    // Should contain a timestamp (ISO 8601 pattern)
    assert(/\[\d{4}-\d{2}-\d{2}T/.test(log), 'audit entry should contain timestamp');
  });

  test('Multiple session.json writes should append multiple audit entries', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'proj-multi');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    writeJsonAtomic(sessionPath, { active: true, current_phase: 'init', mode: 'link' });
    writeJsonAtomic(sessionPath, { active: true, current_phase: 'scouting', mode: 'link' });
    writeJsonAtomic(sessionPath, { active: false, current_phase: 'complete', mode: 'link' });

    const log = readAuditLog();
    // Each WRITE produces one entry; count occurrences of "WRITE phase="
    const writeMatches = log.match(/WRITE phase=/g);
    assert(writeMatches !== null, 'should find WRITE entries');
    assert(writeMatches.length >= 3, `should have at least 3 WRITE entries, got ${writeMatches.length}`);
  });
});

// ============================================================
// Suite 2: locked_* hardening
// ============================================================

suite('locked_* hardening', () => {
  clearAuditLog();

  test('Writing session.json with different locked_mode — should preserve old value', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'locked-mode-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Write initial session with locked_mode
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'link',
      locked_mode: 'link',
    });

    clearAuditLog();

    // Try to overwrite locked_mode
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'fast',
      locked_mode: 'fast',
    });

    // Read back — locked_mode should still be 'link'
    const written = readJson(sessionPath);
    assertEqual(written.locked_mode, 'link', 'locked_mode should be preserved as original value');

    // Audit log should contain LOCKED_FIELD_CORRECTED
    const log = readAuditLog();
    assert(log.includes('LOCKED_FIELD_CORRECTED'), 'should log LOCKED_FIELD_CORRECTED');
    assert(log.includes('locked_mode'), 'should mention locked_mode in correction log');
  });

  test('Writing session.json with different locked_phase — should preserve old value', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'locked-phase-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Write initial session with locked_phase
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'link',
      locked_phase: 'work',
    });

    clearAuditLog();

    // Try to overwrite locked_phase
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'review',
      mode: 'link',
      locked_phase: 'review',
    });

    // Read back — locked_phase should still be 'work'
    const written = readJson(sessionPath);
    assertEqual(written.locked_phase, 'work', 'locked_phase should be preserved as original value');

    // Audit log should contain LOCKED_FIELD_CORRECTED
    const log = readAuditLog();
    assert(log.includes('LOCKED_FIELD_CORRECTED'), 'should log LOCKED_FIELD_CORRECTED');
    assert(log.includes('locked_phase'), 'should mention locked_phase in correction log');
  });

  test('Writing session.json where incoming omits locked_mode — old value carried forward', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'locked-omit-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Write initial session with locked_mode
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'link',
      locked_mode: 'link',
    });

    // Write again WITHOUT locked_mode — it should be carried forward
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'review',
      mode: 'link',
    });

    const written = readJson(sessionPath);
    assertEqual(written.locked_mode, 'link', 'locked_mode should be carried forward when omitted');
  });

  test('Writing session.json where existing has no locked fields — should write normally', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'no-locked-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Write initial session WITHOUT locked fields
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'init',
      mode: 'link',
    });

    clearAuditLog();

    // Write again WITH locked_mode — should write as-is (no existing locked fields to protect)
    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'work',
      mode: 'link',
      locked_mode: 'link',
      locked_phase: 'work',
    });

    const written = readJson(sessionPath);
    assertEqual(written.locked_mode, 'link', 'locked_mode should be written normally');
    assertEqual(written.locked_phase, 'work', 'locked_phase should be written normally');

    // No LOCKED_FIELD_CORRECTED should appear
    const log = readAuditLog();
    assert(!log.includes('LOCKED_FIELD_CORRECTED'), 'should NOT log correction when no existing locked fields');
  });

  test('Writing a brand new session.json (no existing file) — should write as-is', () => {
    clearAuditLog();
    const sessionDir = path.join(TEMP_ROOT, 'brand-new-session');
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'session.json');

    // Ensure file does not exist
    try { fs.unlinkSync(sessionPath); } catch { /* ignore */ }

    writeJsonAtomic(sessionPath, {
      active: true,
      current_phase: 'init',
      mode: 'link',
      locked_mode: 'link',
      locked_phase: 'init',
    });

    const written = readJson(sessionPath);
    assertEqual(written.active, true, 'active should be written');
    assertEqual(written.locked_mode, 'link', 'locked_mode should be written as-is');
    assertEqual(written.locked_phase, 'init', 'locked_phase should be written as-is');

    // No LOCKED_FIELD_CORRECTED since there was no existing file
    const log = readAuditLog();
    assert(!log.includes('LOCKED_FIELD_CORRECTED'), 'should NOT log correction for brand-new file');
  });
});

// ============================================================
// Suite 3: parseHookInput raw payload capture (SKIPPED)
// ============================================================

suite('parseHookInput raw payload capture', () => {
  skip('parseHookInput reads from process.stdin — stdin capture via pipe. Tested manually.');
  skip('captureRawPayload is not exported — cannot test directly. Tested manually.');
  skip('Debug payload files written to $OML_HOME/debug/payloads/. Tested manually.');
});

// ============================================================
// Suite 4: isDebugMode helper
// ============================================================

suite('isDebugMode helper', () => {

  test('With global config debug_mode: true — should return true', () => {
    writeGlobalConfig({ debug_mode: true });
    const result = isDebugMode();
    assertEqual(result, true, 'isDebugMode should return true');
  });

  test('With global config debug_mode: false — should return false', () => {
    writeGlobalConfig({ debug_mode: false });
    const result = isDebugMode();
    assertEqual(result, false, 'isDebugMode should return false');
  });

  test('With no config file — should return false', () => {
    removeGlobalConfig();
    const result = isDebugMode();
    assertEqual(result, false, 'isDebugMode should return false when no config');
  });

  test('With project-level config debug_mode: true and no global — should return true', () => {
    removeGlobalConfig();
    // Create project-level config
    const projectOml = path.join(TEMP_PROJECT, '.oh-my-link');
    fs.mkdirSync(projectOml, { recursive: true });
    fs.writeFileSync(
      path.join(projectOml, 'config.json'),
      JSON.stringify({ debug_mode: true }),
      'utf-8'
    );

    const result = isDebugMode(TEMP_PROJECT);
    assertEqual(result, true, 'isDebugMode should return true from project config');

    // Cleanup project config
    try { fs.rmSync(projectOml, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// ============================================================
// Cleanup & Summary
// ============================================================

cleanupTempDirs();

console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('========================================');

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
