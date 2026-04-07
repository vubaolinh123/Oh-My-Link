/**
 * Oh-My-Link — Skill Injector Hook Tests
 * Tests for dist/hooks/skill-injector.js
 * Run: node test/test-skill-injector.mjs
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

const TEMP_ROOT = path.join(os.tmpdir(), `oml-skill-inj-${Date.now()}`);
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

// Ensure state dirs exist
state.ensureDir(state.getProjectStateRoot(TEMP_PROJECT));

console.log('Oh-My-Link — Skill Injector Tests');
console.log(`TEMP_ROOT: ${TEMP_ROOT}`);

// ============================================================
// Helpers
// ============================================================

const PROJECT_SKILLS_DIR = path.join(TEMP_PROJECT, '.oh-my-link', 'skills');
const GLOBAL_SKILLS_DIR = path.join(process.env.OML_HOME, 'skills');

function createSkill(dir, name, triggers, body = 'Content') {
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: Test skill\ntriggers: [${triggers.join(', ')}]\n---\n${body}`;
  fs.writeFileSync(path.join(dir, `${name}.md`), content);
}

function runInjector(prompt, envOverrides = {}) {
  const inputFile = path.join(TEMP_ROOT, `si-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(inputFile, JSON.stringify({ prompt, cwd: TEMP_PROJECT }));
  const cmd = `node "${path.join(DIST, 'hooks', 'skill-injector.js')}" < "${inputFile}"`;
  return JSON.parse(execSync(cmd, {
    timeout: 10000, encoding: 'utf-8', shell: true,
    env: { ...process.env, OML_HOME: process.env.OML_HOME, ...envOverrides }
  }).trim());
}

function cleanSkills() {
  try { fs.rmSync(PROJECT_SKILLS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(GLOBAL_SKILLS_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
}

function cleanInjectedTracking() {
  const stateDir = state.getProjectStateRoot(TEMP_PROJECT);
  const trackPath = path.join(stateDir, 'injected-skills.json');
  try { fs.unlinkSync(trackPath); } catch { /* ignore */ }
}

// ============================================================
// Suite 1: Discovery
// ============================================================

suite('Discovery', () => {
  test('discovers project skills from .oh-my-link/skills/', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'my-proj-skill', ['deploy', 'build'], 'Project skill body');
    const result = runInjector('deploy the app');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('my-proj-skill'), `Expected project skill in output, got: ${ctx.slice(0, 200)}`);
  });

  test('discovers global skills from OML_HOME/skills/', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(GLOBAL_SKILLS_DIR, 'my-global-skill', ['testing', 'test'], 'Global skill body');
    const result = runInjector('run the test suite');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('my-global-skill'), `Expected global skill in output, got: ${ctx.slice(0, 200)}`);
  });

  test('returns passthrough when no skills exist', () => {
    cleanSkills();
    cleanInjectedTracking();
    const result = runInjector('do something random');
    // Should be a passthrough — no additionalContext or empty
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('oml-learned-skills'), `Expected no skill injection, got: ${ctx.slice(0, 200)}`);
  });

  test('skips invalid skill files without crashing', () => {
    cleanSkills();
    cleanInjectedTracking();
    // Create a valid skill
    createSkill(PROJECT_SKILLS_DIR, 'valid-skill', ['deploy'], 'Valid body');
    // Create an invalid skill file (no frontmatter)
    fs.writeFileSync(path.join(PROJECT_SKILLS_DIR, 'broken.md'), 'No frontmatter here at all');
    const result = runInjector('deploy now');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('valid-skill'), `Expected valid skill to still be found, got: ${ctx.slice(0, 200)}`);
  });
});

// ============================================================
// Suite 2: Trigger Matching
// ============================================================

suite('Trigger Matching', () => {
  test('matches trigger keyword in prompt (case-insensitive)', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'auth-skill', ['authentication'], 'Auth body');
    const result = runInjector('Set up AUTHENTICATION for the app');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('auth-skill'), `Expected case-insensitive match, got: ${ctx.slice(0, 200)}`);
  });

  test('multi-word triggers score higher than single-word', () => {
    cleanSkills();
    cleanInjectedTracking();
    // Single-word trigger skill
    createSkill(PROJECT_SKILLS_DIR, 'single-word', ['deploy'], 'Single word body');
    // Multi-word trigger skill
    createSkill(PROJECT_SKILLS_DIR, 'multi-word', ['deploy pipeline'], 'Multi word body');
    const result = runInjector('set up the deploy pipeline');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    // multi-word should appear before single-word in the injection
    const multiPos = ctx.indexOf('multi-word');
    const singlePos = ctx.indexOf('single-word');
    assert(multiPos >= 0, `Expected multi-word skill in output, got: ${ctx.slice(0, 300)}`);
    assert(singlePos >= 0, `Expected single-word skill in output, got: ${ctx.slice(0, 300)}`);
    assert(multiPos < singlePos, `Expected multi-word skill (pos ${multiPos}) before single-word skill (pos ${singlePos})`);
  });

  test('no trigger match returns passthrough', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'db-skill', ['database', 'sql'], 'DB body');
    const result = runInjector('refactor the CSS styles');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('db-skill'), `Expected no match for unrelated prompt, got: ${ctx.slice(0, 200)}`);
  });

  test("word-boundary matching: 'auth' matches 'auth module' but not 'authorize'", () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'auth-boundary', ['auth'], 'Auth boundary body');

    // Should match: 'auth' as whole word in 'auth module'
    const result1 = runInjector('build the auth module');
    const ctx1 = result1.hookSpecificOutput?.additionalContext || '';
    assert(ctx1.includes('auth-boundary'), `Expected 'auth' to match 'auth module', got: ${ctx1.slice(0, 200)}`);

    // Should NOT match: 'auth' is not a word boundary in 'authorize'
    cleanInjectedTracking();
    const result2 = runInjector('authorize the user request');
    const ctx2 = result2.hookSpecificOutput?.additionalContext || '';
    assert(!ctx2.includes('auth-boundary'), `Expected 'auth' NOT to match 'authorize', got: ${ctx2.slice(0, 200)}`);
  });
});

// ============================================================
// Suite 3: Injection
// ============================================================

suite('Injection', () => {
  test('output wraps skills in <oml-learned-skills> tags', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'tag-skill', ['react'], 'Tag test body');
    const result = runInjector('build a react component');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('<oml-learned-skills>'), `Expected opening tag, got: ${ctx.slice(0, 200)}`);
    assert(ctx.includes('</oml-learned-skills>'), `Expected closing tag, got: ${ctx.slice(-200)}`);
  });

  test('max 3 skills injected (cap)', () => {
    cleanSkills();
    cleanInjectedTracking();
    // Create 5 skills all matching same trigger
    for (let i = 1; i <= 5; i++) {
      createSkill(PROJECT_SKILLS_DIR, `cap-skill-${i}`, ['deploy'], `Cap body ${i}`);
    }
    const result = runInjector('deploy the application now');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    // Count how many ### skill headers appear
    const skillHeaders = (ctx.match(/### cap-skill-/g) || []);
    assert(skillHeaders.length <= 3, `Expected max 3 skills injected, got ${skillHeaders.length}`);
  });

  test('project skills override global skills with same name', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(GLOBAL_SKILLS_DIR, 'shared-skill', ['deploy'], 'Global version body');
    createSkill(PROJECT_SKILLS_DIR, 'shared-skill', ['deploy'], 'Project version body');
    const result = runInjector('deploy now');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('Project version body'), `Expected project version, got: ${ctx.slice(0, 300)}`);
    assert(!ctx.includes('Global version body'), `Expected global version to be overridden, got: ${ctx.slice(0, 300)}`);
  });
});

// ============================================================
// Suite 4: Session Dedup
// ============================================================

suite('Session Dedup', () => {
  test('same skill not re-injected in same session', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'dedup-skill', ['deploy'], 'Dedup body');

    // First injection — should inject
    const result1 = runInjector('deploy the app');
    const ctx1 = result1.hookSpecificOutput?.additionalContext || '';
    assert(ctx1.includes('dedup-skill'), `Expected first injection, got: ${ctx1.slice(0, 200)}`);

    // Second injection — should NOT re-inject (same session)
    const result2 = runInjector('deploy again');
    const ctx2 = result2.hookSpecificOutput?.additionalContext || '';
    assert(!ctx2.includes('dedup-skill'), `Expected dedup to prevent re-injection, got: ${ctx2.slice(0, 200)}`);
  });

  test('dedup resets when session_started_at changes', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'reset-skill', ['deploy'], 'Reset body');

    const stateDir = state.getProjectStateRoot(TEMP_PROJECT);
    state.ensureDir(stateDir);

    // Write session with a specific started_at
    const sessionPath = path.join(stateDir, 'session.json');
    const oldTime = '2025-01-01T00:00:00.000Z';
    helpers.writeJsonAtomic(sessionPath, { active: true, started_at: oldTime });

    // Write injected-skills.json tied to that session
    const trackPath = path.join(stateDir, 'injected-skills.json');
    helpers.writeJsonAtomic(trackPath, {
      skills: ['reset-skill'],
      session_started_at: oldTime,
      updated_at: new Date().toISOString(),
    });

    // Should NOT inject (same session)
    const result1 = runInjector('deploy now');
    const ctx1 = result1.hookSpecificOutput?.additionalContext || '';
    assert(!ctx1.includes('reset-skill'), `Expected dedup in same session, got: ${ctx1.slice(0, 200)}`);

    // Now change session_started_at — simulates new session
    const newTime = new Date().toISOString();
    helpers.writeJsonAtomic(sessionPath, { active: true, started_at: newTime });

    // Should inject again (new session)
    const result2 = runInjector('deploy now');
    const ctx2 = result2.hookSpecificOutput?.additionalContext || '';
    assert(ctx2.includes('reset-skill'), `Expected re-injection after session change, got: ${ctx2.slice(0, 200)}`);
  });
});

// ============================================================
// Suite 5: Feedback Suppression
// ============================================================

suite('Feedback Suppression', () => {
  test('skill with 3+ negatives is suppressed', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'bad-skill', ['deploy'], 'Bad skill body');

    const stateDir = state.getProjectStateRoot(TEMP_PROJECT);
    state.ensureDir(stateDir);

    // Write negative feedback (3 negatives = suppressed)
    const feedbackPath = path.join(stateDir, 'skill-feedback.json');
    helpers.writeJsonAtomic(feedbackPath, {
      'bad-skill': {
        negativeCount: 3,
        lastNegative: new Date().toISOString(),
      },
    });

    const result = runInjector('deploy the app');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('bad-skill'), `Expected suppressed skill to be excluded, got: ${ctx.slice(0, 200)}`);

    // Clean up feedback
    try { fs.unlinkSync(feedbackPath); } catch { /* ignore */ }
  });

  test('old negatives decay after 14 days', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'decay-skill', ['deploy'], 'Decay skill body');

    const stateDir = state.getProjectStateRoot(TEMP_PROJECT);
    state.ensureDir(stateDir);

    // Write negative feedback with old date (>14 days ago), count=3
    // After decay: floor(3/2) = 1, which is < threshold (3), so NOT suppressed
    const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const feedbackPath = path.join(stateDir, 'skill-feedback.json');
    helpers.writeJsonAtomic(feedbackPath, {
      'decay-skill': {
        negativeCount: 3,
        lastNegative: oldDate,
      },
    });

    const result = runInjector('deploy now');
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(ctx.includes('decay-skill'), `Expected old negatives to decay and allow injection, got: ${ctx.slice(0, 200)}`);

    // Clean up
    try { fs.unlinkSync(feedbackPath); } catch { /* ignore */ }
  });
});

// ============================================================
// Suite 6: Quiet Mode
// ============================================================

suite('Quiet Mode', () => {
  test('OML_QUIET=2 suppresses injection output', () => {
    cleanSkills();
    cleanInjectedTracking();
    createSkill(PROJECT_SKILLS_DIR, 'quiet-skill', ['deploy'], 'Quiet body');

    const result = runInjector('deploy the app', { OML_QUIET: '2' });
    const ctx = result.hookSpecificOutput?.additionalContext || '';
    assert(!ctx.includes('quiet-skill'), `Expected OML_QUIET=2 to suppress injection, got: ${ctx.slice(0, 200)}`);
    assert(!ctx.includes('oml-learned-skills'), `Expected no skill tags with OML_QUIET=2, got: ${ctx.slice(0, 200)}`);
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
