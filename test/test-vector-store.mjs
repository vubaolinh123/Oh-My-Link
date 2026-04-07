/**
 * Oh-My-Link — Vector Store Tests
 * Tests for dist/memory/vector-store.js (BM25 search index)
 * Run: node test/test-vector-store.mjs
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

const TEST_CWD = path.join(os.tmpdir(), `oml-test-vs-${Date.now()}`);

function setupTestDirs() {
  fs.mkdirSync(TEST_CWD, { recursive: true });
}

function cleanup() {
  try { fs.rmSync(TEST_CWD, { recursive: true, force: true }); } catch { /* best effort */ }
  // Also clean up the state dir created by the vector store (uses OML_HOME or ~/.oh-my-link)
  // The state dir is under OML_HOME/projects/{hash} - we rely on TEST_CWD being unique per run
}

setupTestDirs();

// Load modules
const state = require(path.join(DIST, 'state.js'));
const vs = require(path.join(DIST, 'memory', 'vector-store.js'));

// Ensure the project state dir exists so vector store can write index
state.ensureDir(state.getProjectStateRoot(TEST_CWD));

console.log('Oh-My-Link — Vector Store Tests');
console.log(`TEST_CWD: ${TEST_CWD}`);
console.log(`State dir: ${state.getProjectStateRoot(TEST_CWD)}`);

// ============================================================
// Suite 1: tokenize
// ============================================================

suite('tokenize', () => {
  test('tokenize splits and lowercases', () => {
    const tokens = vs.tokenize('Hello World TypeScript');
    assert(tokens.includes('hello'), 'lowercase hello');
    assert(tokens.includes('world'), 'lowercase world');
    assert(tokens.includes('typescript'), 'lowercase typescript');
  });

  test('tokenize removes stop words', () => {
    const tokens = vs.tokenize('the quick brown fox is very fast');
    assert(!tokens.includes('the'), 'removes "the"');
    assert(!tokens.includes('is'), 'removes "is"');
    assert(!tokens.includes('very'), 'removes "very"');
    assert(tokens.includes('quick'), 'keeps "quick"');
  });

  test('tokenize removes short tokens (< 2 chars)', () => {
    const tokens = vs.tokenize('a b cd efg');
    assert(!tokens.includes('a'), 'removes 1-char "a"');
    assert(!tokens.includes('b'), 'removes 1-char "b"');
    assert(tokens.includes('cd') || tokens.includes('efg'), 'keeps 2+ char tokens');
  });

  test('tokenize returns empty array for empty string', () => {
    const tokens = vs.tokenize('');
    assertEqual(tokens.length, 0, 'empty string should produce empty tokens');
  });

  test('tokenize splits on punctuation and non-word characters', () => {
    const tokens = vs.tokenize('hello-world, foo.bar baz!qux');
    assert(tokens.includes('hello'), 'token before hyphen');
    assert(tokens.includes('world'), 'token after hyphen');
    assert(tokens.includes('foo'), 'token before dot');
    assert(tokens.includes('bar'), 'token after dot');
  });
});

// ============================================================
// Suite 2: generateDocId
// ============================================================

suite('generateDocId', () => {
  test('generateDocId produces 8-char hex', () => {
    const id = vs.generateDocId('test content');
    assertEqual(id.length, 8, '8 chars');
    assert(/^[a-f0-9]+$/.test(id), 'hex chars only');
  });

  test('generateDocId is deterministic', () => {
    const id1 = vs.generateDocId('same text');
    const id2 = vs.generateDocId('same text');
    assertEqual(id1, id2, 'same input same output');
  });

  test('generateDocId differs for different text', () => {
    const id1 = vs.generateDocId('text one');
    const id2 = vs.generateDocId('text two');
    assert(id1 !== id2, 'different input different output');
  });

  test('generateDocId handles long input by truncating to 500 chars', () => {
    const longText = 'x'.repeat(1000);
    const truncatedText = 'x'.repeat(500);
    const id1 = vs.generateDocId(longText);
    const id2 = vs.generateDocId(truncatedText);
    // Both should produce the same id since only first 500 chars are hashed
    assertEqual(id1, id2, 'long text truncated to 500 chars for hashing');
  });
});

// ============================================================
// Suite 3: addDocument + countDocuments
// ============================================================

suite('addDocument + countDocuments', () => {
  test('addDocument increases count', () => {
    const before = vs.countDocuments(TEST_CWD);
    vs.addDocument(TEST_CWD, 'test memory about GraphQL decisions', {
      room: 'decision',
      source: 'test',
      importance: 4,
      timestamp: new Date().toISOString(),
    });
    const after = vs.countDocuments(TEST_CWD);
    assertEqual(after, before + 1, 'count should increase by 1');
  });

  test('addDocument returns the document id', () => {
    const id = vs.addDocument(TEST_CWD, 'unique document text for id test', {
      room: 'test', source: 'test', importance: 3,
      timestamp: new Date().toISOString(),
    });
    assert(typeof id === 'string', 'addDocument should return a string id');
    assertEqual(id.length, 8, 'id should be 8 chars');
    assert(/^[a-f0-9]+$/.test(id), 'id should be hex');
  });

  test('addDocument deduplicates by id', () => {
    const id1 = vs.addDocument(TEST_CWD, 'duplicate content text here', {
      room: 'test', source: 'test', importance: 3,
      timestamp: new Date().toISOString(),
    });
    const before = vs.countDocuments(TEST_CWD);
    const id2 = vs.addDocument(TEST_CWD, 'duplicate content text here', {
      room: 'test', source: 'test', importance: 3,
      timestamp: new Date().toISOString(),
    });
    const after = vs.countDocuments(TEST_CWD);
    assertEqual(id1, id2, 'same id for same content');
    assertEqual(after, before, 'count unchanged on duplicate');
  });
});

// ============================================================
// Suite 4: searchDocuments (BM25)
// ============================================================

suite('searchDocuments', () => {
  test('search returns relevant results', () => {
    vs.addDocument(TEST_CWD, 'decided to use PostgreSQL for the database layer', {
      room: 'decision', source: 'test', importance: 4,
      timestamp: new Date().toISOString(),
    });
    vs.addDocument(TEST_CWD, 'the weather was nice today nothing technical', {
      room: 'diary', source: 'test', importance: 2,
      timestamp: new Date().toISOString(),
    });
    const results = vs.searchDocuments(TEST_CWD, 'PostgreSQL database');
    assert(results.length > 0, 'should find results');
    assert(results[0].document.text.includes('PostgreSQL'), 'top result should be PostgreSQL doc');
  });

  test('search returns results with score and rank fields', () => {
    const results = vs.searchDocuments(TEST_CWD, 'PostgreSQL');
    assert(results.length > 0, 'should find results');
    assert(typeof results[0].score === 'number', 'result should have numeric score');
    assertEqual(results[0].rank, 1, 'first result rank should be 1');
  });

  test('search with room filter returns only matching room', () => {
    const results = vs.searchDocuments(TEST_CWD, 'database', 10, { room: 'decision' });
    for (const r of results) {
      assertEqual(r.document.metadata.room, 'decision', 'all results should be decisions');
    }
  });

  test('search on empty query returns empty array', () => {
    const results = vs.searchDocuments(TEST_CWD, '');
    assertEqual(results.length, 0, 'empty query should return no results');
  });

  test('search on stop-words-only query returns empty array', () => {
    // "the is very" are all stop words
    const results = vs.searchDocuments(TEST_CWD, 'the is very');
    assertEqual(results.length, 0, 'stop-words-only query should return no results');
  });

  test('search with room filter that matches no docs returns empty array', () => {
    const results = vs.searchDocuments(TEST_CWD, 'database', 10, { room: 'nonexistent-room' });
    assertEqual(results.length, 0, 'no results for nonexistent room');
  });
});

// ============================================================
// Suite 5: getAllDocuments
// ============================================================

suite('getAllDocuments', () => {
  test('getAllDocuments returns all documents', () => {
    const count = vs.countDocuments(TEST_CWD);
    const docs = vs.getAllDocuments(TEST_CWD);
    assertEqual(docs.length, count, 'getAllDocuments count matches countDocuments');
  });

  test('getAllDocuments returns sorted by importance descending', () => {
    const docs = vs.getAllDocuments(TEST_CWD);
    for (let i = 1; i < docs.length; i++) {
      const prev = docs[i - 1].metadata.importance ?? 3;
      const curr = docs[i].metadata.importance ?? 3;
      assert(prev >= curr, `importance at ${i - 1} (${prev}) should be >= importance at ${i} (${curr})`);
    }
  });

  test('getAllDocuments with room filter returns only matching room', () => {
    const docs = vs.getAllDocuments(TEST_CWD, { room: 'decision' });
    for (const d of docs) {
      assertEqual(d.metadata.room, 'decision', 'all docs should be in decision room');
    }
  });

  test('getAllDocuments each document has id, text, tokens, metadata, added_at', () => {
    const docs = vs.getAllDocuments(TEST_CWD);
    assert(docs.length > 0, 'there should be at least one document');
    for (const doc of docs) {
      assert(typeof doc.id === 'string', 'doc.id should be string');
      assert(typeof doc.text === 'string', 'doc.text should be string');
      assert(Array.isArray(doc.tokens), 'doc.tokens should be array');
      assert(doc.metadata !== null && typeof doc.metadata === 'object', 'doc.metadata should be object');
      assert(typeof doc.added_at === 'string', 'doc.added_at should be string');
    }
  });
});

// ============================================================
// Suite 6: deleteDocument
// ============================================================

suite('deleteDocument', () => {
  test('deleteDocument removes document and decreases count', () => {
    const id = vs.addDocument(TEST_CWD, 'temporary memory to delete from index', {
      room: 'test', source: 'test', importance: 1,
      timestamp: new Date().toISOString(),
    });
    const before = vs.countDocuments(TEST_CWD);
    const deleted = vs.deleteDocument(TEST_CWD, id);
    assert(deleted === true, 'deleteDocument should return true for existing doc');
    assertEqual(vs.countDocuments(TEST_CWD), before - 1, 'count should decrease by 1');
  });

  test('deleteDocument returns false for nonexistent id', () => {
    const deleted = vs.deleteDocument(TEST_CWD, 'nonexistent');
    assert(deleted === false, 'deleteDocument should return false for missing id');
  });

  test('deleted document no longer appears in getAllDocuments', () => {
    const id = vs.addDocument(TEST_CWD, 'document to verify removal from list', {
      room: 'test', source: 'test', importance: 1,
      timestamp: new Date().toISOString(),
    });
    vs.deleteDocument(TEST_CWD, id);
    const docs = vs.getAllDocuments(TEST_CWD);
    const found = docs.some(d => d.id === id);
    assert(!found, 'deleted document should not appear in getAllDocuments');
  });

  test('deleted document no longer appears in searchDocuments', () => {
    const uniqueText = 'xyzzy_quux_frobnicate_zork_unique_query_text';
    const id = vs.addDocument(TEST_CWD, uniqueText, {
      room: 'test', source: 'test', importance: 1,
      timestamp: new Date().toISOString(),
    });
    vs.deleteDocument(TEST_CWD, id);
    const results = vs.searchDocuments(TEST_CWD, 'xyzzy');
    const found = results.some(r => r.document.id === id);
    assert(!found, 'deleted document should not appear in search results');
  });
});

// ============================================================
// Suite 7: BM25 scoring sanity
// ============================================================

suite('BM25 scoring sanity', () => {
  test('BM25 scores relevant docs higher than irrelevant', () => {
    vs.addDocument(TEST_CWD, 'TypeScript compiler strict mode configuration tsconfig settings', {
      room: 'technical', source: 'test', importance: 3,
      timestamp: new Date().toISOString(),
    });
    vs.addDocument(TEST_CWD, 'family vacation photos summer beach relaxation holiday', {
      room: 'diary', source: 'test', importance: 3,
      timestamp: new Date().toISOString(),
    });
    const results = vs.searchDocuments(TEST_CWD, 'TypeScript configuration');
    assert(results.length >= 1, 'should find at least one result');
    assert(
      results[0].document.text.includes('TypeScript'),
      'TypeScript doc should rank first for TypeScript query'
    );
  });

  test('BM25 scores increase for more query term matches', () => {
    // Doc with 2 matching terms should score higher than doc with 1 matching term
    const id1 = vs.addDocument(TEST_CWD, 'redis cache eviction redis policy configuration', {
      room: 'technical', source: 'test', importance: 3,
      timestamp: new Date().toISOString(),
    });
    const id2 = vs.addDocument(TEST_CWD, 'redis setup installation guide', {
      room: 'technical', source: 'test', importance: 3,
      timestamp: new Date().toISOString(),
    });
    const results = vs.searchDocuments(TEST_CWD, 'redis cache', 10);
    // Find our specific docs
    const score1 = results.find(r => r.document.id === id1)?.score ?? 0;
    const score2 = results.find(r => r.document.id === id2)?.score ?? 0;
    assert(score1 > 0, 'multi-match doc should have positive score');
    assert(score1 >= score2, 'doc with more query term matches should score >= single-match doc');
  });

  test('BM25 results are ordered by score descending', () => {
    const results = vs.searchDocuments(TEST_CWD, 'TypeScript configuration');
    for (let i = 1; i < results.length; i++) {
      assert(
        results[i - 1].score >= results[i].score,
        `results[${i - 1}].score (${results[i - 1].score}) should be >= results[${i}].score (${results[i].score})`
      );
    }
  });

  test('BM25 ranks are sequential starting from 1', () => {
    const results = vs.searchDocuments(TEST_CWD, 'TypeScript database configuration');
    for (let i = 0; i < results.length; i++) {
      assertEqual(results[i].rank, i + 1, `rank at index ${i} should be ${i + 1}`);
    }
  });
});

// ============================================================
// Cleanup & Summary
// ============================================================

// Clean up the state dir created under OML_HOME/~
const stateRoot = state.getProjectStateRoot(TEST_CWD);
try { fs.rmSync(stateRoot, { recursive: true, force: true }); } catch { /* best effort */ }

cleanup();

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
