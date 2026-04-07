/**
 * Oh-My-Link — AAAK Dialect Tests
 * Tests for dist/memory/aaak-dialect.js
 * Run: node test/test-aaak.mjs
 */

import { createRequire } from 'module';
import * as path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const { Dialect, EMOTION_CODES, STOP_WORDS } = require(path.join(DIST, 'memory', 'aaak-dialect.js'));

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

console.log('Oh-My-Link — AAAK Dialect Tests');

// ============================================================
// Suite 1: Constructor
// ============================================================

suite('Constructor', () => {
  test('default constructor creates empty entity codes', () => {
    const d = new Dialect();
    assertEqual(Object.keys(d.entityCodes).length, 0, 'empty entities');
  });

  test('constructor with entities stores both original and lowercase', () => {
    const d = new Dialect({ 'Alice': 'ALC' });
    assertEqual(d.entityCodes['Alice'], 'ALC', 'original');
    assertEqual(d.entityCodes['alice'], 'ALC', 'lowercase');
  });
});

// ============================================================
// Suite 2: detectEmotions
// ============================================================

suite('detectEmotions', () => {
  test('detects "decided" as determ emotion', () => {
    const d = new Dialect();
    const emotions = d.detectEmotions('We decided to use TypeScript');
    assert(emotions.includes('determ'), 'should detect determination');
  });

  test('returns max 3 emotions', () => {
    const d = new Dialect();
    const emotions = d.detectEmotions('decided love hope fear trust worried excited');
    assert(emotions.length <= 3, 'max 3');
  });

  test('empty text returns empty array', () => {
    const d = new Dialect();
    assertEqual(d.detectEmotions('').length, 0, 'empty');
  });
});

// ============================================================
// Suite 3: detectFlags
// ============================================================

suite('detectFlags', () => {
  test('detects DECISION flag from "decided"', () => {
    const d = new Dialect();
    const flags = d.detectFlags('We decided to switch frameworks');
    assert(flags.includes('DECISION'), 'should detect DECISION');
  });

  test('detects TECHNICAL flag from "api"', () => {
    const d = new Dialect();
    const flags = d.detectFlags('The API needs a database migration');
    assert(flags.includes('TECHNICAL'), 'should detect TECHNICAL');
  });
});

// ============================================================
// Suite 4: extractTopics
// ============================================================

suite('extractTopics', () => {
  test('extracts topics from technical text', () => {
    const d = new Dialect();
    const topics = d.extractTopics('We migrated the GraphQL server to use TypeScript strict mode');
    assert(topics.length > 0, 'should extract topics');
    assert(topics.includes('graphql') || topics.includes('typescript') || topics.includes('server'),
      'should include technical terms');
  });

  test('boosts CamelCase words', () => {
    const d = new Dialect();
    const topics = d.extractTopics('The GraphQL schema was updated along with the database config');
    // GraphQL should rank high due to CamelCase boost
    assert(topics.indexOf('graphql') < 2, 'CamelCase should be boosted');
  });
});

// ============================================================
// Suite 5: extractKeySentence
// ============================================================

suite('extractKeySentence', () => {
  test('prefers sentences with decision words', () => {
    const d = new Dialect();
    const sentence = d.extractKeySentence(
      'The weather was nice today. We decided to use Redis because it was faster. The code compiled.'
    );
    assert(sentence.includes('decided') || sentence.includes('Redis') || sentence.includes('because'),
      'should pick the decision sentence');
  });

  test('truncates long sentences to 55 chars', () => {
    const d = new Dialect();
    const sentence = d.extractKeySentence(
      'We decided to completely restructure the entire application architecture from scratch because the old one was unmaintainable'
    );
    assert(sentence.length <= 55, `should be <= 55 chars, got ${sentence.length}`);
  });
});

// ============================================================
// Suite 6: compress (golden-file test)
// ============================================================

suite('compress', () => {
  test('compress produces valid AAAK format', () => {
    const d = new Dialect();
    const result = d.compress('We decided to use GraphQL instead of REST because it handles nested data better');
    // Should have format: 0:ENTITIES|topics|"key sentence"|emotions|flags
    assert(result.includes('0:'), 'should start content with 0:');
    assert(result.includes('|'), 'should have pipe separators');
  });

  test('compress with metadata produces header line', () => {
    const d = new Dialect();
    const result = d.compress('Some text about decisions', {
      source_file: '/path/to/session-start.ts',
      wing: 'technical',
      room: 'decisions',
      date: '2026-04-08',
    });
    const lines = result.split('\n');
    assertEqual(lines.length, 2, 'should have header + content');
    assert(lines[0].includes('technical'), 'header should contain wing');
    assert(lines[0].includes('session-start'), 'header should contain file stem');
  });

  test('compress empty text returns minimal AAAK', () => {
    const d = new Dialect();
    const result = d.compress('');
    assert(result.includes('0:???'), 'empty text should produce ??? entities');
    assert(result.includes('misc'), 'empty text should produce misc topic');
  });

  test('compression ratio is positive', () => {
    const d = new Dialect();
    const longText = 'We decided to migrate our entire backend from Express to Fastify because Fastify handles async operations better and has built-in schema validation. The team agreed this was the right call after benchmarking showed 3x throughput improvement.';
    const compressed = d.compress(longText);
    const stats = d.compressionStats(longText, compressed);
    assert(stats.ratio > 1, `compression ratio should be > 1, got ${stats.ratio}`);
  });
});

// ============================================================
// Suite 7: decode
// ============================================================

suite('decode', () => {
  test('decode parses header line', () => {
    const d = new Dialect();
    const decoded = d.decode('technical|decisions|2026-04-08|session-start\n0:???|graphql_rest|"decided to use GraphQL"|determ|DECISION');
    assertEqual(decoded.header.file, 'technical', 'file field');
    assertEqual(decoded.header.date, '2026-04-08', 'date field');
  });

  test('decode classifies zettels and tunnels', () => {
    const d = new Dialect();
    const decoded = d.decode('0:ALC+BOB|testing|"unit tests work"|joy|MILESTONE\nT:001<->002|related');
    assertEqual(decoded.zettels.length, 1, 'one zettel');
    assertEqual(decoded.tunnels.length, 1, 'one tunnel');
  });
});

// ============================================================
// Suite 8: countTokens
// ============================================================

suite('countTokens', () => {
  test('countTokens approximates at len/3', () => {
    assertEqual(Dialect.countTokens('hello world!'), 4, '12 chars / 3 = 4');
    assertEqual(Dialect.countTokens(''), 0, 'empty string');
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

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
