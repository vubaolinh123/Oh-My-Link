/**
 * Tier 3: A/B Comparison Benchmark
 *
 * 3A: Context Size Comparison (Memory ON vs OFF)
 * 3B: Memory Retention Test (5-session simulation)
 *
 * Run: node test/bench-ab-comparison.mjs
 */

import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const RESULTS_DIR = path.resolve(__dirname, 'bench-results');

const { extractMemories } = require(path.join(DIST, 'memory', 'memory-extractor.js'));
const { Dialect } = require(path.join(DIST, 'memory', 'aaak-dialect.js'));
const vectorStore = require(path.join(DIST, 'memory', 'vector-store.js'));
const memoryStack = require(path.join(DIST, 'memory', 'memory-stack.js'));
const stateModule = require(path.join(DIST, 'state.js'));

// ── Setup ──────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oml-bench-ab-'));
const omlDir = path.join(tmpDir, '.oh-my-link');
fs.mkdirSync(omlDir, { recursive: true });

// Patch state paths
const origVectorPath = stateModule.getVectorIndexPath;
const origIdentityPath = stateModule.getIdentityPath;
const origWmPath = stateModule.getWorkingMemoryPath;

stateModule.getVectorIndexPath = () => path.join(omlDir, 'vector-index.json');
stateModule.getIdentityPath = () => path.join(omlDir, 'identity.md');
stateModule.getWorkingMemoryPath = () => path.join(omlDir, 'working-memory.md');

const results = { tier: '3', name: 'A/B Comparison', tests: {} };
let allPassed = true;

// ══════════════════════════════════════════════════════════════
// Simulated Sessions — 5 sessions with distinct content
// ══════════════════════════════════════════════════════════════

const sessions = [
  {
    id: 'session-1',
    label: 'Architecture Decisions',
    content: `We decided to use a modular monolith architecture instead of microservices.
The reason is our team of 5 developers cannot maintain 12 separate services.
We chose PostgreSQL as the primary database because we need ACID transactions
for the payment flow. The API layer uses Express with TypeScript.
The approach is to separate domains using modules within a single deployable unit.
Because this gives us code isolation without network overhead between services.`,
    keyFacts: ['modular monolith', 'postgresql', 'express', 'typescript', 'payment'],
  },
  {
    id: 'session-2',
    label: 'Coding Preferences',
    content: `I prefer functional programming patterns over OOP. Always use immutable data
structures. Never mutate function arguments. My convention is to use const for
everything unless reassignment is genuinely needed. I hate when code has side
effects hidden inside utility functions. Please always write pure functions
where possible. I like to keep files under 200 lines.`,
    keyFacts: ['functional programming', 'immutable', 'const', 'pure functions', '200 lines'],
  },
  {
    id: 'session-3',
    label: 'Bug Fix',
    content: `Found a critical bug in the order processing pipeline. The problem was that
concurrent orders for the same product could both pass the inventory check,
leading to overselling. Root cause: the inventory check and decrement were
not atomic. The fix was to use PostgreSQL advisory locks. The bug affected
approximately 2% of orders during peak hours. Fixed by using SELECT FOR UPDATE
in the inventory check query.`,
    keyFacts: ['concurrent orders', 'overselling', 'advisory locks', 'select for update', 'inventory'],
  },
  {
    id: 'session-4',
    label: 'Milestone',
    content: `Shipped version 3.0 of the platform today! Key achievements:
- Search performance improved by 10x using Elasticsearch
- Built a real-time notification system with WebSocket
- Deployed to Kubernetes with zero-downtime rolling updates
- First release with 100% test coverage on critical paths
The breakthrough was implementing event sourcing for the order lifecycle.`,
    keyFacts: ['version 3.0', 'elasticsearch', 'websocket', 'kubernetes', 'event sourcing'],
  },
  {
    id: 'session-5',
    label: 'Query Session',
    content: `Starting a new task. Need to review the current state of the project.`,
    keyFacts: [],
  },
];

// ══════════════════════════════════════════════════════════════
// 3A: Context Size Comparison
// ══════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(60));
console.log('  Tier 3A: Context Size Comparison');
console.log('='.repeat(60));

// Measure WITHOUT memory (baseline)
const baselineContext = '[No memory system active]';
const baselineTokens = Dialect.countTokens(baselineContext);

// Set up identity
fs.writeFileSync(stateModule.getIdentityPath(tmpDir),
  '# Identity\nProject: BenchTest\nStack: Node.js + TypeScript + PostgreSQL\n',
  'utf-8',
);

// Simulate sessions 1-4: extract and store memories
const dialect = new Dialect();
for (const session of sessions.slice(0, 4)) {
  const memories = extractMemories(session.content, 0.3);
  for (const mem of memories.slice(0, 5)) {
    const compressed = dialect.compress(mem.content, {
      room: mem.memory_type,
      date: `2026-04-0${sessions.indexOf(session) + 1}`,
    });
    vectorStore.addDocument(tmpDir, compressed, {
      raw: mem.content.slice(0, 500),
      room: mem.memory_type,
      source: `session-${sessions.indexOf(session) + 1}`,
      importance: mem.confidence >= 0.7 ? 4 : 3,
      timestamp: new Date().toISOString(),
    });
  }
}

// Measure WITH memory
const memoryContext = memoryStack.wakeUp(tmpDir) || '';
const memoryTokens = Dialect.countTokens(memoryContext);

// Pre-tool memory fetch simulation
const preToolContext = vectorStore.searchDocuments(tmpDir, 'order processing payment', 3)
  .map(r => r.document.text).join(' | ').slice(0, 300);
const preToolTokens = Dialect.countTokens(preToolContext);

const totalMemoryTokens = memoryTokens + preToolTokens;
const contextPassed = totalMemoryTokens < 4000;

// Calculate compression ratio of stored memories
const allDocs = vectorStore.getAllDocuments(tmpDir);
const totalRawChars = allDocs.reduce((sum, d) => sum + (d.metadata.raw?.length || 0), 0);
const totalCompChars = allDocs.reduce((sum, d) => sum + d.text.length, 0);
const storageRatio = totalRawChars > 0 ? ((1 - totalCompChars / totalRawChars) * 100) : 0;

results.tests['3A'] = {
  name: 'Context Size Comparison',
  baseline: {
    tokens: baselineTokens,
    context: 'No memory',
  },
  withMemory: {
    wakeUpTokens: memoryTokens,
    preToolTokens: preToolTokens,
    totalTokens: totalMemoryTokens,
    wakeUpChars: memoryContext.length,
  },
  documentsStored: allDocs.length,
  storageCompressionPct: storageRatio.toFixed(1) + '%',
  withinBudget: contextPassed,
  passed: contextPassed,
};

console.log(`  Baseline (no memory): ${baselineTokens} tokens`);
console.log(`  With memory:`);
console.log(`    WakeUp context:   ${memoryTokens} tokens (${memoryContext.length} chars)`);
console.log(`    Pre-tool fetch:   ${preToolTokens} tokens`);
console.log(`    Total injection:  ${totalMemoryTokens} tokens`);
console.log(`  Documents stored:   ${allDocs.length}`);
console.log(`  Storage compression: ${storageRatio.toFixed(1)}%`);
console.log(`  Within budget (<4000): ${contextPassed}`);
console.log(`  Result: ${contextPassed ? 'PASS' : 'FAIL'}`);
if (!contextPassed) allPassed = false;

// ══════════════════════════════════════════════════════════════
// 3B: Memory Retention Test
// ══════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(60));
console.log('  Tier 3B: Memory Retention Test');
console.log('='.repeat(60));

// From session 5, try to retrieve key facts from sessions 1-4
const retentionQueries = [
  { query: 'What architecture did we choose?', expectedKeywords: ['monolith', 'modular'], session: 1 },
  { query: 'What database are we using?', expectedKeywords: ['postgresql', 'postgres'], session: 1 },
  { query: 'What coding style does the user prefer?', expectedKeywords: ['functional', 'immutable'], session: 2 },
  { query: 'What was the critical bug?', expectedKeywords: ['concurrent', 'overselling', 'inventory'], session: 3 },
  { query: 'How was the inventory bug fixed?', expectedKeywords: ['advisory', 'lock', 'select'], session: 3 },
  { query: 'What version was shipped?', expectedKeywords: ['3.0', 'shipped', 'version'], session: 4 },
  { query: 'What search technology do we use?', expectedKeywords: ['elasticsearch'], session: 4 },
  { query: 'How is the app deployed?', expectedKeywords: ['kubernetes', 'rolling'], session: 4 },
  { query: 'What real-time system was built?', expectedKeywords: ['websocket', 'notification'], session: 4 },
  { query: 'What was the breakthrough in session 4?', expectedKeywords: ['event', 'sourcing'], session: 4 },
];

let retentionHits = 0;
const retentionDetails = [];

for (const rq of retentionQueries) {
  // Search vector store
  const searchResults = vectorStore.searchDocuments(tmpDir, rq.query, 5);
  const allText = searchResults.map(r => {
    const raw = r.document.metadata.raw || '';
    return (r.document.text + ' ' + raw).toLowerCase();
  }).join(' ');

  // Also check wakeUp context
  const wakeupText = (memoryContext || '').toLowerCase();
  const combinedText = allText + ' ' + wakeupText;

  const hit = rq.expectedKeywords.some(kw => combinedText.includes(kw.toLowerCase()));
  if (hit) retentionHits++;

  retentionDetails.push({
    query: rq.query,
    session: rq.session,
    hit,
    expectedKeywords: rq.expectedKeywords,
    topResult: searchResults[0] ? searchResults[0].document.text.slice(0, 100) : '(none)',
    score: searchResults[0] ? searchResults[0].score.toFixed(3) : 0,
  });
}

const retentionPct = retentionHits / retentionQueries.length * 100;
const retentionPassed = retentionPct >= 70;

results.tests['3B'] = {
  name: 'Memory Retention Test',
  totalQueries: retentionQueries.length,
  hits: retentionHits,
  retentionRate: retentionPct.toFixed(1) + '%',
  details: retentionDetails,
  passed: retentionPassed,
};

console.log(`  Queries:    ${retentionQueries.length}`);
console.log(`  Hits:       ${retentionHits}/${retentionQueries.length} (${retentionPct.toFixed(1)}%)`);
console.log('-'.repeat(60));

for (const d of retentionDetails) {
  const status = d.hit ? 'HIT ' : 'MISS';
  console.log(`  ${status} S${d.session}: "${d.query}"`);
  if (!d.hit) {
    console.log(`       Expected: [${d.expectedKeywords.join(', ')}]`);
    console.log(`       Top result: ${d.topResult}`);
  }
}

console.log('-'.repeat(60));
console.log(`  Result: ${retentionPassed ? 'PASS' : 'FAIL'}`);
if (!retentionPassed) allPassed = false;

// ── Final Summary ──────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('  Tier 3 Summary');
console.log('='.repeat(60));
for (const [key, test] of Object.entries(results.tests)) {
  console.log(`  ${key} ${test.name.padEnd(35)} ${test.passed ? 'PASS' : 'FAIL'}`);
}
console.log('-'.repeat(60));
console.log(`  Overall: ${allPassed ? 'PASS' : 'FAIL'}`);
console.log('='.repeat(60) + '\n');

// Cleanup
stateModule.getVectorIndexPath = origVectorPath;
stateModule.getIdentityPath = origIdentityPath;
stateModule.getWorkingMemoryPath = origWmPath;
try { fs.rmSync(tmpDir, { recursive: true }); } catch {}

// Save results
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(RESULTS_DIR, 'bench-3-ab-comparison.json'),
  JSON.stringify(results, null, 2),
);
console.log(`  Results saved to: test/bench-results/bench-3-ab-comparison.json`);

process.exit(allPassed ? 0 : 1);
