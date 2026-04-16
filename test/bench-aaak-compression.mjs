/**
 * Tier 1A: AAAK Compression Benchmark
 *
 * Measures compression ratio, token reduction, and entity preservation.
 * Run: node test/bench-aaak-compression.mjs
 */

import { createRequire } from 'module';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const FIXTURES = path.resolve(__dirname, 'bench-fixtures');
const RESULTS_DIR = path.resolve(__dirname, 'bench-results');

const { Dialect } = require(path.join(DIST, 'memory', 'aaak-dialect.js'));

// ── Load fixtures ──────────────────────────────────────────────

const samples = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sample-conversations.json'), 'utf-8'));

// ── Metrics ────────────────────────────────────────────────────

const results = {
  tier: '1A',
  name: 'AAAK Compression',
  samples: [],
  summary: {},
};

const dialect = new Dialect();
let totalOrigChars = 0;
let totalCompChars = 0;
let totalOrigTokens = 0;
let totalCompTokens = 0;
let entitiesPreserved = 0;
let entitiesTotal = 0;
let topicsPreserved = 0;
let topicsTotal = 0;
let emotionsPreserved = 0;
let emotionsTotal = 0;

for (const sample of samples) {
  const compressed = dialect.compress(sample.text);
  const stats = dialect.compressionStats(sample.text, compressed);

  totalOrigChars += stats.originalChars;
  totalCompChars += stats.compressedChars;
  totalOrigTokens += Dialect.countTokens(sample.text);
  totalCompTokens += Dialect.countTokens(compressed);

  // Check entity preservation
  const detectedEntities = dialect.detectEntitiesInText(sample.text);
  for (const expected of (sample.expectedEntities || [])) {
    entitiesTotal++;
    // Check if entity was detected (either full name or 3-char code)
    const code = expected.slice(0, 3).toUpperCase();
    if (detectedEntities.some(e => e === code || e.toLowerCase() === expected.toLowerCase())) {
      entitiesPreserved++;
    }
  }

  // Check topic preservation
  const detectedTopics = dialect.extractTopics(sample.text);
  for (const expected of (sample.expectedTopics || [])) {
    topicsTotal++;
    if (detectedTopics.some(t => t.includes(expected) || expected.includes(t))) {
      topicsPreserved++;
    }
  }

  // Check emotion preservation
  const detectedEmotions = dialect.detectEmotions(sample.text);
  for (const expected of (sample.expectedEmotions || [])) {
    emotionsTotal++;
    if (detectedEmotions.includes(expected)) {
      emotionsPreserved++;
    }
  }

  results.samples.push({
    id: sample.id,
    originalChars: stats.originalChars,
    compressedChars: stats.compressedChars,
    ratio: stats.ratio,
    compressionPct: ((1 - stats.compressedChars / stats.originalChars) * 100).toFixed(1),
    entitiesExpected: sample.expectedEntities?.length || 0,
    entitiesDetected: detectedEntities.length,
    topicsExpected: sample.expectedTopics?.length || 0,
    topicsDetected: detectedTopics.length,
    compressed: compressed.slice(0, 200),
  });
}

// ── Summary ────────────────────────────────────────────────────

const avgCompressionPct = ((1 - totalCompChars / totalOrigChars) * 100);
const avgRatio = totalOrigTokens / Math.max(totalCompTokens, 1);
const entityPrecision = entitiesTotal > 0 ? (entitiesPreserved / entitiesTotal * 100) : 100;
const topicPrecision = topicsTotal > 0 ? (topicsPreserved / topicsTotal * 100) : 100;
const emotionPrecision = emotionsTotal > 0 ? (emotionsPreserved / emotionsTotal * 100) : 100;

results.summary = {
  totalSamples: samples.length,
  avgCompressionPct: avgCompressionPct.toFixed(1),
  avgTokenRatio: avgRatio.toFixed(1),
  totalOrigTokens,
  totalCompTokens,
  tokenReduction: ((1 - totalCompTokens / totalOrigTokens) * 100).toFixed(1),
  entityPreservation: `${entitiesPreserved}/${entitiesTotal} (${entityPrecision.toFixed(0)}%)`,
  topicPreservation: `${topicsPreserved}/${topicsTotal} (${topicPrecision.toFixed(0)}%)`,
  emotionPreservation: `${emotionsPreserved}/${emotionsTotal} (${emotionPrecision.toFixed(0)}%)`,
};

// Pass criteria
const passed = avgCompressionPct >= 60 && entityPrecision >= 50;

// ── Output ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('  Tier 1A: AAAK Compression Benchmark');
console.log('='.repeat(60));
console.log(`  Samples:              ${samples.length}`);
console.log(`  Avg Compression:      ${avgCompressionPct.toFixed(1)}%`);
console.log(`  Token Ratio:          ${avgRatio.toFixed(1)}x`);
console.log(`  Token Reduction:      ${results.summary.tokenReduction}%`);
console.log(`  Entity Preservation:  ${results.summary.entityPreservation}`);
console.log(`  Topic Preservation:   ${results.summary.topicPreservation}`);
console.log(`  Emotion Preservation: ${results.summary.emotionPreservation}`);
console.log('-'.repeat(60));
console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
console.log('='.repeat(60) + '\n');

// Per-sample details
for (const s of results.samples) {
  console.log(`  ${s.id}: ${s.compressionPct}% compression (${s.originalChars} -> ${s.compressedChars} chars)`);
}

// Save results
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(RESULTS_DIR, 'bench-1a-aaak-compression.json'),
  JSON.stringify(results, null, 2),
);
console.log(`\n  Results saved to: test/bench-results/bench-1a-aaak-compression.json`);

// Exit code
process.exit(passed ? 0 : 1);
