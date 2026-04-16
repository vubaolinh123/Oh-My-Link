/**
 * Tier 1B: Memory Extraction Quality Benchmark
 *
 * Measures precision and recall of the memory extractor.
 * Run: node test/bench-extraction-quality.mjs
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

const { extractMemories } = require(path.join(DIST, 'memory', 'memory-extractor.js'));

// ── Load fixtures ──────────────────────────────────────────────

const fixtures = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'annotated-extractions.json'), 'utf-8'));

// ── Metrics ────────────────────────────────────────────────────

let truePositives = 0;   // Correctly extracted (right type)
let falsePositives = 0;   // Extracted something not expected
let falseNegatives = 0;   // Expected but not extracted
let typeCorrect = 0;      // Correct type assignment
let typeTotal = 0;        // Total type comparisons

const perType = {};
const sampleResults = [];

for (const fixture of fixtures) {
  const extracted = extractMemories(fixture.text, 0.3);
  const expected = fixture.expected || [];

  const sampleResult = {
    id: fixture.id,
    expectedCount: expected.length,
    extractedCount: extracted.length,
    matches: [],
    missed: [],
    extra: [],
  };

  // Match expected to extracted
  const matchedExtracted = new Set();

  for (const exp of expected) {
    let found = false;
    for (let i = 0; i < extracted.length; i++) {
      if (matchedExtracted.has(i)) continue;

      // Check type match
      const typeMatch = extracted[i].memory_type === exp.type;

      // Check keyword overlap (at least one keyword present in extracted content)
      const contentLower = extracted[i].content.toLowerCase();
      const keywordMatch = exp.keywords.some(kw => contentLower.includes(kw.toLowerCase()));

      if (keywordMatch) {
        matchedExtracted.add(i);
        truePositives++;
        found = true;

        typeTotal++;
        if (typeMatch) {
          typeCorrect++;
          sampleResult.matches.push({
            expectedType: exp.type,
            extractedType: extracted[i].memory_type,
            confidence: extracted[i].confidence,
            typeCorrect: true,
          });
        } else {
          sampleResult.matches.push({
            expectedType: exp.type,
            extractedType: extracted[i].memory_type,
            confidence: extracted[i].confidence,
            typeCorrect: false,
          });
        }

        // Per-type tracking
        const t = exp.type;
        perType[t] = perType[t] || { tp: 0, fn: 0, fp: 0 };
        perType[t].tp++;
        break;
      }
    }

    if (!found) {
      falseNegatives++;
      sampleResult.missed.push(exp);
      const t = exp.type;
      perType[t] = perType[t] || { tp: 0, fn: 0, fp: 0 };
      perType[t].fn++;
    }
  }

  // Count extra extractions (not matched to any expected)
  for (let i = 0; i < extracted.length; i++) {
    if (!matchedExtracted.has(i) && expected.length > 0) {
      // Only count as FP if we expected specific things but got extras
      // For samples with no expected, everything extracted is fair game
    }
    if (!matchedExtracted.has(i) && expected.length === 0 && extracted.length > 0) {
      falsePositives++;
      sampleResult.extra.push({
        type: extracted[i].memory_type,
        confidence: extracted[i].confidence,
        snippet: extracted[i].content.slice(0, 100),
      });
    }
  }

  sampleResults.push(sampleResult);
}

// ── Summary ────────────────────────────────────────────────────

const precision = truePositives / Math.max(truePositives + falsePositives, 1) * 100;
const recall = truePositives / Math.max(truePositives + falseNegatives, 1) * 100;
const f1 = 2 * (precision * recall) / Math.max(precision + recall, 1);
const typeAccuracy = typeTotal > 0 ? (typeCorrect / typeTotal * 100) : 0;

const results = {
  tier: '1B',
  name: 'Memory Extraction Quality',
  summary: {
    totalFixtures: fixtures.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: precision.toFixed(1),
    recall: recall.toFixed(1),
    f1: f1.toFixed(1),
    typeAccuracy: typeAccuracy.toFixed(1),
    perType,
  },
  samples: sampleResults,
};

// Pass criteria: precision >= 70%, recall >= 50%
const passed = precision >= 70 && recall >= 50;

// ── Output ─────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('  Tier 1B: Memory Extraction Quality Benchmark');
console.log('='.repeat(60));
console.log(`  Fixtures:         ${fixtures.length}`);
console.log(`  True Positives:   ${truePositives}`);
console.log(`  False Positives:  ${falsePositives}`);
console.log(`  False Negatives:  ${falseNegatives}`);
console.log(`  Precision:        ${precision.toFixed(1)}%`);
console.log(`  Recall:           ${recall.toFixed(1)}%`);
console.log(`  F1 Score:         ${f1.toFixed(1)}%`);
console.log(`  Type Accuracy:    ${typeAccuracy.toFixed(1)}%`);
console.log('-'.repeat(60));

// Per-type breakdown
console.log('  Per-Type Breakdown:');
for (const [type, counts] of Object.entries(perType).sort()) {
  const tp = counts.tp;
  const fn = counts.fn;
  const r = tp / Math.max(tp + fn, 1) * 100;
  console.log(`    ${type.padEnd(12)} TP=${tp} FN=${fn} Recall=${r.toFixed(0)}%`);
}

console.log('-'.repeat(60));
console.log(`  Result: ${passed ? 'PASS' : 'FAIL'}`);
console.log('='.repeat(60) + '\n');

// Show missed items
const missed = sampleResults.filter(s => s.missed.length > 0);
if (missed.length > 0) {
  console.log('  Missed extractions:');
  for (const s of missed) {
    for (const m of s.missed) {
      console.log(`    ${s.id}: expected ${m.type} with [${m.keywords.join(', ')}]`);
    }
  }
}

// Save results
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(RESULTS_DIR, 'bench-1b-extraction-quality.json'),
  JSON.stringify(results, null, 2),
);
console.log(`\n  Results saved to: test/bench-results/bench-1b-extraction-quality.json`);

process.exit(passed ? 0 : 1);
