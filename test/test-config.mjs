/**
 * Oh-My-Link — Config Module Tests
 * Tests for dist/config.js
 * Run: node test/test-config.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-config-${Date.now()}`);
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
const config = require(path.join(DIST, 'config.js'));

// Ensure dirs
state.ensureDir(state.getProjectStateRoot(TEMP_PROJECT));

console.log('Oh-My-Link — Config Module Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Suite 1: DEFAULT_MODELS
// ============================================================

suite('DEFAULT_MODELS', () => {
  test('DEFAULT_MODELS has all 12 roles', () => {
    const expectedRoles = [
      'master', 'scout', 'fast-scout', 'architect', 'worker', 'reviewer',
      'explorer', 'executor', 'verifier', 'code-reviewer', 'security-reviewer', 'test-engineer',
    ];
    const modelKeys = Object.keys(config.DEFAULT_MODELS);
    for (const role of expectedRoles) {
      assert(modelKeys.includes(role), `Missing role: ${role}`);
    }
    assertEqual(modelKeys.length, 12, 'DEFAULT_MODELS key count');
  });
});

// ============================================================
// Suite 2: loadConfig
// ============================================================

suite('loadConfig', () => {
  test('loadConfig returns defaults when no config file', () => {
    // Ensure no config file exists
    const configPath = state.getConfigPath();
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }

    const cfg = config.loadConfig();
    assert(cfg.models !== undefined, 'config should have models object');
    assertEqual(cfg.quiet_level, 0, 'default quiet_level');
  });

  test('loadConfig merges user overrides', () => {
    const configPath = state.getConfigPath();
    state.ensureDir(path.dirname(configPath));
    helpers.writeJsonAtomic(configPath, {
      models: { master: 'custom-model' },
      quiet_level: 1,
    });

    const cfg = config.loadConfig();
    assertEqual(cfg.models.master, 'custom-model', 'user override for master model');
    assertEqual(cfg.quiet_level, 1, 'user override for quiet_level');

    // Clean up
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  });

  test('loadConfig handles invalid JSON', () => {
    const configPath = state.getConfigPath();
    state.ensureDir(path.dirname(configPath));
    fs.writeFileSync(configPath, '{{{{not valid json!!!!}}}}', 'utf-8');

    const cfg = config.loadConfig();
    assert(cfg.models !== undefined, 'config should still have models object');
    assertEqual(cfg.quiet_level, 0, 'should return default quiet_level for invalid JSON');

    // Clean up
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }
  });
});

// ============================================================
// Suite 3: getModelForRole
// ============================================================

suite('getModelForRole', () => {
  test('getModelForRole returns default for known role', () => {
    // Ensure no config overrides
    const configPath = state.getConfigPath();
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }

    const model = config.getModelForRole('master');
    assertEqual(model, 'claude-opus-4-6', 'master default model');
  });

  test('getModelForRole returns worker fallback for unknown role', () => {
    // Ensure no config overrides
    const configPath = state.getConfigPath();
    try { fs.unlinkSync(configPath); } catch { /* ignore */ }

    const model = config.getModelForRole('unknown');
    assertEqual(model, config.DEFAULT_MODELS.worker, 'unknown role should fallback to worker model');
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
