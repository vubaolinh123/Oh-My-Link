/**
 * Oh-My-Link Memory Benchmark Runner
 *
 * Runs all benchmark tiers and produces a summary report.
 *
 * Usage:
 *   node test/run-benchmarks.mjs           # Run all tiers
 *   node test/run-benchmarks.mjs --tier 1  # Run Tier 1 only
 *   node test/run-benchmarks.mjs --tier 2  # Run Tier 2 only
 *   node test/run-benchmarks.mjs --tier 3  # Run Tier 3 only
 */

import { execSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tierArg = process.argv.find(a => a === '--tier');
const tierNum = tierArg ? process.argv[process.argv.indexOf(tierArg) + 1] : null;

const benchmarks = [
  { tier: '1', id: '1A', name: 'AAAK Compression',       file: 'bench-aaak-compression.mjs' },
  { tier: '1', id: '1B', name: 'Extraction Quality',     file: 'bench-extraction-quality.mjs' },
  { tier: '1', id: '1C', name: 'BM25 Retrieval',         file: 'bench-bm25-retrieval.mjs' },
  { tier: '2', id: '2',  name: 'Pipeline Integration',   file: 'bench-pipeline.mjs' },
  { tier: '3', id: '3',  name: 'A/B Comparison',         file: 'bench-ab-comparison.mjs' },
  { tier: '4', id: '4',  name: 'MemPalace Comparison',  file: 'bench-mempalace-comparison.mjs' },
];

const filtered = tierNum
  ? benchmarks.filter(b => b.tier === tierNum)
  : benchmarks;

if (filtered.length === 0) {
  console.log(`No benchmarks found for tier ${tierNum}`);
  process.exit(1);
}

console.log('\n' + '═'.repeat(60));
console.log('  Oh-My-Link Memory System Benchmarks');
console.log('═'.repeat(60));
console.log(`  Running: ${filtered.length} benchmark(s)\n`);

const results = [];
let allPassed = true;

for (const bench of filtered) {
  const benchPath = path.join(__dirname, bench.file);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Running ${bench.id}: ${bench.name}`);
  console.log('─'.repeat(60));

  try {
    execSync(`node "${benchPath}"`, {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
      timeout: 60000,
    });
    results.push({ ...bench, status: 'PASS' });
  } catch (err) {
    results.push({ ...bench, status: 'FAIL' });
    allPassed = false;
  }
}

// ── Final Report ───────────────────────────────────────────────

console.log('\n\n' + '═'.repeat(60));
console.log('  BENCHMARK SUMMARY');
console.log('═'.repeat(60));

for (const r of results) {
  const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
  console.log(`  Tier ${r.id.padEnd(4)} ${r.name.padEnd(30)} ${icon}`);
}

console.log('─'.repeat(60));
console.log(`  Overall: ${allPassed ? 'ALL PASS' : 'SOME FAILED'}`);
console.log('═'.repeat(60) + '\n');

process.exit(allPassed ? 0 : 1);
