/**
 * Oh-My-Link — New Test Suite 4
 * Subagent lifecycle + deliverable verification tests.
 * Run: node test/new-tests-4.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-test4-${Date.now()}`);
const TEMP_PROJECT = path.join(TEMP_ROOT, 'test-project');

function setupTempDirs() {
  fs.mkdirSync(TEMP_PROJECT, { recursive: true });
  fs.mkdirSync(path.join(TEMP_PROJECT, 'src'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_PROJECT, 'test'), { recursive: true });
  fs.mkdirSync(path.join(TEMP_PROJECT, 'tests'), { recursive: true });
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

// Ensure runtime dirs
state.ensureRuntimeDirs(TEMP_PROJECT);
state.ensureArtifactDirs(TEMP_PROJECT);

// ============================================================
// Helpers
// ============================================================

const HOOK_PATH = path.join(DIST, 'hooks', 'subagent-lifecycle.js');

function runHook(mode, inputData, envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `subagent-${mode}-${Date.now()}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ cwd: TEMP_PROJECT, ...inputData }));
  const cmd = `node "${HOOK_PATH}" ${mode} < "${inputFile}"`;
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

function cleanSession() {
  try { fs.unlinkSync(state.getSessionPath(TEMP_PROJECT)); } catch {}
}

function cleanTracking() {
  const trackingPath = state.getSubagentTrackingPath(TEMP_PROJECT);
  try { fs.unlinkSync(trackingPath); } catch {}
}

function readTracking() {
  const trackingPath = state.getSubagentTrackingPath(TEMP_PROJECT);
  return helpers.readJson(trackingPath) || [];
}

// ============================================================
// Suite 1: subagent-lifecycle — start tracking
// ============================================================

suite('subagent-lifecycle — start tracking', () => {
  test('start records agent in tracking file', () => {
    cleanTracking();
    const result = runHook('start', {
      agent_id: 'agent-test-1',
      agent_type: 'oh-my-link:scout',
      agent_description: 'Scout for testing',
      agent_prompt: 'Analyze the codebase',
    });
    assert(!result.error, `should not error: ${result.error}`);

    const tracking = readTracking();
    assert(tracking.length >= 1, 'should have at least 1 record');
    const record = tracking.find(r => r.agent_id === 'agent-test-1');
    assert(record, 'should find our agent');
    assertEqual(record.role, 'scout', 'role should be detected as scout');
    assertEqual(record.status, 'running', 'status should be running');
  });

  test('start detects role from agent_type (oh-my-link: prefix)', () => {
    cleanTracking();
    const roles = [
      ['oh-my-link:architect', 'architect'],
      ['oh-my-link:worker', 'worker'],
      ['oh-my-link:reviewer', 'reviewer'],
      ['oh-my-link:fast-scout', 'fast-scout'],
      ['oh-my-link:code-reviewer', 'code-reviewer'],
      ['oh-my-link:test-engineer', 'test-engineer'],
    ];

    for (const [agentType, expectedRole] of roles) {
      cleanTracking();
      runHook('start', {
        agent_id: `agent-${expectedRole}`,
        agent_type: agentType,
        agent_description: 'Test',
        agent_prompt: 'Test prompt',
      });
      const tracking = readTracking();
      const record = tracking.find(r => r.agent_id === `agent-${expectedRole}`);
      assert(record, `should find record for ${expectedRole}`);
      assertEqual(record.role, expectedRole, `role should be ${expectedRole}`);
    }
  });

  test('start detects role from description keywords (fallback)', () => {
    cleanTracking();
    runHook('start', {
      agent_id: 'agent-desc-scout',
      agent_type: '',
      agent_description: 'A scout agent that reads the codebase',
      agent_prompt: '',
    });
    const tracking = readTracking();
    const record = tracking.find(r => r.agent_id === 'agent-desc-scout');
    assert(record, 'should find record');
    assertEqual(record.role, 'scout', 'role should be detected from description');
  });

  test('start uses OML_AGENT_ROLE env as fallback', () => {
    cleanTracking();
    runHook('start', {
      agent_id: 'agent-env-role',
      agent_type: '',
      agent_description: 'Generic agent',
      agent_prompt: '',
    }, { OML_AGENT_ROLE: 'verifier' });
    const tracking = readTracking();
    const record = tracking.find(r => r.agent_id === 'agent-env-role');
    assert(record, 'should find record');
    assertEqual(record.role, 'verifier', 'role should come from env');
  });

  test('start deduplicates by agent_id (retry handling)', () => {
    cleanTracking();
    // First start
    runHook('start', {
      agent_id: 'agent-dedup',
      agent_type: 'oh-my-link:worker',
      agent_description: 'Worker',
      agent_prompt: 'Do work',
    });
    // Second start (retry with same ID)
    runHook('start', {
      agent_id: 'agent-dedup',
      agent_type: 'oh-my-link:worker',
      agent_description: 'Worker retry',
      agent_prompt: 'Do work again',
    });
    const tracking = readTracking();
    const records = tracking.filter(r => r.agent_id === 'agent-dedup');
    assertEqual(records.length, 1, 'should have exactly 1 record (deduped)');
  });
});

// ============================================================
// Suite 2: subagent-lifecycle — stop tracking
// ============================================================

suite('subagent-lifecycle — stop tracking', () => {
  test('stop marks agent as stopped', () => {
    cleanTracking();
    // Start first
    runHook('start', {
      agent_id: 'agent-stop-1',
      agent_type: 'oh-my-link:scout',
      agent_description: 'Scout',
      agent_prompt: 'Analyze',
    });
    // Then stop
    runHook('stop', {
      agent_id: 'agent-stop-1',
      exit_code: 0,
    });
    const tracking = readTracking();
    const record = tracking.find(r => r.agent_id === 'agent-stop-1');
    assert(record, 'should find record');
    assertEqual(record.status, 'stopped', 'status should be stopped');
    assert(record.stopped_at, 'stopped_at should be set');
  });

  test('stop releases all file locks held by agent', () => {
    cleanTracking();
    // Acquire some locks
    taskEngine.acquireLock(TEMP_PROJECT, 'src/locked-by-agent.ts', 'agent-lock-release', 60);
    taskEngine.acquireLock(TEMP_PROJECT, 'src/locked-by-agent2.ts', 'agent-lock-release', 60);

    // Start the agent
    runHook('start', {
      agent_id: 'agent-lock-release',
      agent_type: 'oh-my-link:worker',
      agent_description: 'Worker',
      agent_prompt: 'Work',
    });
    // Stop — should release locks
    runHook('stop', {
      agent_id: 'agent-lock-release',
      exit_code: 0,
    });

    const lock1 = taskEngine.checkLock(TEMP_PROJECT, 'src/locked-by-agent.ts');
    const lock2 = taskEngine.checkLock(TEMP_PROJECT, 'src/locked-by-agent2.ts');
    assertEqual(lock1, null, 'lock 1 should be released on stop');
    assertEqual(lock2, null, 'lock 2 should be released on stop');
  });
});

// ============================================================
// Suite 3: subagent-lifecycle — worker auto-claim
// ============================================================

suite('subagent-lifecycle — worker auto-claim', () => {
  test('worker auto-claims assigned task on start', () => {
    cleanTracking();
    // Create a task assigned to this agent
    taskEngine.createTask(TEMP_PROJECT, {
      link_id: 'bd-auto-claim',
      title: 'Auto-claim task',
      description: 'Test auto-claim',
      acceptance_criteria: ['Works'],
      file_scope: ['src/app.ts'],
      locked_decisions: [],
      depends_on: [],
      status: 'pending',
      assigned_to: 'agent-auto-worker',
    });

    runHook('start', {
      agent_id: 'agent-auto-worker',
      agent_type: 'oh-my-link:worker',
      agent_description: 'Worker for auto-claim',
      agent_prompt: 'Implement auto-claim task',
    });

    const task = taskEngine.readTask(TEMP_PROJECT, 'bd-auto-claim');
    assert(task, 'task should exist');
    assertEqual(task.status, 'in_progress', 'task should be in_progress after auto-claim');

    const tracking = readTracking();
    const record = tracking.find(r => r.agent_id === 'agent-auto-worker');
    assert(record, 'should find tracking record');
    assertEqual(record.link_id, 'bd-auto-claim', 'tracking should reference the task');
  });

  test('worker leaves task in_progress on stop (exit_code=0) — awaiting review gate', () => {
    cleanTracking();
    taskEngine.createTask(TEMP_PROJECT, {
      link_id: 'bd-auto-complete',
      title: 'Auto-complete task',
      description: 'Test auto-complete',
      acceptance_criteria: ['Works'],
      file_scope: ['src/app.ts'],
      locked_decisions: [],
      depends_on: [],
      status: 'pending',
      assigned_to: 'agent-complete-worker',
    });

    runHook('start', {
      agent_id: 'agent-complete-worker',
      agent_type: 'oh-my-link:worker',
      agent_description: 'Worker',
      agent_prompt: 'Work',
    });
    runHook('stop', {
      agent_id: 'agent-complete-worker',
      exit_code: 0,
    });

    const task = taskEngine.readTask(TEMP_PROJECT, 'bd-auto-complete');
    assertEqual(task.status, 'in_progress', 'task should remain in_progress — review gate required');
  });

  test('worker marks task as failed on stop (exit_code!=0)', () => {
    cleanTracking();
    taskEngine.createTask(TEMP_PROJECT, {
      link_id: 'bd-auto-fail',
      title: 'Auto-fail task',
      description: 'Test auto-fail',
      acceptance_criteria: ['Works'],
      file_scope: ['src/app.ts'],
      locked_decisions: [],
      depends_on: [],
      status: 'pending',
      assigned_to: 'agent-fail-worker',
    });

    runHook('start', {
      agent_id: 'agent-fail-worker',
      agent_type: 'oh-my-link:worker',
      agent_description: 'Worker',
      agent_prompt: 'Work',
    });
    runHook('stop', {
      agent_id: 'agent-fail-worker',
      exit_code: 1,
    });

    const task = taskEngine.readTask(TEMP_PROJECT, 'bd-auto-fail');
    assertEqual(task.status, 'failed', 'task should be failed after worker stop with exit_code=1');
  });
});

// ============================================================
// Suite 4: subagent-lifecycle — deliverable verification
// ============================================================

suite('subagent-lifecycle — deliverable verification', () => {
  test('scout stop without CONTEXT.md records delivery_issue (required)', () => {
    cleanTracking();
    cleanSession();
    writeSession({});

    runHook('start', {
      agent_id: 'agent-scout-no-ctx',
      agent_type: 'oh-my-link:scout',
      agent_description: 'Scout',
      agent_prompt: 'Analyze',
    });
    runHook('stop', {
      agent_id: 'agent-scout-no-ctx',
      exit_code: 0,
    });

    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    assert(session, 'session should exist');
    const issues = session.delivery_issues || [];
    const scoutIssue = issues.find(i => i.role === 'scout');
    assert(scoutIssue, 'should record delivery issue for scout');
    assert(scoutIssue.missing.includes('CONTEXT.md'), 'should mention CONTEXT.md');
    assertEqual(scoutIssue.required, true, 'should be marked as required');
  });

  test('scout stop with CONTEXT.md does NOT record delivery_issue', () => {
    cleanTracking();
    cleanSession();
    writeSession({});

    // Create the expected artifact
    const artifactsDir = path.join(TEMP_PROJECT, '.oh-my-link');
    fs.writeFileSync(path.join(artifactsDir, 'CONTEXT.md'), '# Context\nTest context');

    runHook('start', {
      agent_id: 'agent-scout-with-ctx',
      agent_type: 'oh-my-link:scout',
      agent_description: 'Scout',
      agent_prompt: 'Analyze',
    });
    runHook('stop', {
      agent_id: 'agent-scout-with-ctx',
      exit_code: 0,
    });

    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    const issues = session.delivery_issues || [];
    const scoutIssue = issues.find(i => i.role === 'scout' && i.agent_id === 'agent-scout-with-ctx');
    assertEqual(scoutIssue, undefined, 'should NOT record delivery issue when artifact exists');

    // Cleanup
    try { fs.unlinkSync(path.join(artifactsDir, 'CONTEXT.md')); } catch {}
  });

  test('architect stop without plan.md records delivery_issue (required)', () => {
    cleanTracking();
    cleanSession();
    writeSession({});

    runHook('start', {
      agent_id: 'agent-architect-no-plan',
      agent_type: 'oh-my-link:architect',
      agent_description: 'Architect',
      agent_prompt: 'Design plan',
    });
    runHook('stop', {
      agent_id: 'agent-architect-no-plan',
      exit_code: 0,
    });

    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    const issues = session.delivery_issues || [];
    const archIssue = issues.find(i => i.role === 'architect');
    assert(archIssue, 'should record delivery issue for architect');
    assert(archIssue.missing.includes('plan.md'), 'should mention plan.md');
    assertEqual(archIssue.required, true, 'should be marked as required');
  });

  test('architect stop with plan.md does NOT record delivery_issue', () => {
    cleanTracking();
    cleanSession();
    writeSession({});

    // Create plan.md in artifacts dir
    const artifactsDir = path.join(TEMP_PROJECT, '.oh-my-link');
    fs.writeFileSync(path.join(artifactsDir, 'plan.md'), '# Plan\nTest plan');

    runHook('start', {
      agent_id: 'agent-architect-with-plan',
      agent_type: 'oh-my-link:architect',
      agent_description: 'Architect',
      agent_prompt: 'Design plan',
    });
    runHook('stop', {
      agent_id: 'agent-architect-with-plan',
      exit_code: 0,
    });

    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    const issues = session.delivery_issues || [];
    const archIssue = issues.find(i => i.role === 'architect' && i.agent_id === 'agent-architect-with-plan');
    assertEqual(archIssue, undefined, 'should NOT record delivery issue when plan.md exists');

    try { fs.unlinkSync(path.join(artifactsDir, 'plan.md')); } catch {}
  });

  test('reviewer stop without review.md records delivery_issue (non-required)', () => {
    cleanTracking();
    cleanSession();
    writeSession({});

    runHook('start', {
      agent_id: 'agent-reviewer-no-review',
      agent_type: 'oh-my-link:reviewer',
      agent_description: 'Reviewer',
      agent_prompt: 'Review code',
    });
    runHook('stop', {
      agent_id: 'agent-reviewer-no-review',
      exit_code: 0,
    });

    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    const issues = session.delivery_issues || [];
    const revIssue = issues.find(i => i.role === 'reviewer');
    assert(revIssue, 'should record delivery issue for reviewer');
    assert(revIssue.missing.includes('review.md'), 'should mention review.md');
    assertEqual(revIssue.required, false, 'should be marked as non-required');
  });

  test('worker stop does NOT check for artifacts (no artifact expectation)', () => {
    cleanTracking();
    cleanSession();
    writeSession({});

    // Worker has no expected artifacts in ROLE_EXPECTATIONS
    runHook('start', {
      agent_id: 'agent-worker-no-artifacts',
      agent_type: 'oh-my-link:worker',
      agent_description: 'Worker',
      agent_prompt: 'Implement feature',
    });
    runHook('stop', {
      agent_id: 'agent-worker-no-artifacts',
      exit_code: 0,
    });

    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    const issues = session.delivery_issues || [];
    const workerIssue = issues.find(i => i.role === 'worker' && i.agent_id === 'agent-worker-no-artifacts');
    assertEqual(workerIssue, undefined, 'worker should NOT have delivery issues (no artifacts expected)');
  });
});

// ============================================================
// Suite 5: ROLE_EXPECTATIONS coverage
// ============================================================

suite('subagent-lifecycle — ROLE_EXPECTATIONS coverage', () => {
  test('code-reviewer expects code-review.md', () => {
    cleanTracking();
    cleanSession();
    writeSession({});

    runHook('start', {
      agent_id: 'agent-cr',
      agent_type: 'oh-my-link:code-reviewer',
      agent_description: 'Code Reviewer',
      agent_prompt: 'Review',
    });
    runHook('stop', { agent_id: 'agent-cr', exit_code: 0 });

    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    const issues = session.delivery_issues || [];
    const crIssue = issues.find(i => i.role === 'code-reviewer');
    assert(crIssue, 'should record delivery issue for code-reviewer');
    assert(crIssue.missing.includes('code-review.md'), 'should mention code-review.md');
    assertEqual(crIssue.required, false, 'code-reviewer artifacts are optional');
  });

  test('security-reviewer expects security-review.md', () => {
    cleanTracking();
    cleanSession();
    writeSession({});

    runHook('start', {
      agent_id: 'agent-sr',
      agent_type: 'oh-my-link:security-reviewer',
      agent_description: 'Security Reviewer',
      agent_prompt: 'Audit',
    });
    runHook('stop', { agent_id: 'agent-sr', exit_code: 0 });

    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    const issues = session.delivery_issues || [];
    const srIssue = issues.find(i => i.role === 'security-reviewer');
    assert(srIssue, 'should record delivery issue for security-reviewer');
    assert(srIssue.missing.includes('security-review.md'), 'should mention security-review.md');
    assertEqual(srIssue.required, false, 'security-reviewer artifacts are optional');
  });

  test('test-engineer has no expected artifacts (empty list)', () => {
    cleanTracking();
    cleanSession();
    writeSession({});

    runHook('start', {
      agent_id: 'agent-te',
      agent_type: 'oh-my-link:test-engineer',
      agent_description: 'Test Engineer',
      agent_prompt: 'Write tests',
    });
    runHook('stop', { agent_id: 'agent-te', exit_code: 0 });

    const session = helpers.readJson(state.getSessionPath(TEMP_PROJECT));
    const issues = session.delivery_issues || [];
    const teIssue = issues.find(i => i.role === 'test-engineer' && i.agent_id === 'agent-te');
    assertEqual(teIssue, undefined, 'test-engineer should NOT have delivery issues (empty artifacts list)');
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
