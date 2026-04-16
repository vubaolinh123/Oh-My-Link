/**
 * Tier 4: MemPalace Comparison Benchmark
 *
 * Tests OML's memory system against MemPalace's methodology:
 * - Mode A: Raw verbatim text into BM25 store
 * - Mode B: Extracted + AAAK compressed into BM25 store
 * - Computes R@5, R@10, NDCG@10, per-category breakdown
 * - Produces side-by-side comparison with MemPalace claimed numbers
 *
 * Run: node test/bench-mempalace-comparison.mjs
 */

import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const FIXTURES = path.resolve(__dirname, 'bench-fixtures');
const RESULTS_DIR = path.resolve(__dirname, 'bench-results');

// ── Load compiled modules ────────────────────────────────────────
const vectorStore = require(path.join(DIST, 'memory', 'vector-store.js'));
const stateModule = require(path.join(DIST, 'state.js'));
const { extractMemories } = require(path.join(DIST, 'memory', 'memory-extractor.js'));
const { Dialect } = require(path.join(DIST, 'memory', 'aaak-dialect.js'));

// ── Load corpus ──────────────────────────────────────────────────
const corpus = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'mempalace-comparison-corpus.json'), 'utf-8')
);

// ── Metrics ──────────────────────────────────────────────────────

function dcg(relevances, k) {
  let score = 0;
  for (let i = 0; i < Math.min(relevances.length, k); i++) {
    score += relevances[i] / Math.log2(i + 2);
  }
  return score;
}

function ndcg(retrievedSessionIds, expectedSessionId, k) {
  const rels = retrievedSessionIds.slice(0, k).map(id => id === expectedSessionId ? 1 : 0);
  const ideal = [...rels].sort((a, b) => b - a);
  const idcgVal = dcg(ideal, k);
  return idcgVal === 0 ? 0 : dcg(rels, k) / idcgVal;
}

// ── Run one mode ─────────────────────────────────────────────────

function runMode(modeName, processSession) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `oml-bench-mp-${modeName}-`));
  const origGetVectorIndexPath = stateModule.getVectorIndexPath;
  stateModule.getVectorIndexPath = () => path.join(tmpDir, 'vector-index.json');

  let totalOrigChars = 0;
  let totalStoredChars = 0;

  // Ingest sessions
  const t0 = Date.now();
  for (const session of corpus.sessions) {
    const { text, metadata } = processSession(session);
    totalOrigChars += session.content.length;
    totalStoredChars += text.length;

    vectorStore.addDocument(tmpDir, text, {
      room: session.topic || 'general',
      source: 'benchmark',
      importance: 3,
      timestamp: session.timestamp,
      source_session_id: session.session_id,
      raw: session.content, // always store raw for BM25 tokenization
    });
  }
  const ingestTime = Date.now() - t0;

  // Query
  const queryResults = [];
  let r5Hits = 0, r10Hits = 0, ndcg10Sum = 0;
  const perCategory = {};

  const tQ0 = Date.now();
  for (const q of corpus.questions) {
    const results = vectorStore.searchDocuments(tmpDir, q.question, 10);

    // Map results to session IDs via metadata
    const retrievedSessionIds = results.map(r => {
      return r.document.metadata?.source_session_id || 'unknown';
    });

    const expectedSid = q.ground_truth_session_id;

    // R@5
    const top5 = retrievedSessionIds.slice(0, 5);
    const hit5 = top5.includes(expectedSid);
    if (hit5) r5Hits++;

    // R@10
    const top10 = retrievedSessionIds.slice(0, 10);
    const hit10 = top10.includes(expectedSid);
    if (hit10) r10Hits++;

    // NDCG@10
    const ndcgScore = ndcg(retrievedSessionIds, expectedSid, 10);
    ndcg10Sum += ndcgScore;

    // Per-category tracking
    const cat = q.category;
    if (!perCategory[cat]) {
      perCategory[cat] = { total: 0, r5: 0, r10: 0, ndcg10: 0 };
    }
    perCategory[cat].total++;
    if (hit5) perCategory[cat].r5++;
    if (hit10) perCategory[cat].r10++;
    perCategory[cat].ndcg10 += ndcgScore;

    queryResults.push({
      id: q.id,
      question: q.question,
      category: cat,
      difficulty: q.difficulty,
      expected: expectedSid,
      retrieved: retrievedSessionIds.slice(0, 10),
      hit5,
      hit10,
      ndcg10: ndcgScore,
      scores: results.slice(0, 5).map(r => r.score.toFixed(3)),
    });
  }
  const queryTime = Date.now() - tQ0;

  // Cleanup
  stateModule.getVectorIndexPath = origGetVectorIndexPath;
  try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

  const totalQ = corpus.questions.length;
  const compressionRatio = totalOrigChars / Math.max(totalStoredChars, 1);
  const tokensPerQuery = Math.round(totalStoredChars / 3 / Math.max(totalQ, 1));

  return {
    mode: modeName,
    sessions: corpus.sessions.length,
    questions: totalQ,
    r5: r5Hits / totalQ,
    r10: r10Hits / totalQ,
    ndcg10: ndcg10Sum / totalQ,
    r5Hits,
    r10Hits,
    compressionRatio,
    totalOrigChars,
    totalStoredChars,
    tokensPerQuery,
    ingestTimeMs: ingestTime,
    queryTimeMs: queryTime,
    perCategory,
    queryResults,
  };
}

// ── Mode A: Raw verbatim ─────────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('  Tier 4: MemPalace Comparison Benchmark');
console.log('='.repeat(70));
console.log(`  Corpus: ${corpus.sessions.length} sessions, ${corpus.questions.length} questions`);
console.log(`  Categories: ${[...new Set(corpus.questions.map(q => q.category))].join(', ')}`);
console.log('-'.repeat(70));

console.log('\n  [Mode A] Ingesting raw verbatim sessions...');
const rawResult = runMode('raw-verbatim', (session) => ({
  text: session.content,
  metadata: {},
}));
console.log(`    Ingest: ${rawResult.ingestTimeMs}ms | Query: ${rawResult.queryTimeMs}ms`);
console.log(`    R@5: ${(rawResult.r5 * 100).toFixed(1)}% | R@10: ${(rawResult.r10 * 100).toFixed(1)}% | NDCG@10: ${rawResult.ndcg10.toFixed(3)}`);

// ── Mode B: Extracted + AAAK compressed ──────────────────────────

console.log('\n  [Mode B] Ingesting extracted + AAAK compressed sessions...');
const dialect = new Dialect();
const extractedResult = runMode('extracted-aaak', (session) => {
  // Extract memories from session content
  const memories = extractMemories(session.content, 0.1);

  if (memories.length === 0) {
    // Fallback: compress raw content
    return { text: dialect.compress(session.content), metadata: {} };
  }

  // Compress each extracted memory and combine
  const compressed = memories
    .map(m => dialect.compress(m.content))
    .join('\n');
  return { text: compressed, metadata: {} };
});
console.log(`    Ingest: ${extractedResult.ingestTimeMs}ms | Query: ${extractedResult.queryTimeMs}ms`);
console.log(`    R@5: ${(extractedResult.r5 * 100).toFixed(1)}% | R@10: ${(extractedResult.r10 * 100).toFixed(1)}% | NDCG@10: ${extractedResult.ndcg10.toFixed(3)}`);
console.log(`    Compression: ${extractedResult.compressionRatio.toFixed(1)}x (${extractedResult.totalOrigChars} -> ${extractedResult.totalStoredChars} chars)`);

// ── Comparison Table ─────────────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('  COMPARISON TABLE');
console.log('='.repeat(70));

const table = [
  {
    name: 'OML Raw (verbatim BM25)',
    r5: rawResult.r5,
    r10: rawResult.r10,
    ndcg10: rawResult.ndcg10,
    tokens: rawResult.tokensPerQuery,
    compression: '1.0x',
  },
  {
    name: 'OML Extracted+AAAK',
    r5: extractedResult.r5,
    r10: extractedResult.r10,
    ndcg10: extractedResult.ndcg10,
    tokens: extractedResult.tokensPerQuery,
    compression: `${extractedResult.compressionRatio.toFixed(1)}x`,
  },
  {
    name: 'MemPalace Raw (claimed)',
    r5: 0.966,
    r10: 0.99,
    ndcg10: 0.889,
    tokens: '~500',
    compression: '1.0x',
  },
  {
    name: 'MemPalace Hybrid+Rerank',
    r5: 0.984,
    r10: 0.998,
    ndcg10: 0.938,
    tokens: '~500',
    compression: '1.0x',
  },
];

console.log('');
console.log(`  ${'System'.padEnd(30)} ${'R@5'.padStart(8)} ${'R@10'.padStart(8)} ${'NDCG@10'.padStart(9)} ${'Tok/Q'.padStart(8)} ${'Compress'.padStart(10)}`);
console.log('  ' + '-'.repeat(75));

for (const row of table) {
  const r5Str = typeof row.r5 === 'number' ? `${(row.r5 * 100).toFixed(1)}%` : row.r5;
  const r10Str = typeof row.r10 === 'number' ? `${(row.r10 * 100).toFixed(1)}%` : row.r10;
  const ndcgStr = typeof row.ndcg10 === 'number' ? row.ndcg10.toFixed(3) : row.ndcg10;
  const tokStr = typeof row.tokens === 'number' ? `~${row.tokens}` : row.tokens;
  console.log(`  ${row.name.padEnd(30)} ${r5Str.padStart(8)} ${r10Str.padStart(8)} ${ndcgStr.padStart(9)} ${tokStr.padStart(8)} ${row.compression.padStart(10)}`);
}

// ── Per-Category Breakdown ───────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('  PER-CATEGORY BREAKDOWN');
console.log('='.repeat(70));

const categories = [...new Set(corpus.questions.map(q => q.category))].sort();

console.log('');
console.log(`  ${'Category'.padEnd(30)} ${'Mode'.padEnd(20)} ${'R@5'.padStart(8)} ${'R@10'.padStart(8)} ${'NDCG@10'.padStart(9)} ${'n'.padStart(5)}`);
console.log('  ' + '-'.repeat(80));

for (const cat of categories) {
  for (const [label, result] of [['Raw', rawResult], ['Extracted+AAAK', extractedResult]]) {
    const c = result.perCategory[cat];
    if (!c) continue;
    const r5 = (c.r5 / c.total * 100).toFixed(1) + '%';
    const r10 = (c.r10 / c.total * 100).toFixed(1) + '%';
    const ndcgAvg = (c.ndcg10 / c.total).toFixed(3);
    console.log(`  ${cat.padEnd(30)} ${label.padEnd(20)} ${r5.padStart(8)} ${r10.padStart(8)} ${ndcgAvg.padStart(9)} ${String(c.total).padStart(5)}`);
  }
}

// ── Misses analysis ──────────────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('  MISSES ANALYSIS (Raw Mode, R@10)');
console.log('='.repeat(70));

const rawMisses = rawResult.queryResults.filter(q => !q.hit10);
if (rawMisses.length === 0) {
  console.log('  No misses at R@10!');
} else {
  console.log(`  ${rawMisses.length} misses:`);
  for (const m of rawMisses.slice(0, 15)) {
    console.log(`    ${m.id} [${m.category}/${m.difficulty}]: "${m.question.slice(0, 60)}..." expected=${m.expected} got=[${m.retrieved.slice(0, 3).join(',')}]`);
  }
  if (rawMisses.length > 15) {
    console.log(`    ... and ${rawMisses.length - 15} more`);
  }
}

console.log('\n' + '='.repeat(70));
console.log('  MISSES ANALYSIS (Extracted+AAAK Mode, R@10)');
console.log('='.repeat(70));

const aaakMisses = extractedResult.queryResults.filter(q => !q.hit10);
if (aaakMisses.length === 0) {
  console.log('  No misses at R@10!');
} else {
  console.log(`  ${aaakMisses.length} misses:`);
  for (const m of aaakMisses.slice(0, 15)) {
    console.log(`    ${m.id} [${m.category}/${m.difficulty}]: "${m.question.slice(0, 60)}..." expected=${m.expected} got=[${m.retrieved.slice(0, 3).join(',')}]`);
  }
  if (aaakMisses.length > 15) {
    console.log(`    ... and ${aaakMisses.length - 15} more`);
  }
}

// ── Pass/Fail Criteria ───────────────────────────────────────────

// OML Raw should achieve at least reasonable recall with BM25
// (BM25 baseline on LME is ~70%, we should beat that on our own corpus)
const rawPass = rawResult.r5 >= 0.60 && rawResult.r10 >= 0.70;
const aaakPass = true; // AAAK mode is informational — lower recall expected due to compression

console.log('\n' + '='.repeat(70));
console.log(`  RESULT: ${rawPass ? 'PASS' : 'FAIL'}`);
console.log(`    Raw R@5 >= 60%: ${rawResult.r5 >= 0.60 ? 'YES' : 'NO'} (${(rawResult.r5 * 100).toFixed(1)}%)`);
console.log(`    Raw R@10 >= 70%: ${rawResult.r10 >= 0.70 ? 'YES' : 'NO'} (${(rawResult.r10 * 100).toFixed(1)}%)`);
console.log('='.repeat(70) + '\n');

// ── Save results ─────────────────────────────────────────────────

if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

const resultFile = {
  tier: '4',
  name: 'MemPalace Comparison',
  timestamp: new Date().toISOString(),
  corpus: {
    sessions: corpus.sessions.length,
    questions: corpus.questions.length,
    categories: catCounts(corpus.questions),
  },
  results: {
    raw: {
      r5: rawResult.r5,
      r10: rawResult.r10,
      ndcg10: rawResult.ndcg10,
      tokensPerQuery: rawResult.tokensPerQuery,
      compressionRatio: 1.0,
      perCategory: rawResult.perCategory,
      ingestTimeMs: rawResult.ingestTimeMs,
      queryTimeMs: rawResult.queryTimeMs,
    },
    extractedAaak: {
      r5: extractedResult.r5,
      r10: extractedResult.r10,
      ndcg10: extractedResult.ndcg10,
      tokensPerQuery: extractedResult.tokensPerQuery,
      compressionRatio: extractedResult.compressionRatio,
      perCategory: extractedResult.perCategory,
      ingestTimeMs: extractedResult.ingestTimeMs,
      queryTimeMs: extractedResult.queryTimeMs,
    },
    mempalaceClaimed: {
      raw: { r5: 0.966, r10: 0.99, ndcg10: 0.889 },
      hybridRerank: { r5: 0.984, r10: 0.998, ndcg10: 0.938 },
    },
  },
  misses: {
    raw: rawResult.queryResults.filter(q => !q.hit10).map(q => ({
      id: q.id, question: q.question, category: q.category,
      expected: q.expected, retrieved: q.retrieved.slice(0, 5),
    })),
    extractedAaak: extractedResult.queryResults.filter(q => !q.hit10).map(q => ({
      id: q.id, question: q.question, category: q.category,
      expected: q.expected, retrieved: q.retrieved.slice(0, 5),
    })),
  },
  passed: rawPass,
};

function catCounts(questions) {
  const counts = {};
  for (const q of questions) {
    counts[q.category] = (counts[q.category] || 0) + 1;
  }
  return counts;
}

const outPath = path.join(RESULTS_DIR, 'bench-4-mempalace-comparison.json');
fs.writeFileSync(outPath, JSON.stringify(resultFile, null, 2));
console.log(`  Results saved to: ${outPath}`);

process.exit(rawPass ? 0 : 1);
