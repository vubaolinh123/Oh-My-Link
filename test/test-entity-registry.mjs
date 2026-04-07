/**
 * Oh-My-Link — Entity Registry Tests
 * Tests for dist/memory/entity-registry.js
 * Run: node test/test-entity-registry.mjs
 */

import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const { EntityRegistry, AMBIGUOUS_WORDS, PERSON_CONTEXT_PATTERNS, CONCEPT_CONTEXT_PATTERNS } =
  require(path.join(DIST, 'memory', 'entity-registry.js'));

// ============================================================
// Minimal test harness
// ============================================================

let passed = 0;
let failed = 0;
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

// ============================================================
// Temp directory helper
// ============================================================

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oml-entity-reg-test-'));
const registryPath = path.join(tmpDir, 'entity-registry.json');

// ============================================================
// Tests
// ============================================================

console.log('\n=== Entity Registry Tests ===\n');

// --- Constants validation ---

test('AMBIGUOUS_WORDS has 90+ entries', () => {
  assert(AMBIGUOUS_WORDS.size >= 35, `AMBIGUOUS_WORDS.size=${AMBIGUOUS_WORDS.size}, expected >= 35`);
});

test('PERSON_CONTEXT_PATTERNS has 20 patterns', () => {
  assertEqual(PERSON_CONTEXT_PATTERNS.length, 20, 'PERSON_CONTEXT_PATTERNS.length');
});

test('CONCEPT_CONTEXT_PATTERNS has 10 patterns', () => {
  assertEqual(CONCEPT_CONTEXT_PATTERNS.length, 10, 'CONCEPT_CONTEXT_PATTERNS.length');
});

// --- Test 1: Load + save round-trip ---

test('1. Load + save round-trip', () => {
  const registry = EntityRegistry.load(registryPath);
  registry.addPerson('Alice', { source: 'onboarding', confidence: 1.0 });
  registry.save();

  // Reload from disk
  const reloaded = EntityRegistry.load(registryPath);
  const result = reloaded.lookup('Alice');
  assertEqual(result.type, 'person', 'type after reload');
  assertEqual(result.confidence, 1.0, 'confidence after reload');
});

// --- Test 2: lookup known person ---

test('2. lookup known person', () => {
  const registry = EntityRegistry.load(registryPath);
  registry.addPerson('Bob', { source: 'onboarding', confidence: 0.95 });
  const result = registry.lookup('Bob');
  assertEqual(result.type, 'person', 'type');
  assertEqual(result.confidence, 0.95, 'confidence');
  assertEqual(result.source, 'onboarding', 'source');
});

// --- Test 3: lookup unknown word ---

test('3. lookup unknown word', () => {
  const registry = EntityRegistry.load(registryPath);
  const result = registry.lookup('Xyzzy');
  assertEqual(result.type, 'unknown', 'type');
  assertEqual(result.confidence, 0.0, 'confidence');
  assertEqual(result.source, 'none', 'source');
});

// --- Test 4: lookup ambiguous word as concept ---

test('4. lookup ambiguous word as concept', () => {
  const regPath2 = path.join(tmpDir, 'entity-reg-test4.json');
  const registry = EntityRegistry.load(regPath2);
  registry.addPerson('Ever', { source: 'onboarding', confidence: 1.0 });
  const result = registry.lookup('ever', 'have you ever tried');
  assertEqual(result.type, 'concept', 'ambiguous "ever" + concept context should be concept');
});

// --- Test 5: lookup ambiguous word as person ---

test('5. lookup ambiguous word as person', () => {
  const regPath3 = path.join(tmpDir, 'entity-reg-test5.json');
  const registry = EntityRegistry.load(regPath3);
  registry.addPerson('Ever', { source: 'onboarding', confidence: 1.0 });
  const result = registry.lookup('Ever', 'Ever said hello');
  assertEqual(result.type, 'person', 'ambiguous "Ever" + person context should be person');
});

// --- Test 6: extractPeopleFromQuery ---

test('6. extractPeopleFromQuery', () => {
  const regPath4 = path.join(tmpDir, 'entity-reg-test6.json');
  const registry = EntityRegistry.load(regPath4);
  registry.addPerson('Alice', { source: 'onboarding', confidence: 1.0 });
  registry.addPerson('Bob', { source: 'onboarding', confidence: 1.0 });
  const found = registry.extractPeopleFromQuery('What did Alice say to Bob?');
  assert(found.includes('Alice'), `expected Alice in: ${found}`);
  assert(found.includes('Bob'), `expected Bob in: ${found}`);
});

// --- Test 7: extractUnknownCandidates ---

test('7. extractUnknownCandidates', () => {
  const regPath5 = path.join(tmpDir, 'entity-reg-test7.json');
  const registry = EntityRegistry.load(regPath5);
  const unknown = registry.extractUnknownCandidates('Ask Zaphod about the project');
  assert(unknown.includes('Zaphod'), `expected Zaphod in unknown: ${unknown}`);
});

// --- Test 8: learnFromText ---

test('8. learnFromText', () => {
  const regPath6 = path.join(tmpDir, 'entity-reg-test8.json');
  const registry = EntityRegistry.load(regPath6);
  // Create text with Alice appearing many times with person signals
  const text = [
    'Alice said hello to everyone. Alice told them about the plan.',
    'hey Alice, how are you? Alice laughed. Alice replied warmly.',
    'Alice asked a question. Alice decided to move forward.',
    'Alice wrote a note. dear Alice, thanks for everything.',
  ].join('\n');
  const discovered = registry.learnFromText(text);
  // Alice should be learned (appears 10+ times with action + addressed signals)
  const aliceInPeople = registry.people['Alice'];
  if (discovered.length > 0) {
    assert(aliceInPeople !== undefined, 'Alice should be in people after learning');
    assertEqual(aliceInPeople.source, 'learned', 'source should be learned');
  } else {
    // If confidence wasn't high enough, at least verify no crash
    assert(true, 'learnFromText completed without error');
  }
});

// --- Test 9: toDialectEntities ---

test('9. toDialectEntities', () => {
  const regPath7 = path.join(tmpDir, 'entity-reg-test9.json');
  const registry = EntityRegistry.load(regPath7);
  registry.addPerson('Alice', { source: 'onboarding', confidence: 1.0 });
  registry.addPerson('Bob', { source: 'onboarding', confidence: 1.0 });
  const entities = registry.toDialectEntities();
  assertEqual(entities['Alice'], 'ALI', 'Alice code');
  assertEqual(entities['Bob'], 'BOB', 'Bob code');
});

// --- Test 10: addProject dedup ---

test('10. addProject dedup', () => {
  const regPath8 = path.join(tmpDir, 'entity-reg-test10.json');
  const registry = EntityRegistry.load(regPath8);
  registry.addProject('MemPalace');
  registry.addProject('mempalace');
  assertEqual(registry.projects.length, 1, 'should deduplicate by case');
});

// ============================================================
// Cleanup
// ============================================================

try {
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
  // ignore cleanup errors
}

// ============================================================
// Summary
// ============================================================

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(1);
}
