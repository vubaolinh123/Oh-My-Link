/**
 * Oh-My-Link — Memory Extractor Tests
 * Tests for dist/memory/memory-extractor.js
 * Run: node test/test-memory-extractor.mjs
 */

import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

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
// Load module
// ============================================================

const { extractMemories } = require(path.join(DIST, 'memory', 'memory-extractor.js'));

console.log('Oh-My-Link — Memory Extractor Tests');

// ============================================================
// Suite 1: Decision extraction
// ============================================================

suite('Decision extraction', () => {
  test('detects decision text', () => {
    const text = 'We decided to use GraphQL instead of REST because it handles nested queries better.';
    const results = extractMemories(text);
    assert(results.length > 0, 'should extract at least one memory');
    assert(results.some(r => r.memory_type === 'decision'), 'should classify as decision');
  });

  test('decision memory has required fields', () => {
    const text = 'We decided to use GraphQL instead of REST because it handles nested queries better.';
    const results = extractMemories(text);
    const decision = results.find(r => r.memory_type === 'decision');
    assert(decision !== undefined, 'decision memory should exist');
    assert(typeof decision.content === 'string', 'content should be string');
    assert(typeof decision.confidence === 'number', 'confidence should be number');
    assert(decision.confidence >= 0 && decision.confidence <= 1, 'confidence should be in [0,1]');
    assert(typeof decision.chunk_index === 'number', 'chunk_index should be number');
  });
});

// ============================================================
// Suite 2: Preference extraction
// ============================================================

suite('Preference extraction', () => {
  test('detects preference text', () => {
    const text = 'I prefer to always use functional style. Never use class components if you can help it.';
    const results = extractMemories(text);
    assert(results.some(r => r.memory_type === 'preference'), 'should classify as preference');
  });

  test('preference confidence is non-zero', () => {
    const text = 'I prefer to always use functional style. Never use class components if you can help it.';
    const results = extractMemories(text);
    const pref = results.find(r => r.memory_type === 'preference');
    assert(pref !== undefined, 'preference memory should exist');
    assert(pref.confidence > 0, 'confidence should be positive');
  });
});

// ============================================================
// Suite 3: Milestone extraction
// ============================================================

suite('Milestone extraction', () => {
  test('detects milestone text', () => {
    const text = 'After weeks of debugging, we finally got it working! The deployment pipeline shipped successfully with v2.0.';
    const results = extractMemories(text);
    assert(results.some(r => r.memory_type === 'milestone'), 'should classify as milestone');
  });

  test('milestone with version number', () => {
    const text = 'We released v3.1.0 today. All tests passed and the team is excited about the new features.';
    const results = extractMemories(text);
    assert(results.length > 0, 'should extract at least one memory');
    // Version number should trigger milestone markers
    const types = results.map(r => r.memory_type);
    assert(
      types.includes('milestone') || types.includes('emotional'),
      `should classify as milestone or emotional, got: ${types.join(', ')}`
    );
  });
});

// ============================================================
// Suite 4: Problem extraction
// ============================================================

suite('Problem extraction', () => {
  test('detects problem text', () => {
    const text = 'There is a critical bug in the authentication module. The error keeps crashing the server on startup.';
    const results = extractMemories(text);
    assert(results.some(r => r.memory_type === 'problem'), 'should classify as problem');
  });

  test('problem memory includes content', () => {
    const text = 'There is a critical bug in the authentication module. The error keeps crashing the server on startup.';
    const results = extractMemories(text);
    const problem = results.find(r => r.memory_type === 'problem');
    assert(problem !== undefined, 'problem memory should exist');
    assert(problem.content.length > 0, 'problem content should be non-empty');
  });
});

// ============================================================
// Suite 5: Disambiguation — resolved problem becomes milestone
// ============================================================

suite('Disambiguation', () => {
  test('resolved problem becomes milestone', () => {
    const text = 'The database was broken and causing crashes. We fixed it by upgrading the driver. It works now and we are thrilled.';
    const results = extractMemories(text);
    // Should disambiguate: problem + resolution + positive sentiment = milestone
    assert(
      results.some(r => r.memory_type === 'milestone' || r.memory_type === 'emotional'),
      'resolved positive problem should become milestone or emotional'
    );
  });

  test('pure unresolved problem stays as problem', () => {
    const text = 'There is a serious bug causing crashes. The error keeps happening and we cannot figure out why it is broken.';
    const results = extractMemories(text);
    assert(results.some(r => r.memory_type === 'problem'), 'unresolved problem should stay as problem');
  });
});

// ============================================================
// Suite 6: Code filtering
// ============================================================

suite('Code filtering', () => {
  test('filters code lines from prose', () => {
    const text = `We decided to refactor the API layer.
\`\`\`
const server = new Fastify();
server.listen(3000);
\`\`\`
The reason is that Express was too slow.`;
    const results = extractMemories(text);
    // Should still extract the decision despite code block
    assert(results.length > 0, 'should extract from prose around code');
  });

  test('extracts decision type despite embedded code', () => {
    const text = `We decided to refactor the API layer.
\`\`\`
const server = new Fastify();
server.listen(3000);
\`\`\`
The reason is that Express was too slow.`;
    const results = extractMemories(text);
    assert(results.some(r => r.memory_type === 'decision'), 'should classify prose as decision');
  });
});

// ============================================================
// Suite 7: Short text rejection
// ============================================================

suite('Short text rejection', () => {
  test('rejects text shorter than 20 chars', () => {
    const results = extractMemories('hello world');
    assertEqual(results.length, 0, 'too short');
  });

  test('rejects empty string', () => {
    const results = extractMemories('');
    assertEqual(results.length, 0, 'empty string');
  });

  test('rejects text of exactly 19 chars', () => {
    // "hello world 1234567" = 19 chars
    const text = 'hello world 1234567';
    assertEqual(text.length, 19, 'test string length check');
    const results = extractMemories(text);
    assertEqual(results.length, 0, 'text under 20 chars should be rejected');
  });

  test('accepts text of 20 chars or more if it matches a pattern', () => {
    // "We decided to do it." = 20 chars exactly and matches decision marker
    const text = 'We decided to do it.';
    assertEqual(text.length, 20, 'test string length check');
    // May or may not produce a result depending on confidence threshold but should not throw
    const results = extractMemories(text);
    assert(Array.isArray(results), 'should return array for 20-char text');
  });
});

// ============================================================
// Suite 8: Confidence threshold
// ============================================================

suite('Confidence threshold', () => {
  test('respects custom confidence threshold', () => {
    const text = 'We sort of decided maybe to use something.';
    const lowThreshold = extractMemories(text, 0.1);
    const highThreshold = extractMemories(text, 0.9);
    assert(
      lowThreshold.length >= highThreshold.length,
      `lower threshold should produce >= results: low=${lowThreshold.length}, high=${highThreshold.length}`
    );
  });

  test('default threshold of 0.3 is used when none provided', () => {
    const text = 'We decided to use GraphQL instead of REST because it handles nested queries better.';
    const defaultResults = extractMemories(text);
    const explicitResults = extractMemories(text, 0.3);
    assertEqual(defaultResults.length, explicitResults.length, 'default and explicit 0.3 should match');
  });

  test('very high threshold rejects low-confidence extractions', () => {
    const text = 'We sort of decided maybe to use something.';
    const results = extractMemories(text, 0.99);
    // With a very high threshold, this weak text should produce nothing
    assert(Array.isArray(results), 'should return array');
    assertEqual(results.length, 0, 'very high threshold should reject weak text');
  });
});

// ============================================================
// Suite 9: Speaker-turn splitting
// ============================================================

suite('Speaker-turn splitting', () => {
  test('splits on speaker turns when markers present', () => {
    // Use richer turn content so individual segments clear the confidence threshold
    const text = `Human: What should we use for the database?
Assistant: We decided to go with PostgreSQL instead of MySQL because it handles nested queries and JSON better. The architecture decision was driven by the need for complex joins and our team's existing expertise.
Human: What about the ORM?
Assistant: We should use Prisma rather than TypeORM because it has great TypeScript support, better documentation, and the team prefers its API design. We settled on Prisma after evaluating all the options.`;
    const results = extractMemories(text);
    // Should split into separate turns and classify each
    assert(results.length >= 1, 'should extract from conversation turns');
  });

  test('extracts decision from assistant recommendation', () => {
    const text = `Human: What should we use for the database?
Assistant: We decided to go with PostgreSQL instead of MySQL because it handles nested queries and JSON better. The architecture decision was driven by the need for complex joins and our team's existing expertise.
Human: What about the ORM?
Assistant: We should use Prisma rather than TypeORM because it has great TypeScript support, better documentation, and the team prefers its API design. We settled on Prisma after evaluating all the options.`;
    const results = extractMemories(text);
    // PostgreSQL recommendation and Prisma recommendation should yield decisions
    assert(
      results.some(r => r.memory_type === 'decision'),
      'recommendation turns should be classified as decisions'
    );
  });

  test('handles User: prefix as well as Human:', () => {
    const text = `User: Can you help me?
Assistant: Sure, I recommend using TypeScript instead of JavaScript because it handles types well.
User: Why is that better?
Assistant: TypeScript catches errors at compile time rather than at runtime.`;
    const results = extractMemories(text);
    assert(results.length >= 1, 'should extract from User:/Assistant: turns');
  });
});

// ============================================================
// Summary
// ============================================================

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
