/**
 * Oh-My-Link — Knowledge Graph Tests
 * Tests for dist/memory/knowledge-graph.js
 * Run: node test/test-knowledge-graph.mjs
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

// ============================================================
// Setup: temp directory for test DB
// ============================================================

const tmpDir = path.join(os.tmpdir(), `oml-kg-test-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
const dbPath = path.join(tmpDir, 'test-kg.sqlite3');

let KnowledgeGraph;
let hasBetterSqlite3 = false;

try {
  const kgMod = require(path.join(DIST, 'memory', 'knowledge-graph.js'));
  KnowledgeGraph = kgMod.KnowledgeGraph;
  hasBetterSqlite3 = true;
} catch (err) {
  console.log(`  WARN  Cannot load KnowledgeGraph: ${err.message}`);
  console.log(`        Skipping all KG tests (install better-sqlite3 to enable)`);
}

console.log('\n=== Knowledge Graph Tests ===\n');

if (!hasBetterSqlite3) {
  for (let i = 1; i <= 11; i++) skip(`KG test ${i} (no better-sqlite3)`);
} else {
  // Fresh KG for each test group
  let kg;

  // ── Test 1: addEntity + queryEntity ───────────────────────────
  test('1. addEntity + queryEntity', () => {
    kg = new KnowledgeGraph(dbPath);
    kg.addEntity('Alice', 'person', { gender: 'female' });
    kg.addTriple('Alice', 'works_on', 'MemPalace');
    const results = kg.queryEntity('Alice');
    assert(results.length >= 1, `expected >= 1 result, got ${results.length}`);
    const r = results.find(r => r.predicate === 'works_on');
    assert(r, 'should find works_on triple');
    assertEqual(r.subject, 'Alice', 'subject');
    assertEqual(r.object, 'MemPalace', 'object');
    assertEqual(r.current, true, 'current');
    kg.close();
  });

  // ── Test 2: Temporal filtering ────────────────────────────────
  test('2. Temporal filtering', () => {
    // Use a fresh DB for temporal tests
    const db2 = path.join(tmpDir, 'test-kg-2.sqlite3');
    kg = new KnowledgeGraph(db2);
    kg.addTriple('Bob', 'loves', 'chess', { valid_from: '2025-01' });
    kg.addTriple('Bob', 'loves', 'piano', { valid_from: '2026-01' });

    // Query at 2025-06: should only get chess
    const mid2025 = kg.queryEntity('Bob', '2025-06');
    const chessOnly = mid2025.filter(r => r.predicate === 'loves');
    assertEqual(chessOnly.length, 1, 'mid-2025 should have 1 loves');
    assertEqual(chessOnly[0].object, 'chess', 'mid-2025 loves chess');

    // Query at 2026-06: should get both
    const mid2026 = kg.queryEntity('Bob', '2026-06');
    const both = mid2026.filter(r => r.predicate === 'loves');
    assertEqual(both.length, 2, 'mid-2026 should have 2 loves');
    kg.close();
  });

  // ── Test 3: Invalidation ──────────────────────────────────────
  test('3. Invalidation', () => {
    const db3 = path.join(tmpDir, 'test-kg-3.sqlite3');
    kg = new KnowledgeGraph(db3);
    kg.addTriple('Bob', 'has_issue', 'injury', { valid_from: '2025-06' });

    // Invalidate
    const result = kg.invalidate('Bob', 'has_issue', 'injury', '2026-02');
    assert(result === true, 'invalidate should return true');

    // Query: injury should have current=false
    const facts = kg.queryEntity('Bob');
    const injuryFact = facts.find(f => f.predicate === 'has_issue');
    assert(injuryFact, 'injury fact should still be in results');
    assertEqual(injuryFact.current, false, 'injury should not be current');
    assertEqual(injuryFact.valid_to, '2026-02', 'valid_to should be 2026-02');
    kg.close();
  });

  // ── Test 4: Duplicate prevention ──────────────────────────────
  test('4. Duplicate prevention', () => {
    const db4 = path.join(tmpDir, 'test-kg-4.sqlite3');
    kg = new KnowledgeGraph(db4);
    const id1 = kg.addTriple('Alice', 'works_on', 'MemPalace');
    const id2 = kg.addTriple('Alice', 'works_on', 'MemPalace');
    assertEqual(id1, id2, 'duplicate triple IDs should match');
    kg.close();
  });

  // ── Test 5: Direction queries ─────────────────────────────────
  test('5. Direction queries', () => {
    const db5 = path.join(tmpDir, 'test-kg-5.sqlite3');
    kg = new KnowledgeGraph(db5);
    kg.addTriple('Alice', 'mentors', 'Bob');

    const outgoing = kg.queryEntity('Alice', undefined, 'outgoing');
    assert(outgoing.some(r => r.predicate === 'mentors' && r.object === 'Bob'),
      'outgoing should show Alice mentors Bob');

    const incoming = kg.queryEntity('Bob', undefined, 'incoming');
    assert(incoming.some(r => r.predicate === 'mentors' && r.subject === 'Alice'),
      'incoming should show Alice mentors Bob');

    const both = kg.queryEntity('Bob', undefined, 'both');
    assert(both.some(r => r.direction === 'incoming'),
      'both should include incoming');
    kg.close();
  });

  // ── Test 6: queryRelationship ─────────────────────────────────
  test('6. queryRelationship', () => {
    const db6 = path.join(tmpDir, 'test-kg-6.sqlite3');
    kg = new KnowledgeGraph(db6);
    kg.addTriple('Alice', 'uses', 'TypeScript');
    kg.addTriple('Bob', 'uses', 'Python');

    const results = kg.queryRelationship('uses');
    assertEqual(results.length, 2, 'should find 2 uses triples');
    const subjects = results.map(r => r.subject).sort();
    assert(subjects.includes('Alice'), 'should include Alice');
    assert(subjects.includes('Bob'), 'should include Bob');
    kg.close();
  });

  // ── Test 7: timeline ──────────────────────────────────────────
  test('7. timeline', () => {
    const db7 = path.join(tmpDir, 'test-kg-7.sqlite3');
    kg = new KnowledgeGraph(db7);
    kg.addTriple('Alice', 'started', 'project_a', { valid_from: '2025-01' });
    kg.addTriple('Alice', 'started', 'project_b', { valid_from: '2025-06' });

    const tl = kg.timeline('Alice');
    assert(tl.length >= 2, `expected >= 2 timeline entries, got ${tl.length}`);
    // Should be ordered by valid_from
    const projectA = tl.find(t => t.object === 'project_a');
    const projectB = tl.find(t => t.object === 'project_b');
    assert(projectA, 'should find project_a');
    assert(projectB, 'should find project_b');
    kg.close();
  });

  // ── Test 8: stats ─────────────────────────────────────────────
  test('8. stats', () => {
    const db8 = path.join(tmpDir, 'test-kg-8.sqlite3');
    kg = new KnowledgeGraph(db8);
    kg.addEntity('Alice', 'person');
    kg.addEntity('Bob', 'person');
    kg.addTriple('Alice', 'knows', 'Bob');

    const s = kg.stats();
    assertEqual(s.entities, 2, 'should have 2 entities');
    assertEqual(s.triples, 1, 'should have 1 triple');
    assertEqual(s.current_facts, 1, 'should have 1 current fact');
    assertEqual(s.expired_facts, 0, 'should have 0 expired facts');
    assert(s.relationship_types.includes('knows'), 'should include knows relationship');
    kg.close();
  });

  // ── Test 9: Auto-create entities ──────────────────────────────
  test('9. Auto-create entities', () => {
    const db9 = path.join(tmpDir, 'test-kg-9.sqlite3');
    kg = new KnowledgeGraph(db9);
    // Don't pre-create entities
    kg.addTriple('Charlie', 'likes', 'Dogs');
    const s = kg.stats();
    assert(s.entities >= 2, `should have >= 2 auto-created entities, got ${s.entities}`);
    kg.close();
  });

  // ── Test 10: seedFromEntityFacts ──────────────────────────────
  test('10. seedFromEntityFacts', () => {
    const db10 = path.join(tmpDir, 'test-kg-10.sqlite3');
    kg = new KnowledgeGraph(db10);
    kg.seedFromEntityFacts({
      alice: {
        full_name: 'Alice',
        type: 'person',
        interests: ['chess', 'painting'],
      },
    });
    const results = kg.queryEntity('Alice');
    const lovesChess = results.find(r => r.predicate === 'loves' && r.object === 'Chess');
    assert(lovesChess, 'should find loves Chess triple');
    const lovesPainting = results.find(r => r.predicate === 'loves' && r.object === 'Painting');
    assert(lovesPainting, 'should find loves Painting triple');
    kg.close();
  });

  // ── Test 11: DB cleanup ───────────────────────────────────────
  test('11. DB cleanup', () => {
    // Verify we can clean up all test databases
    const files = fs.readdirSync(tmpDir);
    const sqliteFiles = files.filter(f => f.endsWith('.sqlite3'));
    assert(sqliteFiles.length > 0, 'should have created SQLite files');

    // Clean up
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(tmpDir, f));
      } catch { /* ignore */ }
    }
    try {
      fs.rmdirSync(tmpDir);
    } catch { /* ignore */ }

    assert(!fs.existsSync(dbPath), 'test DB should be cleaned up');
  });
}

// ============================================================
// Summary
// ============================================================

console.log(`\n--- Results: ${passed} passed, ${failed} failed, ${skipped} skipped ---`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ${f.name}: ${f.error}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
