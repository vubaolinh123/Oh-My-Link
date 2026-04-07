/**
 * Oh-My-Link — New Test Suites (Set 2)
 * Comprehensive pre-tool-enforcer and post-tool-verifier tests
 * Comprehensive pre-tool-enforcer and post-tool-verifier edge cases.
 * Run: node test/new-tests-2.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-new2-${Date.now()}`);
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

function runEnforcerHook(toolName, role, toolInput = {}) {
  const hookPath = path.join(DIST, 'hooks', 'pre-tool-enforcer.js');
  const inputFile = path.join(TEMP_ROOT, `enforcer-${role}-${toolName}-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({
    hook: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: 'src/test.ts', ...toolInput },
    cwd: TEMP_PROJECT,
  }));
  const cmd = `node "${hookPath}" < "${inputFile}"`;
  const env = {
    ...process.env,
    OML_HOME: process.env.OML_HOME,
    OML_QUIET: '3',
  };
  if (role !== null && role !== undefined) {
    env.OML_AGENT_ROLE = role;
  } else {
    delete env.OML_AGENT_ROLE;
  }
  const output = execSync(cmd, {
    cwd: TEMP_PROJECT,
    timeout: 10000,
    env,
    shell: true,
  }).toString().trim();
  return JSON.parse(output);
}

function runVerifierHook(toolName, toolInput, toolOutput) {
  const hookPath = path.join(DIST, 'hooks', 'post-tool-verifier.js');
  const inputFile = path.join(TEMP_ROOT, `verifier-${toolName}-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({
    hook: 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_output: toolOutput,
    cwd: TEMP_PROJECT,
  }));
  const cmd = `node "${hookPath}" < "${inputFile}"`;
  const output = execSync(cmd, {
    cwd: TEMP_PROJECT,
    timeout: 10000,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, OML_QUIET: '3' },
    shell: true,
  }).toString().trim();
  return JSON.parse(output);
}

console.log('Oh-My-Link — New Test Suites (Set 2)');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Suite 1: pre-tool-enforcer — role enforcement removed (prompt-based)
// ============================================================

suite('pre-tool-enforcer — role enforcement removed (prompt-based)', () => {
  // Role enforcement via OML_AGENT_ROLE env var was removed because CC's hook model
  // never sets this env var (hooks are separate processes). Enforcement is now prompt-based.
  function beforeEach() {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
  }

  test('allows Write without role restriction', () => {
    beforeEach();
    const parsed = runEnforcerHook('Write', 'reviewer', { file_path: 'src/app.ts' });
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'Write should be allowed (role enforcement removed)');
  });

  test('allows Edit without role restriction', () => {
    beforeEach();
    const parsed = runEnforcerHook('Edit', 'scout');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'Edit should be allowed (role enforcement removed)');
  });

  test('allows Agent without role restriction', () => {
    beforeEach();
    const parsed = runEnforcerHook('Agent', 'worker');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'Agent should be allowed (role enforcement removed)');
  });
});

// ============================================================
// Suite 2: pre-tool-enforcer — dangerous Bash
// ============================================================

suite('pre-tool-enforcer — dangerous Bash', () => {
  function beforeEach() {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
  }

  test('blocks rm -rf /', () => {
    beforeEach();
    const parsed = runEnforcerHook('Bash', 'worker', { command: 'rm -rf /' });
    assert(parsed.hookSpecificOutput?.permissionDecision === 'deny',
      'rm -rf / should be denied');
  });

  test('blocks DROP DATABASE', () => {
    beforeEach();
    const parsed = runEnforcerHook('Bash', 'worker', { command: 'DROP DATABASE users' });
    assert(parsed.hookSpecificOutput?.permissionDecision === 'deny',
      'DROP DATABASE should be denied');
  });

  test('warns on git push --force', () => {
    beforeEach();
    const parsed = runEnforcerHook('Bash', 'worker', { command: 'git push --force' });
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'git push --force should NOT be denied');
    const ctx = parsed.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('WARNING'),
      `git push --force should produce WARNING, got: ${ctx}`);
  });

  test('blocks find / -delete', () => {
    beforeEach();
    const parsed = runEnforcerHook('Bash', 'worker', { command: 'find / -name "*.tmp" -delete' });
    assert(parsed.hookSpecificOutput?.permissionDecision === 'deny',
      'find / -delete should be denied');
  });

  test('warns on npm publish', () => {
    beforeEach();
    const parsed = runEnforcerHook('Bash', 'worker', { command: 'npm publish' });
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'npm publish should NOT be denied');
    const ctx = parsed.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('WARNING'),
      `npm publish should produce WARNING, got: ${ctx}`);
  });

  test('allows normal git push', () => {
    beforeEach();
    const parsed = runEnforcerHook('Bash', 'worker', { command: 'git push origin main' });
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'normal git push should not be denied');
    const ctx = parsed.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('WARNING'),
      `normal git push should NOT produce warning, got: ${ctx}`);
  });
});

// ============================================================
// Suite 3: pre-tool-enforcer — no session behavior
// ============================================================

suite('pre-tool-enforcer — no session behavior', () => {
  test('allows tool when no session exists', () => {
    deleteSession();
    const parsed = runEnforcerHook('Edit', null);
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'Edit should be allowed when no session exists');
  });

  test('allows tool with any role when no session exists', () => {
    deleteSession();
    const parsed = runEnforcerHook('Edit', 'reviewer');
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'Edit should be allowed (role enforcement removed)');
  });
});

// ============================================================
// Suite 4: post-tool-verifier — failure detection scope
// ============================================================

suite('post-tool-verifier — failure detection scope', () => {
  test('detects TypeScript errors in Bash output', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution', failure_count: 0 });
    runVerifierHook('Bash', { command: 'npm run build' }, "error TS2304: Cannot find name 'foo'");
    const session = readSession();
    assert(session !== null, 'session should exist');
    assert(session.failure_count >= 1,
      `failure_count should be >= 1 for TS error, got ${session.failure_count}`);
  });

  test('does NOT detect errors in Read output', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution', failure_count: 0 });
    runVerifierHook('Read', { file_path: 'src/errors.ts' }, 'error TS2304 in the file');
    const session = readSession();
    assert(session !== null, 'session should exist');
    assertEqual(session.failure_count, 0,
      'failure_count should remain 0 for Read tool');
  });

  test('detects npm errors in Bash output', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution', failure_count: 0 });
    runVerifierHook('Bash', { command: 'npm install' }, 'npm ERR! code ENOENT');
    const session = readSession();
    assert(session !== null, 'session should exist');
    assert(session.failure_count >= 1,
      `failure_count should be >= 1 for npm error, got ${session.failure_count}`);
  });

  test('tracks failure in tool-tracking.json', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution', failure_count: 0 });
    // Clean tool-tracking.json
    const trackPath = path.join(state.getProjectStateRoot(TEMP_PROJECT), 'tool-tracking.json');
    try { fs.unlinkSync(trackPath); } catch { /* ignore */ }
    state.ensureDir(path.dirname(trackPath));

    runVerifierHook('Bash', { command: 'npm test' }, "error TS2304: Cannot find name 'bar'");

    const tracking = helpers.readJson(trackPath);
    assert(tracking !== null, 'tool-tracking.json should exist');
    assert(Array.isArray(tracking.failures), 'tracking should have failures array');
    assert(tracking.failures.length >= 1,
      `failures array should have at least 1 entry, got ${tracking.failures.length}`);
    assert(tracking.failures.some(f => f.tool === 'Bash'),
      'failures should contain a Bash entry');
  });
});

// ============================================================
// Suite 5: post-tool-verifier — remember tags
// ============================================================

suite('post-tool-verifier — remember tags', () => {
  test('<remember> appends to working-memory.md', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    // Clean working memory
    const wmPath = state.getWorkingMemoryPath(TEMP_PROJECT);
    try { fs.unlinkSync(wmPath); } catch { /* ignore */ }

    runVerifierHook('Bash', { command: 'echo test' },
      'some output <remember>Always use pnpm</remember> more output');

    assert(fs.existsSync(wmPath), 'working-memory.md should exist');
    const content = fs.readFileSync(wmPath, 'utf-8');
    assert(content.includes('Always use pnpm'),
      `working-memory.md should contain 'Always use pnpm', got: ${content}`);
  });

  test('<remember priority> appends to priority-context.md', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    // Clean priority context
    const priPath = state.getPriorityContextPath(TEMP_PROJECT);
    try { fs.unlinkSync(priPath); } catch { /* ignore */ }

    runVerifierHook('Bash', { command: 'echo test' },
      'output <remember priority>Critical: never modify auth.ts</remember> done');

    assert(fs.existsSync(priPath), 'priority-context.md should exist');
    const content = fs.readFileSync(priPath, 'utf-8');
    assert(content.includes('Critical: never modify auth.ts'),
      `priority-context.md should contain the critical note, got: ${content}`);
  });

  test('<remember priority> deduplicates', () => {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
    // Clean priority context
    const priPath = state.getPriorityContextPath(TEMP_PROJECT);
    try { fs.unlinkSync(priPath); } catch { /* ignore */ }

    // Send same priority remember twice
    runVerifierHook('Bash', { command: 'echo 1' },
      '<remember priority>Unique rule ABC</remember>');
    runVerifierHook('Bash', { command: 'echo 2' },
      '<remember priority>Unique rule ABC</remember>');

    const content = fs.readFileSync(priPath, 'utf-8');
    // Count occurrences of the content (excluding timestamp prefix)
    const matches = content.split('\n').filter(line => line.includes('Unique rule ABC'));
    assertEqual(matches.length, 1,
      `should only have 1 entry for deduplicated remember, got ${matches.length}`);
  });
});

// ============================================================
// Suite 6: pre-tool-enforcer — file path restrictions
// ============================================================

suite('pre-tool-enforcer — file path restrictions removed (prompt-based)', () => {
  // File path restrictions via OML_AGENT_ROLE were removed because CC's hook model
  // never sets env vars. All file path restrictions are now prompt-based.
  function beforeEach() {
    writeSession({ active: true, mode: 'mylink', current_phase: 'phase_5_execution' });
  }

  test('any role can Write to any file (role enforcement removed)', () => {
    beforeEach();
    const parsed = runEnforcerHook('Write', 'test-engineer', { file_path: 'src/auth.ts' });
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'Write should be allowed (role enforcement removed)');
  });

  test('any role can Write to test files', () => {
    beforeEach();
    const parsed = runEnforcerHook('Write', 'scout', { file_path: 'src/auth.test.ts' });
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'Write should be allowed (role enforcement removed)');
  });

  test('any role can Write to .oh-my-link/', () => {
    beforeEach();
    const parsed = runEnforcerHook('Write', 'master', { file_path: '.oh-my-link/plans/plan.md' });
    assert(parsed.hookSpecificOutput?.permissionDecision !== 'deny',
      'Write should be allowed (role enforcement removed)');
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
