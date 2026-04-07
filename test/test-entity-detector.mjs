/**
 * Oh-My-Link — Entity Detector Tests
 * Tests for dist/memory/entity-detector.js
 * Run: node test/test-entity-detector.mjs
 */

import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const {
  extractCandidates,
  scoreEntity,
  classifyEntity,
  detectEntities,
  PERSON_VERB_PATTERNS,
  PRONOUN_PATTERNS,
  DIALOGUE_PATTERNS,
  PROJECT_VERB_PATTERNS,
  ENTITY_STOPWORDS,
} = require(path.join(DIST, 'memory', 'entity-detector.js'));

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
// Tests
// ============================================================

console.log('\n=== Entity Detector Tests ===\n');

// --- Constants validation ---

test('PERSON_VERB_PATTERNS has 20 patterns', () => {
  assertEqual(PERSON_VERB_PATTERNS.length, 20, 'PERSON_VERB_PATTERNS.length');
});

test('PRONOUN_PATTERNS has 9 patterns', () => {
  assertEqual(PRONOUN_PATTERNS.length, 9, 'PRONOUN_PATTERNS.length');
});

test('DIALOGUE_PATTERNS has 4 patterns', () => {
  assertEqual(DIALOGUE_PATTERNS.length, 4, 'DIALOGUE_PATTERNS.length');
});

test('PROJECT_VERB_PATTERNS has 15 patterns', () => {
  assertEqual(PROJECT_VERB_PATTERNS.length, 15, 'PROJECT_VERB_PATTERNS.length');
});

test('ENTITY_STOPWORDS has ~200 entries', () => {
  assert(ENTITY_STOPWORDS.size >= 150, `ENTITY_STOPWORDS.size=${ENTITY_STOPWORDS.size}, expected >= 150`);
});

// --- Test 1: extractCandidates basic ---

test('1. extractCandidates basic — detects Alice and Bob', () => {
  const text = 'Alice went with Bob. Alice told Bob about the project. Bob laughed. Bob replied. Alice smiled.';
  const result = extractCandidates(text);
  assert(result['Alice'] >= 3, `Alice count=${result['Alice']}, expected >= 3`);
  assert(result['Bob'] >= 3, `Bob count=${result['Bob']}, expected >= 3`);
});

// --- Test 2: extractCandidates filters stopwords ---

test('2. extractCandidates filters stopwords', () => {
  const text = 'The system will start. The system will stop. The system will run. The system will check.';
  const result = extractCandidates(text);
  assertEqual(Object.keys(result).length, 0, 'stopwords-only result length');
});

// --- Test 3: extractCandidates frequency threshold ---

test('3. extractCandidates frequency threshold — below 3 occurrences', () => {
  const text = 'Alice is here. Bob is there.';
  const result = extractCandidates(text);
  assertEqual(result['Alice'], undefined, 'Alice should not appear (only 1 occurrence)');
  assertEqual(result['Bob'], undefined, 'Bob should not appear (only 1 occurrence)');
});

// --- Test 4: scoreEntity person signals ---

test('4. scoreEntity person signals', () => {
  const text = 'Alice said hello. Alice told Bob. hey Alice. Alice asked a question.';
  const lines = text.split('\n');
  const scores = scoreEntity('Alice', text, lines);
  assert(scores.person_score > 0, `person_score=${scores.person_score}, expected > 0`);
  assert(scores.person_signals.length > 0, 'expected person signals');
  // Should have at least action signals
  const hasAction = scores.person_signals.some(s => s.includes('action'));
  const hasAddressed = scores.person_signals.some(s => s.includes('addressed'));
  assert(hasAction || hasAddressed, 'expected action or addressed signal');
});

// --- Test 5: scoreEntity project signals ---

test('5. scoreEntity project signals', () => {
  const text = 'building MemPalace. Deploy MemPalace. MemPalace v2. The MemPalace repo.';
  const lines = text.split('\n');
  const scores = scoreEntity('MemPalace', text, lines);
  assert(scores.project_score > scores.person_score,
    `project_score=${scores.project_score} should > person_score=${scores.person_score}`);
  assert(scores.project_signals.length > 0, 'expected project signals');
});

// --- Test 6: classifyEntity person with two signal types ---

test('6. classifyEntity person with two signal types', () => {
  const scores = {
    person_score: 10,
    project_score: 0,
    person_signals: ["'Alice ...' action (3x)", "addressed directly (2x)"],
    project_signals: [],
  };
  const entity = classifyEntity('Alice', 5, scores);
  assertEqual(entity.type, 'person', 'entity type');
  assert(entity.confidence >= 0.85, `confidence=${entity.confidence}, expected >= 0.85`);
});

// --- Test 7: classifyEntity pronoun-only downgrade ---

test('7. classifyEntity pronoun-only downgrade', () => {
  const scores = {
    person_score: 6,
    project_score: 0,
    person_signals: ['pronoun nearby (3x)'],
    project_signals: [],
  };
  const entity = classifyEntity('Click', 5, scores);
  assertEqual(entity.type, 'uncertain', 'entity type — pronoun-only should be uncertain');
});

// --- Test 8: detectEntities end-to-end ---

test('8. detectEntities end-to-end', () => {
  // Provide enough occurrences (>= 3 each) for candidates to register
  // Note: project name must be a proper noun that matches /[A-Z][a-z]{1,19}/ pattern
  const text = [
    'Alice said hello. Alice told Bob about Acme. Bob laughed.',
    'Alice asked Bob a question. Bob replied to Alice. hey Alice.',
    'Building Acme v2. Deploy Acme. The Acme repo. Acme Acme Acme.',
    'Bob smiled at Alice. Alice and Bob discussed the plan.',
  ].join('\n');
  const result = detectEntities([text]);

  // Alice and Bob should be detected (either as people or uncertain, but detected)
  const allDetected = [...result.people, ...result.uncertain].map(e => e.name);
  assert(allDetected.includes('Alice'), `Alice should be detected, got: ${allDetected.join(', ')}`);
  assert(allDetected.includes('Bob'), `Bob should be detected, got: ${allDetected.join(', ')}`);

  // Acme should be a project
  const projectNames = result.projects.map(e => e.name);
  assert(projectNames.includes('Acme'), `Acme should be a project, got: ${projectNames.join(', ')}`);
});

// --- Test 9: classifyEntity with zero scores ---

test('9. classifyEntity zero scores — uncertain', () => {
  const scores = {
    person_score: 0,
    project_score: 0,
    person_signals: [],
    project_signals: [],
  };
  const entity = classifyEntity('Mystery', 10, scores);
  assertEqual(entity.type, 'uncertain', 'zero scores should be uncertain');
  assert(entity.confidence <= 0.4, `confidence=${entity.confidence}, expected <= 0.4`);
});

// --- Test 10: classifyEntity project classification ---

test('10. classifyEntity project classification', () => {
  const scores = {
    person_score: 0,
    project_score: 12,
    person_signals: [],
    project_signals: ['project verb (3x)', 'versioned/hyphenated (2x)'],
  };
  const entity = classifyEntity('Acme', 5, scores);
  assertEqual(entity.type, 'project', 'should be project');
  assert(entity.confidence >= 0.9, `confidence=${entity.confidence}, expected >= 0.9`);
});

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
