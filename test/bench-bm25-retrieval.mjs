/**
 * Tier 1C: BM25 Retrieval Quality Benchmark
 *
 * Measures Recall@5, Recall@10, NDCG@10 of the BM25 vector store.
 * Run: node test/bench-bm25-retrieval.mjs
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

const vectorStore = require(path.join(DIST, 'memory', 'vector-store.js'));
const stateModule = require(path.join(DIST, 'state.js'));

// ── Load fixtures ──────────────────────────────────────────────

const corpus = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'retrieval-corpus.json'), 'utf-8'));

// ── Setup: create a temp project directory with vector index ───

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oml-bench-'));

// Patch state to use our temp dir
const origGetVectorIndexPath = stateModule.getVectorIndexPath;
stateModule.getVectorIndexPath = () => path.join(tmpDir, 'vector-index.json');

// Index all documents
console.log('\n  Indexing documents...');
for (const doc of corpus.documents) {
  vectorStore.addDocument(tmpDir, doc.text, {
    room: doc.tags[0] || 'general',
    source: 'benchmark',
    importance: 3,
    timestamp: new Date().toISOString(),
  });
}
console.log(`  Indexed ${corpus.documents.length} documents.`);

// ── Metrics helper ─────────────────────────────────────────────

function dcg(relevances, k) {
  let score = 0;
  for (let i = 0; i < Math.min(relevances.length, k); i++) {
    score += relevances[i] / Math.log2(i + 2);
  }
  return score;
}

function ndcg(retrievedIds, expectedIds, k) {
  const relevances = retrievedIds.slice(0, k).map(id =>
    expectedIds.includes(id) ? 1 : 0
  );
  const idealRelevances = [...relevances].sort((a, b) => b - a);
  const idcg = dcg(idealRelevances, k);
  return idcg === 0 ? 0 : dcg(relevances, k) / idcg;
}

// ── Run queries ────────────────────────────────────────────────

const queryResults = [];
let recall5Hits = 0;
let recall10Hits = 0;
let ndcg10Sum = 0;
let recall5Total = 0;
let recall10Total = 0;

for (const q of corpus.queries) {
  const results = vectorStore.searchDocuments(tmpDir, q.query, 10);
  const retrievedTexts = results.map(r => r.document.text);

  // Map retrieved results back to document IDs
  const retrievedDocIds = retrievedTexts.map(text => {
    const doc = corpus.documents.find(d => d.text === text);
    return doc ? doc.id : 'unknown';
  });

  // Recall@5
  const top5 = retrievedDocIds.slice(0, 5);
  const hit5 = q.expectedDocIds.some(id => top5.includes(id));
  if (q.expectedAtK <= 5) {
    recall5Total++;
    if (hit5) recall5Hits++;
  }

  // Recall@10
  const top10 = retrievedDocIds.slice(0, 10);
  const hit10 = q.expectedDocIds.some(id => top10.includes(id));
  recall10Total++;
  if (hit10) recall10Hits++;

  // NDCG@10
  const ndcgScore = ndcg(retrievedDocIds, q.expectedDocIds, 10);
  ndcg10Sum += ndcgScore;

  queryResults.push({
    id: q.id,
    query: q.query,
    expectedDocIds: q.expectedDocIds,
    retrievedDocIds: retrievedDocIds.slice(0, 10),
    hit5,
    hit10,
    ndcg10: ndcgScore.toFixed(3),
    scores: results.slice(0, 5).map(r => r.score.toFixed(3)),
  });
}

// ── Summary ────────────────────────────────────────────────────

const recall5 = recall5Total > 0 ? (recall5Hits / recall5Total * 100) : 0;
const recall10 = recall10Total > 0 ? (recall10Hits / recall10Total * 100) : 0;
const avgNdcg10 = ndcg10Sum / corpus.queries.length;

const summary = {
  tier: '1C',
  name: 'BM25 Retrieval Quality',
  summary: {
    totalDocuments: corpus.documents.length,
    totalQueries: corpus.queries.length,
    recall5: `${recall5.toFixed(1)}% (${recall5Hits}/${recall5Total})`,
    recall10: `${recall10.toFixed(1)}% (${recall10Hits}/${recall10Total})`,
    ndcg10: avgNdcg10.toFixed(3),
  },
  queries: queryResults,
};

// Pass criteria: Recall@5 >= 60%, Recall@10 >= 75%
const passed = recall5 >= 60 && recall10 >= 75;

// ── Output ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('  Tier 1C: BM25 Retrieval Quality Benchmark');
console.log('='.repeat(60));
console.log(`  Documents:     ${corpus.documents.length}`);
console.log(`  Queries:       ${corpus.queries.length}`);
console.log(`  Recall@5:      ${recall5.toFixed(1)}% (${recall5Hits}/${recall5Total})`);
console.log(`  Recall@10:     ${recall10.toFixed(1)}% (${recall10Hits}/${recall10Total})`);
console.log(`  NDCG@10:       ${avgNdcg10.toFixed(3)}`);
console.log('-'.repeat(60));
console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
console.log('='.repeat(60) + '\n');

// Show misses
const misses = queryResults.filter(q => !q.hit10);
if (misses.length > 0) {
  console.log('  Misses at R@10:');
  for (const m of misses) {
    console.log(`    ${m.id}: "${m.query}" expected=[${m.expectedDocIds}] got=[${m.retrievedDocIds.slice(0, 3)}]`);
  }
  console.log('');
}

// Cleanup
stateModule.getVectorIndexPath = origGetVectorIndexPath;
try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

// Save results
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(RESULTS_DIR, 'bench-1c-bm25-retrieval.json'),
  JSON.stringify(summary, null, 2),
);
console.log(`  Results saved to: test/bench-results/bench-1c-bm25-retrieval.json`);

process.exit(passed ? 0 : 1);
